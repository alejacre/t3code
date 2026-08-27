import {
  type GrokSettings,
  type KiroSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { makeKiroAcpRuntime, resolveKiroAcpBaseModelId } from "../acp/KiroAcpSupport.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";

export interface KiroAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

/**
 * Kiro rides the shared ACP adapter that Grok established: same session
 * lifecycle, turn settlement, and permission plumbing, with the Grok-only
 * extensions switched off. Kiro-specific spawn settings travel through
 * `makeRuntime`; the Grok-shaped settings below only carry the shared fields.
 */
export function makeKiroAdapter(kiroSettings: KiroSettings, options?: KiroAdapterLiveOptions) {
  const compatibleSettings: GrokSettings = {
    enabled: kiroSettings.enabled,
    binaryPath: kiroSettings.binaryPath,
    customModels: kiroSettings.customModels,
  };
  return makeGrokAdapter(compatibleSettings, {
    ...options,
    provider: ProviderDriverKind.make("kiro"),
    providerLabel: "Kiro",
    enableGrokExtensions: false,
    // Kiro has no per-mode spawn flags, so auto-accept-edits is enforced by
    // approving ACP `edit`/`delete`/`move` permission requests client-side.
    autoApproveEditPermissions: true,
    resolveModelId: resolveKiroAcpBaseModelId,
    makeRuntime: ({ grokSettings: _grokSettings, runtimeMode: _runtimeMode, ...input }) =>
      makeKiroAcpRuntime({
        ...input,
        kiroSettings,
      }),
  });
}
