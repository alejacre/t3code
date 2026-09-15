import { type KiroSettings, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { AcpConversationRewind } from "../Layers/GrokAdapter.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");

type KiroAcpRuntimeSettings = Pick<KiroSettings, "agent" | "agentEngine" | "binaryPath">;

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeSettings;
  readonly environment?: NodeJS.ProcessEnv;
  /** Agent chosen for this thread; overrides the settings-wide default. */
  readonly sessionMode?: string;
}

/**
 * Kiro exposes its agents as ACP session modes. The composer picks one per
 * thread through the `agent` model option; that beats the settings default,
 * which in turn beats Kiro's own default (`kiro_default`, sent as no flag).
 */
export const KIRO_DEFAULT_AGENT_ID = "kiro_default";

/**
 * Id of the model option that carries the chosen agent. `agent` is the id the
 * composer's traits picker already knows how to label, from OpenCode.
 */
export const KIRO_AGENT_OPTION_ID = "agent";

export function resolveKiroAgent(
  kiroSettings: Pick<KiroSettings, "agent">,
  requestedAgent: string | undefined,
): string {
  const requested = requestedAgent?.trim() ?? "";
  if (requested.length > 0) return requested;
  const fromSettings = kiroSettings.agent.trim();
  return fromSettings.length > 0 ? fromSettings : KIRO_DEFAULT_AGENT_ID;
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  requestedAgent?: string,
): AcpSessionRuntime.AcpSpawnInput {
  const requestedAgentEngine = kiroSettings.agentEngine.trim();
  const agentEngine = ["v1", "v2", "v3"].includes(requestedAgentEngine)
    ? requestedAgentEngine
    : "v2";
  const resolvedAgent = resolveKiroAgent(kiroSettings, requestedAgent);
  // The built-in default is what Kiro starts with anyway; passing it
  // explicitly would only break on CLIs that do not list it by that name.
  const agent = resolvedAgent === KIRO_DEFAULT_AGENT_ID ? "" : resolvedAgent;
  return {
    command: kiroSettings.binaryPath || "kiro-cli",
    args: ["acp", "--agent-engine", agentEngine, ...(agent.length > 0 ? ["--agent", agent] : [])],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        // Stop must await Kiro's terminal prompt response. Interrupting the
        // local RPC alone leaves the agent working and corrupts the next turn.
        cancelBehavior: "wait-for-prompt",
        spawn: buildKiroAcpSpawnInput(
          input.kiroSettings,
          input.cwd,
          input.environment,
          input.sessionMode,
        ),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveKiroAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "auto";
  return normalizeModelSlug(base, KIRO_DRIVER_KIND) ?? "auto";
}

/**
 * Kiro persists every ACP session as `~/.kiro/sessions/cli/<id>.jsonl`, one
 * JSON entry per line: `Prompt`, `AssistantMessage`, `ToolResults`, ...
 */
export function kiroSessionHistoryPath(homeDir: string, sessionId: string): string {
  return `${homeDir}/.kiro/sessions/cli/${sessionId}.jsonl`;
}

/** Zero-based line indices of the `Prompt` entries in a Kiro history file. */
export function kiroPromptEntryIndices(history: string): Array<number> {
  const indices: Array<number> = [];
  history.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line) as { kind?: unknown };
      if (entry.kind === "Prompt") indices.push(index);
    } catch {
      // Not our line to interpret.
    }
  });
  return indices;
}

/**
 * Kiro's `/rewind <entry>` forks the session keeping the history through the
 * turn that starts at `<entry>` (a `Prompt` line index), so dropping the last
 * `promptsToDrop` prompts means rewinding to the prompt just before them.
 * Probed on kiro-cli 2.21.4: `/rewind 0` on a two-turn session keeps turn
 * one only; a non-prompt index is rejected with "not a user prompt".
 */
export function planKiroRewind(
  history: string,
  promptsToDrop: number,
): { readonly _tag: "fresh" } | { readonly _tag: "command"; readonly command: string } {
  const prompts = kiroPromptEntryIndices(history);
  const keep = prompts.length - promptsToDrop;
  if (keep <= 0) return { _tag: "fresh" };
  return { _tag: "command", command: `/rewind ${prompts[keep - 1]}` };
}

const KIRO_REWOUND_SESSION_PATTERN =
  /new session\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Parses "Rewound to earlier turn (new session <uuid>)". */
export function parseKiroRewoundSessionId(replyText: string): string | undefined {
  return KIRO_REWOUND_SESSION_PATTERN.exec(replyText)?.[1]?.toLowerCase();
}

/**
 * Conversation rewind for the Kiro ACP adapter: reads the session history to
 * find the prompt to rewind to and lets the adapter run Kiro's `/rewind`.
 */
export function makeKiroConversationRewind(input: {
  readonly homeDir: string;
  readonly fileSystem: FileSystem.FileSystem;
}): AcpConversationRewind {
  return {
    plan: ({ acpSessionId, promptsToDrop }) =>
      input.fileSystem.readFileString(kiroSessionHistoryPath(input.homeDir, acpSessionId)).pipe(
        Effect.map((history) => planKiroRewind(history, promptsToDrop)),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: KIRO_DRIVER_KIND,
              method: "thread/rollback",
              detail: `Could not read the Kiro session history for '${acpSessionId}': ${cause.message}`,
              cause,
            }),
        ),
      ),
    parseSessionId: parseKiroRewoundSessionId,
  };
}
