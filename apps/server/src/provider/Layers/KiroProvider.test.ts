import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { KiroSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildInitialKiroProviderSnapshot,
  checkKiroProviderStatus,
  KIRO_PROVIDER_TESTING,
} from "./KiroProvider.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

describe("buildInitialKiroProviderSnapshot", () => {
  it.effect("keeps Kiro opt-in with an auto fallback model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(decodeKiroSettings({}));

      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.showInteractionModeToggle).toBe(false);
    }),
  );
});

describe("Kiro model catalog", () => {
  it("parses, deduplicates, and marks the CLI default model", () => {
    const models = KIRO_PROVIDER_TESTING.parseKiroModels(
      JSON.stringify({
        default_model: "auto",
        models: [
          { model_name: "auto", model_id: "auto" },
          {
            model_name: "Claude Opus 4.8",
            model_id: "claude-opus-4.8",
            description: "High capability",
          },
          { model_name: "duplicate", model_id: "claude-opus-4.8" },
        ],
      }),
    );

    expect(models?.map((model) => model.slug)).toEqual(["auto", "claude-opus-4.8"]);
    expect(models?.find((model) => model.slug === "auto")?.isDefault).toBe(true);
  });

  it("rejects malformed CLI output without leaking it into the snapshot", () => {
    expect(KIRO_PROVIDER_TESTING.parseKiroModels("not-json")).toBeNull();
  });
});

it.layer(NodeServices.layer)("checkKiroProviderStatus", (it) => {
  it.effect("reports a ready authenticated Kiro install with discovered models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-" });
        const kiroPath = path.join(dir, "kiro-cli");
        yield* fs.writeFileString(
          kiroPath,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then',
            '  printf "kiro-cli 2.19.1\\n"',
            "  exit 0",
            "fi",
            'if [ "$1" = "whoami" ]; then',
            '  printf "signed in\\n"',
            "  exit 0",
            "fi",
            'if [ "$1" = "chat" ]; then',
            `  printf '%s\\n' '{"default_model":"auto","models":[{"model_name":"auto","model_id":"auto"},{"model_name":"Claude Opus 4.8","model_id":"claude-opus-4.8"}]}'`,
            "  exit 0",
            "fi",
            "exit 2",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(kiroPath, 0o755);

        const snapshot = yield* checkKiroProviderStatus(
          decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
        );

        expect(snapshot.status).toBe("ready");
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("2.19.1");
        expect(snapshot.auth).toEqual({
          status: "authenticated",
          type: "Kiro",
        });
        expect(snapshot.models.map((model) => model.slug)).toEqual(["auto", "claude-opus-4.8"]);
      }),
    ),
  );

  it.effect("warns when an authenticated Kiro install returns an empty catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kiro-empty-" });
        const kiroPath = path.join(dir, "kiro-cli");
        yield* fs.writeFileString(
          kiroPath,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then',
            '  printf "kiro-cli 2.20.0\\n"',
            "  exit 0",
            "fi",
            'if [ "$1" = "whoami" ]; then',
            "  exit 0",
            "fi",
            'if [ "$1" = "chat" ]; then',
            `  printf '%s\\n' '{"default_model":"auto","models":[]}'`,
            "  exit 0",
            "fi",
            "exit 2",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(kiroPath, 0o755);

        const snapshot = yield* checkKiroProviderStatus(
          decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
        );

        expect(snapshot.status).toBe("warning");
        expect(snapshot.message).toContain("empty");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
      }),
    ),
  );
});

describe("Kiro agent catalog", () => {
  const listing = [
    "\u001b[38;5;244mWorkspace: \u001b[0m~/Desktop/.kiro/agents",
    "\u001b[38;5;244mGlobal:    \u001b[0m~/.kiro/agents",
    "",
    "* kiro_default                   \u001b[38;5;244m(Built-in)\u001b[0m    Default agent",
    "  gpu-dev                        Global        GenAI Power User agent for development tasks. Good",
    "                                                general purpose default agent. -- ⚠️ This agent is",
    "                                                managed by AIM. DO NOT EDIT MANUALLY.",
    "  gpu-dev                        Workspace     duplicate shadowed by the first",
    "  kiro_planner                   (Built-in)",
    "  bare.name_1                    Local         Short one",
  ].join("\n");

  it("parses rows, joins wrapped descriptions and strips ANSI and the AIM stamp", () => {
    expect(KIRO_PROVIDER_TESTING.parseKiroAgentList(listing)).toEqual([
      { id: "kiro_default", scope: "Built-in", description: "Default agent" },
      {
        id: "gpu-dev",
        scope: "Global",
        description:
          "GenAI Power User agent for development tasks. Good general purpose default agent.",
      },
      { id: "kiro_planner", scope: "Built-in" },
      { id: "bare.name_1", scope: "Local", description: "Short one" },
    ]);
  });

  it("builds an agent option that defaults to Kiro's default when settings name none", () => {
    const descriptor = KIRO_PROVIDER_TESTING.buildKiroAgentDescriptor(
      KIRO_PROVIDER_TESTING.parseKiroAgentList(listing),
      "",
    );
    expect(descriptor.id).toBe("agent");
    expect(descriptor.currentValue).toBe("kiro_default");
    expect(descriptor.options.map((option) => option.label)).toEqual([
      "Default",
      "gpu-dev",
      "kiro_planner",
      "bare.name_1",
    ]);
    expect(descriptor.options.find((option) => option.isDefault)?.id).toBe("kiro_default");
  });

  it("marks the settings default agent and keeps it selectable even when unlisted", () => {
    const descriptor = KIRO_PROVIDER_TESTING.buildKiroAgentDescriptor([], "my-agent");
    expect(descriptor.currentValue).toBe("my-agent");
    expect(descriptor.options.map((option) => option.id)).toEqual(["kiro_default", "my-agent"]);
  });

  it("declares /goal and /compact as composer slash commands", () => {
    expect(KIRO_PROVIDER_TESTING.KIRO_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "goal",
      "goal clear",
      "compact",
    ]);
  });
});

// Optional check against the locally installed Kiro CLI:
// T3_KIRO_ACP_PROBE=1 pnpm exec vp test run src/provider/Layers/KiroProvider.test.ts
describe.runIf(process.env.T3_KIRO_ACP_PROBE === "1")("Kiro provider live probe", () => {
  it.effect("discovers agents from the installed CLI as the agent option", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({ enabled: true }),
        process.env,
      );
      const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.find(
        (candidate) => candidate.id === "agent",
      );
      expect(descriptor?.type).toBe("select");
      if (descriptor?.type === "select") {
        expect(descriptor.options.length).toBeGreaterThan(1);
        expect(descriptor.options[0]?.id).toBe("kiro_default");
      }
      expect(snapshot.slashCommands.map((command) => command.name)).toContain("goal");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
