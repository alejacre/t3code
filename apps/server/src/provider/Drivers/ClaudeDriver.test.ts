import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveClaudeMaintenanceCapabilities } from "./ClaudeDriver.ts";

describe("resolveClaudeMaintenanceCapabilities", () => {
  it.layer(NodeServices.layer)("toolbox-managed installs", (it) => {
    it.effect("uses Toolbox updates and suppresses npm advisories", () =>
      Effect.gen(function* () {
        const capabilities = yield* resolveClaudeMaintenanceCapabilities({
          binaryPath: "claude",
          resolvedCommandPath: "/Users/test/.local/bin/claude",
          realCommandPath: "/Users/test/.toolbox/tools/toolbox/1.2.3/toolbox-exec",
          env: {},
          platform: "darwin",
        });
        expect(capabilities.provider).toBe("claudeAgent");
        expect(capabilities.packageName).toBeNull();
        expect(capabilities.update).toMatchObject({
          command: "toolbox update claude-code",
          executable: "toolbox",
          args: ["update", "claude-code"],
          lockKey: "builder-toolbox",
        });
      }),
    );
  });
});
