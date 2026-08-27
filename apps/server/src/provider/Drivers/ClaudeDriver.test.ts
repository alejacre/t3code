import { describe, expect, it } from "vite-plus/test";

import { resolveClaudeMaintenanceCapabilities } from "./ClaudeDriver.ts";

describe("resolveClaudeMaintenanceCapabilities", () => {
  it("uses Toolbox updates and suppresses npm advisories for Toolbox-managed Claude", () => {
    expect(
      resolveClaudeMaintenanceCapabilities({
        binaryPath: "claude",
        resolvedCommandPath: "/Users/test/.local/bin/claude",
        realCommandPath: "/Users/test/.toolbox/tools/toolbox/1.2.3/toolbox-exec",
      }),
    ).toEqual({
      provider: "claudeAgent",
      packageName: null,
      update: {
        command: "toolbox update claude-code",
        executable: "toolbox",
        args: ["update", "claude-code"],
        lockKey: "builder-toolbox",
      },
    });
  });

  it("keeps native updates for non-Toolbox standalone Claude installs", () => {
    expect(
      resolveClaudeMaintenanceCapabilities({
        binaryPath: "claude",
        resolvedCommandPath: "/Users/test/.local/bin/claude",
        realCommandPath: "/Users/test/.local/share/claude/versions/2.1.247/claude",
      }),
    ).toEqual({
      provider: "claudeAgent",
      packageName: "@anthropic-ai/claude-code",
      update: {
        command: "claude update",
        executable: "claude",
        args: ["update"],
        lockKey: "claude-native",
      },
    });
  });
});
