import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { amazonReviewProject, amazonReviewReadTarget } from "./amazonReviewRouting";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("cloud-desktop");
const metadata = {
  environmentId: remote,
  projectId: ProjectId.make("p1"),
  title: "Remote package",
  repository: "ExamplePackage",
};
const target = {
  environmentId: remote,
  input: {
    projectId: metadata.projectId,
    repository: metadata.repository,
    number: 42,
    host: "code.amazon.com",
  },
};

describe("Amazon review reader routing", () => {
  it("recognizes GitFarm metadata even when an older server labels it unknown", () => {
    expect(
      amazonReviewProject({
        environmentId: remote,
        id: metadata.projectId,
        title: metadata.title,
        repositoryIdentity: {
          canonicalKey: "gitfarm.amazon.com/pkg/ExamplePackage",
          provider: "unknown",
          name: "examplepackage",
          displayName: "pkg/examplepackage",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "ssh://git.amazon.com/pkg/ExamplePackage",
          },
        },
      }),
    ).toEqual(metadata);
  });
  it("uses local auth while retaining the execution environment and project", () => {
    const routed = amazonReviewReadTarget(target, local, [metadata]);
    expect(routed.environmentId).toBe(local);
    expect(routed.input).toMatchObject({ amazonProject: metadata });
    expect(routed.input.projectId).toBe(metadata.projectId);
  });
  it("does not reroute other hosts, mismatched projects, or opt-out", () => {
    expect(amazonReviewReadTarget(target, null, [metadata])).toBe(target);
    expect(amazonReviewReadTarget(target, local, [{ ...metadata, environmentId: local }])).toBe(
      target,
    );
    const github = { ...target, input: { ...target.input, host: "github.com" } };
    expect(amazonReviewReadTarget(github, local, [metadata])).toBe(github);
    const wrongPackage = { ...target, input: { ...target.input, repository: "OtherPackage" } };
    expect(amazonReviewReadTarget(wrongPackage, local, [metadata])).toBe(wrongPackage);
  });
});
