import { describe, expect, it } from "@effect/vitest";

import { TurnId } from "@t3tools/contracts";

import { countPromptsToDrop } from "../Layers/GrokAdapter.ts";
import {
  buildKiroAcpSpawnInput,
  KIRO_DEFAULT_AGENT_ID,
  kiroPromptEntryIndices,
  kiroSessionHistoryPath,
  parseKiroRewoundSessionId,
  planKiroRewind,
  resolveKiroAcpBaseModelId,
  resolveKiroAgent,
} from "./KiroAcpSupport.ts";

describe("resolveKiroAcpBaseModelId", () => {
  it("uses auto by default and preserves discovered model ids", () => {
    expect(resolveKiroAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpBaseModelId("   ")).toBe("auto");
    expect(resolveKiroAcpBaseModelId("  claude-opus-4.8  ")).toBe("claude-opus-4.8");
  });
});

describe("buildKiroAcpSpawnInput", () => {
  it("launches Kiro ACP with the configured agent", () => {
    expect(
      buildKiroAcpSpawnInput(
        {
          binaryPath: "/opt/kiro/kiro-cli",
          agentEngine: "v3",
          agent: "custom-agent",
        },
        "/tmp/project",
        { T3_TEST: "1" },
      ),
    ).toEqual({
      command: "/opt/kiro/kiro-cli",
      args: ["acp", "--agent-engine", "v3", "--agent", "custom-agent"],
      cwd: "/tmp/project",
      env: { T3_TEST: "1" },
    });
  });

  it("falls back to v2 and omits an empty agent", () => {
    expect(
      buildKiroAcpSpawnInput(
        {
          binaryPath: "",
          agentEngine: "experimental",
          agent: "  ",
        },
        "/tmp/project",
      ),
    ).toEqual({
      command: "kiro-cli",
      args: ["acp", "--agent-engine", "v2"],
      cwd: "/tmp/project",
    });
  });
});

describe("per-thread agent selection", () => {
  it("prefers the requested agent over the settings default", () => {
    expect(
      buildKiroAcpSpawnInput(
        { binaryPath: "", agentEngine: "v2", agent: "settings-agent" },
        "/tmp/project",
        undefined,
        "thread-agent",
      ).args,
    ).toEqual(["acp", "--agent-engine", "v2", "--agent", "thread-agent"]);
  });

  it("sends no --agent for Kiro's built-in default even when settings name another", () => {
    expect(
      buildKiroAcpSpawnInput(
        { binaryPath: "", agentEngine: "v2", agent: "settings-agent" },
        "/tmp/project",
        undefined,
        KIRO_DEFAULT_AGENT_ID,
      ).args,
    ).toEqual(["acp", "--agent-engine", "v2"]);
    expect(resolveKiroAgent({ agent: "" }, undefined)).toBe(KIRO_DEFAULT_AGENT_ID);
    expect(resolveKiroAgent({ agent: " gpu-dev " }, "  ")).toBe("gpu-dev");
  });
});

const history = [
  { version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: "ONE" }] } },
  { version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "toolUse" }] } },
  { version: "v1", kind: "ToolResults", data: {} },
  { version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "text", data: "one" }] } },
  { version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: "TWO" }] } },
  { version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "text", data: "two" }] } },
  { version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: "THREE" }] } },
  { version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "text", data: "three" }] } },
]
  .map((entry) => JSON.stringify(entry))
  .join("\n");

describe("Kiro conversation rewind", () => {
  it("locates the Prompt entries in a session history", () => {
    expect(kiroPromptEntryIndices(history)).toEqual([0, 4, 6]);
    expect(kiroPromptEntryIndices("")).toEqual([]);
    expect(kiroPromptEntryIndices("not json\n" + history)).toEqual([1, 5, 7]);
  });

  it("rewinds to the prompt that starts the last surviving turn", () => {
    expect(planKiroRewind(history, 1)).toEqual({ _tag: "command", command: "/rewind 4" });
    expect(planKiroRewind(history, 2)).toEqual({ _tag: "command", command: "/rewind 0" });
    expect(planKiroRewind(history, 3)).toEqual({ _tag: "fresh" });
    expect(planKiroRewind(history, 7)).toEqual({ _tag: "fresh" });
  });

  it("parses the forked session id from Kiro's reply", () => {
    expect(
      parseKiroRewoundSessionId(
        "Rewound to earlier turn (new session 29EB76FF-0916-4eca-a195-5f062900c489)",
      ),
    ).toBe("29eb76ff-0916-4eca-a195-5f062900c489");
    expect(parseKiroRewoundSessionId("Entry at index 1 is not a user prompt.")).toBeUndefined();
    expect(kiroSessionHistoryPath("/Users/alice", "abc")).toBe(
      "/Users/alice/.kiro/sessions/cli/abc.jsonl",
    );
  });

  it("counts steer prompts inside the dropped turns and assumes one per unseen turn", () => {
    const [a, b, c] = [TurnId.make("a"), TurnId.make("b"), TurnId.make("c")];
    // Turn b was steered once, so it holds two prompts.
    const dispatched = [a, b, b, c];
    expect(countPromptsToDrop(dispatched, 1)).toBe(1);
    expect(countPromptsToDrop(dispatched, 2)).toBe(3);
    expect(countPromptsToDrop(dispatched, 3)).toBe(4);
    // Two turns predate this process: one prompt each.
    expect(countPromptsToDrop(dispatched, 5)).toBe(6);
    expect(countPromptsToDrop([], 2)).toBe(2);
  });
});
