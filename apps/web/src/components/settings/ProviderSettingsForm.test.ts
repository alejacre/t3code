import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("exposes only Codex, Claude, and Kiro provider definitions", () => {
    expect(Object.keys(DRIVER_OPTION_BY_VALUE).toSorted()).toEqual([
      "claudeAgent",
      "codex",
      "kiro",
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

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
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

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
