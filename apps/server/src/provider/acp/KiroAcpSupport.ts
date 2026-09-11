import { type KiroSettings, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

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
