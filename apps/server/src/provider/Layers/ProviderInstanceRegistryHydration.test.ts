import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("creates the opt-in default Kiro instance from legacy settings", () => {
    const instances = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    const kiro = instances[ProviderInstanceId.make("kiro")];

    expect(kiro).toMatchObject({
      driver: "kiro",
      config: {
        enabled: false,
        binaryPath: "kiro-cli",
        agentEngine: "",
        agent: "",
      },
    });
  });
});
