import {
  type GrokSettings,
  KIRO_SEND_TURN_MAX_IMAGE_BYTES,
  type KiroSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  KIRO_AGENT_OPTION_ID,
  makeKiroAcpRuntime,
  makeKiroConversationRewind,
  resolveKiroAcpBaseModelId,
} from "../acp/KiroAcpSupport.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeGrokAdapter } from "./GrokAdapter.ts";

export interface KiroAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Home directory holding `.kiro/sessions`; defaults to the server user's. */
  readonly homeDir?: string;
}

export const makeKiroAdapter = Effect.fn("makeKiroAdapter")(function* (
  kiroSettings: KiroSettings,
  options?: KiroAdapterLiveOptions,
) {
  const compatibleSettings: GrokSettings = {
    enabled: kiroSettings.enabled,
    binaryPath: kiroSettings.binaryPath,
    customModels: kiroSettings.customModels,
  };
  const fileSystem = yield* FileSystem.FileSystem;
  const { homeDir: _homeDir, ...grokOptions } = options ?? {};
  return yield* makeGrokAdapter(compatibleSettings, {
    ...grokOptions,
    // Kiro's /rewind forks the session at an earlier turn; that is what
    // "revert to this message" runs for Kiro threads.
    conversationRewind: makeKiroConversationRewind({
      homeDir: options?.homeDir ?? NodeOS.homedir(),
      fileSystem,
    }),
    provider: ProviderDriverKind.make("kiro"),
    providerLabel: "Kiro",
    enableGrokExtensions: false,
    // ACP has no negotiated steering operation for Kiro. Keep every follow-up
    // behind the live prompt instead of implementing steering by cancellation.
    followUpBehavior: "queue",
    autoApproveEditPermissions: true,
    // Bedrock rejects images whose base64 payload exceeds 5 MiB.
    maxImageBytes: KIRO_SEND_TURN_MAX_IMAGE_BYTES,
    // Kiro agents are ACP session modes; the composer's "Agent" trait picks one.
    sessionModeOptionId: KIRO_AGENT_OPTION_ID,
    resolveModelId: resolveKiroAcpBaseModelId,
    makeRuntime: ({ grokSettings: _grokSettings, runtimeMode: _runtimeMode, ...input }) =>
      makeKiroAcpRuntime({
        ...input,
        kiroSettings,
      }),
  });
});
