/**
 * Optional integration check against the locally installed Kiro CLI.
 * Enable with: T3_KIRO_ACP_PROBE=1 pnpm exec vp test run src/provider/acp/KiroAcpCliProbe.test.ts
 *
 * Kiro authenticates through its own credential store. The ACP handshake
 * deliberately omits protocol-level authenticate.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { KiroSettings, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeKiroAdapter } from "../Layers/KiroAdapter.ts";
import { makeKiroAcpRuntime } from "./KiroAcpSupport.ts";

const kiroAdapterProbeLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-probe-",
}).pipe(Layer.provideMerge(NodeServices.layer));

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

      // Kiro advertises its agents as legacy ACP session modes and switches
      // them with `session/set_mode`, not `session/set_config_option`.
      const modes = yield* runtime.getModeState;
      expect(modes?.currentModeId).toBe("kiro_default");
      const other = modes?.availableModes.find((mode) => mode.id !== modes.currentModeId);
      if (other) {
        yield* runtime.setMode(other.id);
        expect((yield* runtime.getModeState)?.currentModeId).toBe(other.id);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rewinds a Kiro thread through /rewind and continues on the forked session",
    () =>
      Effect.gen(function* () {
        const settings = yield* Schema.decodeUnknownEffect(KiroSettings)({
          enabled: true,
          binaryPath: "kiro-cli",
        });
        const adapter = yield* makeKiroAdapter(settings, { environment: process.env });
        const threadId = ThreadId.make("kiro-rewind-probe");
        const completedTurns: Array<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>> = [];
        let assistantText = "";
        const turnDone = yield* Ref.make(yield* Deferred.make<void>());
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
              assistantText += event.payload.delta;
            }
            if (event.type === "turn.completed") {
              completedTurns.push(event);
              yield* Deferred.succeed(yield* Ref.get(turnDone), undefined);
            }
          }),
        ).pipe(Effect.forkScoped);
        const runTurn = (input: string) =>
          Effect.gen(function* () {
            const done = yield* Deferred.make<void>();
            yield* Ref.set(turnDone, done);
            assistantText = "";
            yield* adapter.sendTurn({ threadId, input });
            yield* Deferred.await(done).pipe(Effect.timeout("120 seconds"));
            return assistantText;
          });

        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const originalSessionId = (session.resumeCursor as { sessionId: string }).sessionId;
        expect(adapter.capabilities.supportsConversationRollback).toBe(true);
        yield* runTurn("Reply with exactly: ONE. Do not use tools.");
        yield* runTurn("Reply with exactly: TWO. Do not use tools.");

        yield* adapter.rollbackThread(threadId, 1);
        const rewound = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
        const rewoundSessionId = (rewound?.resumeCursor as { sessionId: string } | undefined)
          ?.sessionId;
        expect(rewoundSessionId).toBeTypeOf("string");
        expect(rewoundSessionId).not.toBe(originalSessionId);

        const recalled = yield* runTurn(
          "Which exact words did I ask you to reply with earlier in this conversation? List them all, nothing else.",
        );
        expect(recalled).toContain("ONE");
        expect(recalled).not.toContain("TWO");
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(kiroAdapterProbeLayer)),
    { timeout: 300_000 },
  );
});
