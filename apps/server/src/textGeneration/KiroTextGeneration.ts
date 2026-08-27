import { type GrokSettings, type KiroSettings } from "@t3tools/contracts";

import { makeKiroAcpRuntime, resolveKiroAcpBaseModelId } from "../provider/acp/KiroAcpSupport.ts";
import { makeGrokTextGeneration } from "./GrokTextGeneration.ts";

/**
 * Kiro text generation rides the shared Grok ACP text-generation flow with a
 * Kiro runtime underneath; only the shared settings fields are forwarded.
 */
export function makeKiroTextGeneration(
  kiroSettings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const compatibleSettings: GrokSettings = {
    enabled: kiroSettings.enabled,
    binaryPath: kiroSettings.binaryPath,
    customModels: kiroSettings.customModels,
  };
  return makeGrokTextGeneration(compatibleSettings, environment, {
    providerLabel: "Kiro",
    resolveModelId: resolveKiroAcpBaseModelId,
    makeRuntime: ({ grokSettings: _grokSettings, ...input }) =>
      makeKiroAcpRuntime({
        ...input,
        kiroSettings,
      }),
  });
}
