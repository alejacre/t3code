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
