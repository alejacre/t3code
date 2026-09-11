import {
  type CustomModelSetting,
  type KiroSettings,
  type ModelCapabilities,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { KIRO_AGENT_OPTION_ID, KIRO_DEFAULT_AGENT_ID } from "../acp/KiroAcpSupport.ts";

const KIRO_PRESENTATION = {
  displayName: "Kiro",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const AUTH_PROBE_TIMEOUT_MS = 10_000;
const MODEL_PROBE_TIMEOUT_MS = 15_000;
const AGENT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Slash commands Kiro handles itself when they arrive as prompt text over ACP.
 * `/goal` starts Kiro's iterate-until-verified loop; the goal is the text
 * after the command, and `/goal clear` drops it. Kiro only announces these
 * through a proprietary `_kiro.dev/commands/available` notification once a
 * session is open, so they are declared here for the composer's menu.
 */
const KIRO_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  {
    name: "goal",
    description: "Set a goal with validation criteria; Kiro iterates until it is met",
    input: { hint: "<goal and how to verify it>" },
  },
  { name: "goal clear", description: "Clear the active goal" },
  COMPACT_SLASH_COMMAND,
];

export interface KiroAgent {
  readonly id: string;
  readonly description?: string;
  /** `Built-in`, `Global` or `Workspace`, as `kiro-cli agent list` prints it. */
  readonly scope: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
const AGENT_ROW =
  /^(\*|\s)\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}(\(Built-in\)|Global|Workspace|Local)(?:\s{2,}(.*))?$/;

/**
 * Parses the table `kiro-cli agent list` prints: one row per agent with the
 * current one marked `*`, columns separated by runs of spaces, and long
 * descriptions wrapped onto deeply indented continuation lines. The two
 * header lines (`Workspace: …`, `Global: …`) never match the row shape.
 */
export function parseKiroAgentList(output: string): ReadonlyArray<KiroAgent> {
  const agents: Array<{ id: string; description: string; scope: string }> = [];
  for (const rawLine of output.replace(ANSI_ESCAPE, "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") continue;
    const row = AGENT_ROW.exec(line);
    if (row) {
      const scope = row[3]!.replace(/^\(|\)$/g, "");
      agents.push({ id: row[2]!, scope, description: row[4]?.trim() ?? "" });
      continue;
    }
    // A continuation line belongs to the previous agent's description.
    const previous = agents.at(-1);
    if (previous && /^\s{8,}\S/.test(line)) {
      previous.description = `${previous.description} ${line.trim()}`.trim();
    }
  }
  const seen = new Set<string>();
  return agents.flatMap((agent) => {
    if (seen.has(agent.id)) return [];
    seen.add(agent.id);
    // The AIM manager stamps every agent with the same warning; it is noise in
    // a picker where each entry gets a line or two.
    const description = agent.description
      .replace(/\s*--\s*⚠️?\s*This agent is managed by AIM\. DO NOT EDIT MANUALLY\.?$/i, "")
      .trim();
    return [
      {
        id: agent.id,
        scope: agent.scope,
        ...(description.length > 0 ? { description } : {}),
      } satisfies KiroAgent,
    ];
  });
}

/**
 * The `agent` model option the composer renders as a trait. Every Kiro model
 * carries the same list. The settings-wide default agent is the option's
 * default; without one, Kiro's own built-in default is.
 */
export function buildKiroAgentDescriptor(
  agents: ReadonlyArray<KiroAgent>,
  settingsDefaultAgent: string,
) {
  const defaultAgent = settingsDefaultAgent.trim() || KIRO_DEFAULT_AGENT_ID;
  const listed = agents.some((agent) => agent.id === KIRO_DEFAULT_AGENT_ID)
    ? agents
    : [{ id: KIRO_DEFAULT_AGENT_ID, scope: "Built-in", description: "Default agent" }, ...agents];
  const withDefault = listed.some((agent) => agent.id === defaultAgent)
    ? listed
    : [...listed, { id: defaultAgent, scope: "Settings" }];
  return buildSelectOptionDescriptor({
    id: KIRO_AGENT_OPTION_ID,
    label: "Agent",
    description: "Kiro agent (tools, MCP servers and steering) used for this thread.",
    options: withDefault.map((agent) => ({
      value: agent.id,
      label: agent.id === KIRO_DEFAULT_AGENT_ID ? "Default" : agent.id,
      ...(agent.description ? { description: agent.description } : {}),
      ...(agent.id === defaultAgent ? { isDefault: true } : {}),
    })),
  });
}

function kiroModelCapabilities(
  agents: ReadonlyArray<KiroAgent> | null,
  settings: KiroSettings,
): ModelCapabilities {
  // With no agent list there is still the built-in default and whatever the
  // settings name, so the picker always has something to show.
  return createModelCapabilities({
    optionDescriptors: [buildKiroAgentDescriptor(agents ?? [], settings.agent)],
  });
}

const KIRO_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const KiroModelListResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      model_name: Schema.String,
      model_id: Schema.String,
      description: Schema.optional(Schema.String),
    }),
  ),
  default_model: Schema.optional(Schema.String),
});
const decodeKiroModelList = Schema.decodeUnknownExit(Schema.fromJsonString(KiroModelListResponse));

/**
 * Discovered models get the shared Kiro capabilities (the agent option);
 * custom models without their own capabilities get them as the default too,
 * so a hand-added slug still shows the agent picker.
 */
function modelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  capabilities: ModelCapabilities,
  discoveredModels: ReadonlyArray<ServerProviderModel> = KIRO_FALLBACK_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    discoveredModels.map((model) => ({ ...model, capabilities })),
    customModels ?? [],
    capabilities,
  );
}

function parseKiroModels(output: string): ReadonlyArray<ServerProviderModel> | null {
  const decoded = decodeKiroModelList(output);
  if (decoded._tag === "Failure") {
    return null;
  }
  const defaultModel = decoded.value.default_model?.trim();
  const seen = new Set<string>();
  return decoded.value.models.flatMap((entry) => {
    const slug = entry.model_id.trim();
    if (slug.length === 0 || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    const name = entry.model_name.trim() || slug;
    return [
      {
        slug,
        name: name === "auto" ? "Auto" : name,
        isCustom: false,
        ...(defaultModel === slug ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      } satisfies ServerProviderModel,
    ];
  });
}

function runKiroCommand(
  settings: KiroSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  return Effect.gen(function* () {
    const command = settings.binaryPath || "kiro-cli";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });
}

export function buildInitialKiroProviderSnapshot(
  settings: KiroSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = modelsFromSettings(settings.customModels, kiroModelCapabilities(null, settings));
    if (!settings.enabled) {
      return buildServerProvider({
        presentation: KIRO_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kiro is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      slashCommands: KIRO_SLASH_COMMANDS,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kiro CLI availability...",
      },
    });
  });
}

export const checkKiroProviderStatus = Effect.fn("checkKiroProviderStatus")(function* (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSettings(
    settings.customModels,
    kiroModelCapabilities(null, settings),
  );

  if (!settings.enabled) {
    return yield* buildInitialKiroProviderSnapshot(settings);
  }

  const versionResult = yield* runKiroCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      slashCommands: KIRO_SLASH_COMMANDS,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Kiro CLI (`kiro-cli`) is not installed or not on PATH."
          : "Failed to execute Kiro CLI.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      slashCommands: KIRO_SLASH_COMMANDS,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kiro CLI timed out while checking its version.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: KIRO_PRESENTATION,
      enabled: true,
      checkedAt,
      slashCommands: KIRO_SLASH_COMMANDS,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kiro CLI is installed but failed to run.",
      },
    });
  }

  const [authResult, modelResult, agentResult] = yield* Effect.all(
    [
      runKiroCommand(settings, ["whoami"], environment).pipe(
        Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
        Effect.result,
      ),
      runKiroCommand(settings, ["chat", "--list-models", "--format", "json"], environment).pipe(
        Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS),
        Effect.result,
      ),
      // Agents surface as the `agent` model option. Global agents are what
      // matter here; `agent list` only sees workspace ones from their own
      // directory, and the server does not run there.
      runKiroCommand(settings, ["agent", "list"], environment).pipe(
        Effect.timeoutOption(AGENT_PROBE_TIMEOUT_MS),
        Effect.result,
      ),
    ],
    { concurrency: 3 },
  );
  const discoveredAgents =
    Result.isSuccess(agentResult) &&
    Option.isSome(agentResult.success) &&
    agentResult.success.value.code === 0
      ? // The CLI prints this table to stderr, keeping stdout for machine output.
        parseKiroAgentList(
          `${agentResult.success.value.stdout}\n${agentResult.success.value.stderr}`,
        )
      : null;
  const capabilities = kiroModelCapabilities(discoveredAgents, settings);

  const authenticated =
    Result.isSuccess(authResult) &&
    Option.isSome(authResult.success) &&
    authResult.success.value.code === 0;
  const discoveredModels =
    Result.isSuccess(modelResult) &&
    Option.isSome(modelResult.success) &&
    modelResult.success.value.code === 0
      ? parseKiroModels(modelResult.success.value.stdout)
      : null;
  const models = modelsFromSettings(
    settings.customModels,
    capabilities,
    discoveredModels && discoveredModels.length > 0 ? discoveredModels : KIRO_FALLBACK_MODELS,
  );
  const hasDiscoveredModels = discoveredModels !== null && discoveredModels.length > 0;

  return buildServerProvider({
    presentation: KIRO_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: KIRO_SLASH_COMMANDS,
    probe: {
      installed: true,
      version,
      status: authenticated && hasDiscoveredModels ? "ready" : "warning",
      auth: authenticated
        ? { status: "authenticated", type: "Kiro" }
        : { status: "unauthenticated" },
      ...(!authenticated
        ? { message: "Complete Kiro sign-in in a terminal, then refresh provider status." }
        : !hasDiscoveredModels
          ? { message: "Kiro is authenticated, but its model catalog is unavailable or empty." }
          : {}),
    },
  });
});

export const KIRO_PROVIDER_TESTING = {
  parseKiroModels,
  parseKiroAgentList,
  buildKiroAgentDescriptor,
  KIRO_SLASH_COMMANDS,
} as const;
