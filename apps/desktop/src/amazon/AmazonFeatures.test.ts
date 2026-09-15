import { assert, describe, it } from "@effect/vitest";

import { resolveAmazonFeaturesEnabled } from "./AmazonFeatures.ts";

describe("AmazonFeatures", () => {
  const home = "/Users/test";

  it("honors an explicit T3CODE_AMAZON override", () => {
    assert.isTrue(
      resolveAmazonFeaturesEnabled({
        env: { T3CODE_AMAZON: "1" },
        homeDirectory: home,
        exists: () => false,
      }),
    );
    assert.isFalse(
      resolveAmazonFeaturesEnabled({
        env: { T3CODE_AMAZON: "0" },
        homeDirectory: home,
        exists: () => true,
      }),
    );
  });

  it("falls back to the presence of a Midway home", () => {
    const seen: string[] = [];
    const exists = (path: string) => {
      seen.push(path);
      return path === "/Users/test/.midway";
    };
    assert.isTrue(resolveAmazonFeaturesEnabled({ env: {}, homeDirectory: home, exists }));
    assert.deepEqual(seen, ["/Users/test/.midway"]);
    assert.isFalse(
      resolveAmazonFeaturesEnabled({ env: {}, homeDirectory: home, exists: () => false }),
    );
  });
});
