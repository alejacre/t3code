// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  KiroSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeKiroAdapter } from "./KiroAdapter.ts";

const mockAgentPath = NodeURL.fileURLToPath(
  new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
);
const isNativeRequest = Schema.is(
  Schema.Struct({
    event: Schema.Struct({
      kind: Schema.Literal("request"),
      payload: Schema.Struct({ method: Schema.String, status: Schema.String }),
    }),
  }),
);
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-queue-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// Only the mock CLI is spawned. Receipts/gates control every race, never sleeps
// or real Kiro sessions. The request log verifies prompts were actually sent.
const makeHarness = Effect.fn("KiroAdapterTest.makeHarness")(function* (
  options: { readonly gatedPrompts?: number; readonly environment?: Record<string, string> } = {},
) {
  const directory = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-queue-mock-")),
  );
  const requestLogPath = NodePath.join(directory, "requests.ndjson");
  const binaryPath = yield* Effect.sync(() =>
    writeFakeCli({
      directory,
      name: "fake-kiro",
      source: execScriptSource({ scriptPath: mockAgentPath }),
      env: { ...options.environment, T3_ACP_REQUEST_LOG_PATH: requestLogPath },
    }),
  );
  const gates = yield* Effect.forEach(Array.from({ length: options.gatedPrompts ?? 0 }), () =>
    Deferred.make<void>(),
  );
  const promptStarted = yield* Queue.unbounded<number>();
  const turnStarted = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const queued = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const completed =
    yield* Queue.unbounded<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
  const approvals = yield* Queue.unbounded<ApprovalRequestId>();
  const events: ProviderRuntimeEvent[] = [];
  const requests: Array<{ method: string; status: string }> = [];
  let promptCount = 0;
  const kiroSettings = yield* Schema.decodeUnknownEffect(KiroSettings)({
    enabled: true,
    binaryPath,
  });
  const adapter = yield* makeKiroAdapter(kiroSettings, {
    nativeEventLogger: {
      filePath: "memory://kiro-queue-test",
      close: () => Effect.void,
      write: (record) =>
        Effect.gen(function* () {
          if (!isNativeRequest(record)) return;
          const request = record.event.payload;
          requests.push(request);
          if (request.method !== "session/prompt" || request.status !== "started") return;
          const index = promptCount++;
          yield* Queue.offer(promptStarted, index);
          const gate = gates[index];
          if (gate) yield* Deferred.await(gate);
        }),
    },
  });
  yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.gen(function* () {
      events.push(event);
      if (event.type === "turn.started") yield* Queue.offer(turnStarted, event);
      if (event.type === "runtime.warning") yield* Queue.offer(queued, event);
      if (event.type === "turn.completed") yield* Queue.offer(completed, event);
      if (event.type === "request.opened" && event.requestId) {
        yield* Queue.offer(approvals, ApprovalRequestId.make(event.requestId));
      }
    }),
  ).pipe(Effect.forkScoped);
  const readRequests = Effect.promise(async () => {
    const contents = await NodeFSP.readFile(requestLogPath, "utf8");
    return contents
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params?: { prompt?: Array<{ type: string; text?: string }> };
          },
      );
  });
  return {
    adapter,
    gates,
    promptStarted,
    turnStarted,
    queued,
    completed,
    approvals,
    events,
    requests,
    readRequests,
  };
});

it.layer(testLayer)("Kiro queued follow-ups", (it) => {
  for (const timing of ["before ACP dispatch", "while the ACP prompt is outstanding"] as const) {
    it.effect(`keeps three messages in order ${timing} without cancelling or finishing early`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ gatedPrompts: 3 });
        const threadId = ThreadId.make(`kiro-queue-${timing}`);
        yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const first = yield* h.adapter
          .sendTurn({ threadId, input: "FIRST" })
          .pipe(Effect.forkScoped);
        yield* Queue.take(h.turnStarted);
        if (timing === "while the ACP prompt is outstanding") yield* Queue.take(h.promptStarted);
        const second = yield* h.adapter
          .sendTurn({ threadId, input: "SECOND" })
          .pipe(Effect.forkScoped);
        const warning = yield* Queue.take(h.queued);
        assert.equal(warning.type, "runtime.warning");
        const third = yield* h.adapter
          .sendTurn({ threadId, input: "THIRD" })
          .pipe(Effect.forkScoped);
        yield* Queue.take(h.queued);
        if (timing === "before ACP dispatch") yield* Queue.take(h.promptStarted);
        assert.equal(
          h.requests.filter((r) => r.method === "session/prompt" && r.status === "started").length,
          1,
        );
        assert.equal(h.events.filter((e) => e.type === "turn.completed").length, 0);

        yield* Deferred.succeed(h.gates[0]!, undefined);
        assert.equal(yield* Queue.take(h.promptStarted), 1);
        const firstResult = yield* Fiber.join(first);
        assert.equal((yield* h.adapter.listSessions())[0]?.status, "running");
        assert.equal(h.events.filter((e) => e.type === "turn.completed").length, 0);
        yield* Deferred.succeed(h.gates[1]!, undefined);
        assert.equal(yield* Queue.take(h.promptStarted), 2);
        const secondResult = yield* Fiber.join(second);
        assert.equal(h.events.filter((e) => e.type === "turn.completed").length, 0);
        yield* Deferred.succeed(h.gates[2]!, undefined);
        const thirdResult = yield* Fiber.join(third);
        assert.equal((yield* Queue.take(h.completed)).payload.state, "completed");
        assert.equal(firstResult.turnId, secondResult.turnId);
        assert.equal(firstResult.turnId, thirdResult.turnId);
        assert.equal(h.events.filter((e) => e.type === "turn.completed").length, 1);
        assert.equal(h.events.filter((e) => e.type === "content.delta").length, 3);
        const requests = yield* h.readRequests;
        assert.deepEqual(
          requests
            .filter((r) => r.method === "session/prompt")
            .map((r) => r.params?.prompt?.[0]?.text),
          ["FIRST", "SECOND", "THIRD"],
        );
        assert.isFalse(requests.some((r) => r.method === "session/cancel"));
        assert.equal((yield* h.adapter.listSessions())[0]?.status, "ready");
        yield* h.adapter.stopSession(threadId);
      }),
    );
  }

  it.effect("does not change the running prompt's model or dismiss its pending approval", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ environment: { T3_ACP_EMIT_TOOL_CALLS: "1" } });
      const threadId = ThreadId.make("kiro-queue-approval-model");
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter.sendTurn({ threadId, input: "FIRST" }).pipe(Effect.forkScoped);
      const approval = yield* Queue.take(h.approvals);
      const configurationRequestsBefore = h.requests.filter(
        (r) => r.method === "session/set_model" || r.method === "session/set_config_option",
      ).length;
      const second = yield* h.adapter
        .sendTurn({
          threadId,
          input: "SECOND",
          modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-mock-alt" },
        })
        .pipe(Effect.forkScoped);
      yield* Queue.take(h.queued);
      assert.equal(
        h.requests.filter(
          (r) => r.method === "session/set_model" || r.method === "session/set_config_option",
        ).length,
        configurationRequestsBefore,
      );
      assert.equal(h.events.filter((e) => e.type === "request.resolved").length, 0);
      yield* h.adapter.respondToRequest(threadId, approval, "accept");
      yield* Fiber.join(first);
      const secondApproval = yield* Queue.take(h.approvals);
      assert.isAbove(
        h.requests.filter(
          (r) => r.method === "session/set_model" || r.method === "session/set_config_option",
        ).length,
        configurationRequestsBefore,
      );
      yield* h.adapter.respondToRequest(threadId, secondApproval, "accept");
      yield* Fiber.join(second);
      assert.equal((yield* Queue.take(h.completed)).payload.state, "completed");
      yield* h.adapter.stopSession(threadId);
    }),
  );

  it.effect("Stop skips waiting messages and a later idle send still completes", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ environment: { T3_ACP_EMIT_TOOL_CALLS: "1" } });
      const threadId = ThreadId.make("kiro-queue-stop");
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const first = yield* h.adapter.sendTurn({ threadId, input: "FIRST" }).pipe(Effect.forkScoped);
      yield* Queue.take(h.approvals);
      const second = yield* h.adapter
        .sendTurn({ threadId, input: "DO NOT DISPATCH" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(h.queued);
      yield* h.adapter.interruptTurn(threadId);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal((yield* Queue.take(h.completed)).payload.state, "cancelled");
      assert.equal(h.events.filter((e) => e.type === "turn.completed").length, 1);
      assert.equal(
        h.requests.filter((r) => r.method === "session/prompt" && r.status === "succeeded").length,
        1,
      );
      assert.equal(
        h.requests.filter((r) => r.method === "session/prompt" && r.status === "failed").length,
        0,
      );
      const afterStop = yield* h.adapter
        .sendTurn({ threadId, input: "AFTER STOP" })
        .pipe(Effect.forkScoped);
      yield* h.adapter.respondToRequest(threadId, yield* Queue.take(h.approvals), "accept");
      yield* Fiber.join(afterStop);
      assert.equal((yield* Queue.take(h.completed)).payload.state, "completed");
      assert.deepEqual(
        (yield* h.readRequests)
          .filter((r) => r.method === "session/prompt")
          .map((r) => r.params?.prompt?.[0]?.text),
        ["FIRST", "AFTER STOP"],
      );
      yield* h.adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects an invalid follow-up without cancelling the live response", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ gatedPrompts: 1 });
      const threadId = ThreadId.make("kiro-queue-invalid");
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const first = yield* h.adapter.sendTurn({ threadId, input: "FIRST" }).pipe(Effect.forkScoped);
      yield* Queue.take(h.promptStarted);
      const error = yield* h.adapter.sendTurn({ threadId, input: " " }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterValidationError");
      assert.equal((yield* h.adapter.listSessions())[0]?.status, "running");
      yield* Deferred.succeed(h.gates[0]!, undefined);
      yield* Fiber.join(first);
      assert.equal((yield* Queue.take(h.completed)).payload.state, "completed");
      assert.isFalse((yield* h.readRequests).some((r) => r.method === "session/cancel"));
      yield* h.adapter.stopSession(threadId);
    }),
  );

  it.effect("a late Stop while idle cannot cancel the next prompt", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ environment: { T3_ACP_EMIT_TOOL_CALLS: "1" } });
      const threadId = ThreadId.make("kiro-idle-stop");
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* h.adapter.interruptTurn(threadId);
      yield* h.adapter.sendTurn({ threadId, input: "AFTER IDLE STOP" });
      assert.equal((yield* Queue.take(h.completed)).payload.state, "completed");
      assert.isFalse((yield* h.readRequests).some((r) => r.method === "session/cancel"));
      yield* h.adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces a cancelled ACP response when no Stop was requested", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ environment: { T3_ACP_EMIT_TOOL_CALLS: "1" } });
      const threadId = ThreadId.make("kiro-unexpected-cancel");
      yield* h.adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const send = yield* h.adapter
        .sendTurn({ threadId, input: "FIRST" })
        .pipe(Effect.flip, Effect.forkScoped);
      // The mock returns cancelled on this decision, without interruptTurn.
      yield* h.adapter.respondToRequest(threadId, yield* Queue.take(h.approvals), "cancel");
      assert.include((yield* Fiber.join(send)).message, "without a Stop request");
      assert.equal((yield* Queue.take(h.completed)).payload.state, "failed");
      yield* h.adapter.stopSession(threadId);
    }),
  );

  it.effect("reports an idle ACP failure and a queued failure instead of an empty success", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ gatedPrompts: 1, environment: { T3_ACP_FAIL_PROMPT: "1" } });
      const threadId = ThreadId.make("kiro-queue-failure");
      yield* h.adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const first = yield* h.adapter
        .sendTurn({ threadId, input: "FIRST" })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(h.promptStarted);
      const second = yield* h.adapter
        .sendTurn({ threadId, input: "SECOND" })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Queue.take(h.queued);
      yield* Deferred.succeed(h.gates[0]!, undefined);
      assert.include((yield* Fiber.join(first)).message, "Mock prompt failure");
      assert.include((yield* Fiber.join(second)).message, "Mock prompt failure");
      const completion = yield* Queue.take(h.completed);
      assert.equal(completion.payload.state, "failed");
      assert.include(completion.payload.errorMessage ?? "", "Mock prompt failure");
      assert.equal(h.events.filter((e) => e.type === "turn.completed").length, 1);
      assert.equal((yield* h.adapter.listSessions())[0]?.status, "ready");
      yield* h.adapter.stopSession(threadId);
    }),
  );
});
