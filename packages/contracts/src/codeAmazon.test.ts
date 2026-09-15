import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Contracts from "./index.ts";

describe("Code Amazon-only beta contracts", () => {
  it("does not expose the removed task RPCs or schemas", () => {
    expect(Object.values(Contracts.WS_METHODS).some((method) => method.startsWith("taskei."))).toBe(
      false,
    );
    expect(
      [...Contracts.WsRpcGroup.requests.keys()].some((method) => method.startsWith("taskei.")),
    ).toBe(false);
    expect(Object.keys(Contracts).filter((name) => /^(?:Ws)?Taskei/.test(name))).toEqual([]);
    expect(Contracts.WsRpcGroup.requests.has(Contracts.WS_METHODS.pullRequestsDetail)).toBe(true);
  });
  it("preserves existing reader opt-in and the cross-environment project contract", () => {
    expect(Schema.decodeUnknownSync(Contracts.ServerSettings)({}).amazonBetaEnabled).toBe(false);
    expect(
      Schema.decodeUnknownSync(Contracts.ServerSettings)({
        amazonBetaEnabled: true,
      }).amazonBetaEnabled,
    ).toBe(true);
    expect(
      Schema.decodeUnknownSync(Contracts.ServerSettings)({
        amazonBetaEnabled: false,
      }).amazonBetaEnabled,
    ).toBe(false);
    const project = {
      environmentId: "cloud-desktop",
      projectId: "project-1",
      title: "Remote package",
      repository: "ExamplePackage",
      workspaceRoot: "/remote/src/ExamplePackage",
    };
    expect(Schema.decodeUnknownSync(Contracts.AmazonReviewProject)(project)).toEqual(project);
  });
});
