/**
 * Optional integration check against the locally installed Kiro CLI.
 * Enable with: T3_KIRO_ACP_PROBE=1 pnpm exec vp test run src/provider/acp/KiroAcpCliProbe.test.ts
 *
 * Kiro authenticates through its own credential store. The ACP handshake
 * deliberately omits protocol-level authenticate.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeKiroAcpRuntime } from "./KiroAcpSupport.ts";

describe.runIf(process.env.T3_KIRO_ACP_PROBE === "1")("Kiro ACP CLI probe", () => {
  it.effect("starts a real Kiro session and advertises typed models", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeKiroAcpRuntime({
        kiroSettings: {
          binaryPath: "kiro-cli",
          agentEngine: "v2",
          agent: "",
        },
        environment: process.env,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-kiro-probe", version: "0.0.0" },
      });
      const output = yield* Ref.make("");
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        return content.type === "text"
          ? Ref.update(output, (current) => current + content.text)
          : Effect.void;
      });
      const started = yield* runtime.start();
      const models = started.sessionSetupResult.models;

      expect(started.initializeResult.agentInfo?.name).toContain("Kiro");
      expect(started.initializeResult.authMethods).toEqual([]);
      expect(typeof started.sessionId).toBe("string");
      expect(typeof models?.currentModelId).toBe("string");
      expect(models?.availableModels.length ?? 0).toBeGreaterThan(0);

      const promptResult = yield* runtime.prompt({
        prompt: [
          {
            type: "text",
            text: "Reply with exactly: KIRO ACP OK. Do not use tools.",
          },
        ],
      });
      expect(promptResult.stopReason).toBe("end_turn");
      expect((yield* Ref.get(output)).trim()).toBe("KIRO ACP OK");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
