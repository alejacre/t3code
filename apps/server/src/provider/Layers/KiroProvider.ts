import {
  type KiroSettings,
  type ModelCapabilities,
  type ServerProviderModel,
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
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

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

function modelsFromSettings(
  customModels: ReadonlyArray<string>,
  discoveredModels: ReadonlyArray<ServerProviderModel> = KIRO_FALLBACK_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discoveredModels, customModels, EMPTY_CAPABILITIES);
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
    const models = modelsFromSettings(settings.customModels);
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
  const fallbackModels = modelsFromSettings(settings.customModels);

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

  const [authResult, modelResult] = yield* Effect.all(
    [
      runKiroCommand(settings, ["whoami"], environment).pipe(
        Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
        Effect.result,
      ),
      runKiroCommand(settings, ["chat", "--list-models", "--format", "json"], environment).pipe(
        Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS),
        Effect.result,
      ),
    ],
    { concurrency: 2 },
  );

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
  const models =
    discoveredModels && discoveredModels.length > 0
      ? modelsFromSettings(settings.customModels, discoveredModels)
      : fallbackModels;
  const hasDiscoveredModels = discoveredModels !== null && discoveredModels.length > 0;

  return buildServerProvider({
    presentation: KIRO_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
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
} as const;
