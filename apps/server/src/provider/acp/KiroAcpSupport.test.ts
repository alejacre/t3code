import { describe, expect, it } from "@effect/vitest";

import {
  buildKiroAcpSpawnInput,
  KIRO_DEFAULT_AGENT_ID,
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
