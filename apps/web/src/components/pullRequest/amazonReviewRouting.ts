import {
  AmazonReviewProject,
  type EnvironmentId,
  type PullRequestRef,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import * as Schema from "effect/Schema";

export function amazonReviewProject(project: {
  environmentId: EnvironmentId;
  id: PullRequestRef["projectId"];
  title: string;
  workspaceRoot?: string;
  repositoryIdentity?: RepositoryIdentity | null | undefined;
}): AmazonReviewProject | null {
  const identity = project.repositoryIdentity;
  if (
    !identity ||
    (identity.provider !== "crux" &&
      detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl)?.kind !== "crux")
  )
    return null;
  // Older execution servers lowercased the identity. GitFarm package names are case-sensitive;
  // its original remote locator retains the spelling that CRUX returns.
  const remotePackage = /(?:\/pkg\/|:pkg\/)([A-Za-z0-9_.-]+?)\/?$/
    .exec(identity.locator.remoteUrl)?.[1]
    ?.replace(/\.git$/, "");
  const metadata = {
    environmentId: project.environmentId,
    projectId: project.id,
    title: project.title,
    ...(project.workspaceRoot === undefined ? {} : { workspaceRoot: project.workspaceRoot }),
    repository: remotePackage || identity.name || identity.displayName?.split("/").at(-1) || "",
  };
  return Schema.is(AmazonReviewProject)(metadata) ? metadata : null;
}

/** Scope both IDs: different machines can legitimately use the same project ID. */
export function amazonReviewReadTarget<I extends PullRequestRef>(
  target: { environmentId: EnvironmentId; input: I },
  connector: EnvironmentId | null,
  projects: ReadonlyArray<AmazonReviewProject>,
): { environmentId: EnvironmentId; input: I } {
  if (connector === null) return target;
  const project = projects.find(
    (project) =>
      project.environmentId === target.environmentId &&
      project.projectId === target.input.projectId &&
      project.repository.toLowerCase() === target.input.repository.toLowerCase() &&
      (target.input.host === undefined || target.input.host === "code.amazon.com"),
  );
  return project === undefined
    ? target
    : {
        environmentId: connector,
        input: {
          ...target.input,
          repository: project.repository,
          host: "code.amazon.com",
          amazonProject: project,
        },
      };
}
