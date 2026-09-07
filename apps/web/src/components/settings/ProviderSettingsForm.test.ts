import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("exposes the upstream provider definitions plus Kiro", () => {
    expect(Object.keys(DRIVER_OPTION_BY_VALUE).toSorted()).toEqual([
      "antigravity",
      "claudeAgent",
      "codex",
      "cursor",
      "grok",
      "kiro",
      "opencode",
    ]);
  });

  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const kiro = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("kiro")];
    expect(kiro).toBeDefined();

    const agentEngine = deriveProviderSettingsFields(kiro!).find(
      (field) => field.key === "agentEngine",
    );

    expect(agentEngine).toMatchObject({
      label: "Agent engine",
      description: "Kiro agent engine used for ACP sessions (v1, v2, or v3).",
      control: "text",
    });
  });

  it("derives a select control with its choices for the Antigravity sign-in method", () => {
    const antigravity = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("antigravity")];
    expect(antigravity).toBeDefined();

    const fields = deriveProviderSettingsFields(antigravity!);
    expect(fields.map((field) => field.key)).toEqual([
      "authMethod",
      "apiKey",
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ]);
    const authMethod = fields.find((field) => field.key === "authMethod");
    expect(authMethod).toMatchObject({ control: "select", clearWhenEmpty: "omit" });
    expect(authMethod?.options?.map((option) => option.value)).toEqual([
      "oauth-personal",
      "oauth-business",
      "gemini-api-key",
      "agent-platform",
    ]);
    expect(fields.find((field) => field.key === "apiKey")?.control).toBe("password");
  });

  it("shows the auto-compaction threshold for Claude providers", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    expect(deriveProviderSettingsFields(claude!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "launchArgs",
    ]);
  });

  it("shows Kiro ACP configuration fields", () => {
    const kiro = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("kiro")];
    expect(kiro).toBeDefined();

    expect(deriveProviderSettingsFields(kiro!).map((field) => field.key)).toEqual([
      "binaryPath",
      "agentEngine",
      "agent",
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const kiro = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("kiro")];
    expect(kiro).toBeDefined();

    const agent = deriveProviderSettingsFields(kiro!).find((field) => field.key === "agent");
    expect(agent).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, agent: "custom-agent" },
      agent!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});
