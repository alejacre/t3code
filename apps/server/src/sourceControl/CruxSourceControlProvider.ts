import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeOS from "node:os";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as CruxApi from "./CruxApi.ts";
import * as CruxCli from "./CruxCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

export function cruxPackageName(repository: string): string {
  const segments = repository
    .trim()
    .replace(/\.git$/iu, "")
    .split("/")
    .filter(Boolean);
  return segments.at(-1) ?? repository.trim();
}

export function parseCruxReference(reference: string): number | null {
  const trimmed = reference.trim();
  if (/^\d+$/u.test(trimmed)) {
    const number = Number(trimmed);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }
  return CruxCli.parseCruxNumber(trimmed);
}

export function cruxReviewState(status: string): "open" | "closed" | "merged" {
  switch (status.trim().toUpperCase()) {
    case "SHIPPED":
    case "MERGED":
      return "merged";
    case "CANCELED":
    case "CANCELLED":
    case "DISCARDED":
      return "closed";
    default:
      return "open";
  }
}

/** Returns whether Critic's hydrated snapshot contains the package being listed. */
export function cruxReviewIncludesPackage(
  review: CruxApi.CruxReview,
  packageName: string,
): boolean {
  return review.snapshot.packages.some(
    (snapshotPackage) => snapshotPackage.package_name.trim() === packageName,
  );
}

/** Uses the current package's branches so a multi-package CR matches the local branch. */
export function cruxChangeRequest(
  review: CruxApi.CruxReview,
  packageName: string,
): ChangeRequest | null {
  const number = parseCruxReference(review.review.crId);
  if (number === null) return null;
  const snapshotPackage = review.snapshot.packages.find(
    (item) => item.package_name.trim() === packageName,
  );
  if (snapshotPackage === undefined) return null;
  return {
    provider: "crux",
    number,
    title: review.review.summary,
    url: `https://code.amazon.com/reviews/${CruxCli.cruxId(number)}`,
    baseRefName: snapshotPackage.gitfarm_branch || "mainline",
    headRefName: snapshotPackage.local_branch || "review",
    state: cruxReviewState(review.review.status),
    updatedAt: Option.none(),
    isCrossRepository: review.snapshot.packages.length > 1,
  };
}

function cruxListError(stdout: string): string | null {
  try {
    const value = JSON.parse(stdout) as Readonly<Record<string, unknown>>;
    for (const entry of Object.values(value)) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "error" in entry &&
        typeof entry.error === "string"
      ) {
        return entry.error;
      }
    }
  } catch {
    // Non-JSON output is handled by the normal exit-code path.
  }
  return null;
}

export function parseCruxAuth(input: SourceControlAuthProbeInput) {
  const listError = cruxListError(input.stdout);
  if (input.exitCode === 0 && listError === null) {
    return providerAuth({
      status: "authenticated",
      account: process.env.USER,
      host: "git.amazon.com",
    });
  }
  const output = [listError, input.stderr, input.stdout].filter(Boolean).join("\n");
  if (!CruxCli.isCruxAuthenticationMessage(output)) {
    return providerAuth({
      status: "unknown",
      host: "git.amazon.com",
      detail: firstSafeAuthLine(output) ?? "CRUX authentication could not be verified.",
    });
  }
  return providerAuth({
    status: "unauthenticated",
    host: "git.amazon.com",
    detail: firstSafeAuthLine(output) ?? "Run `mwinit` to authenticate CRUX.",
  });
}

export const discovery = {
  type: "cli",
  kind: "crux",
  label: "CRUX",
  executable: "my",
  versionArgs: ["--version"],
  authArgs: ["cr", "list-open-reviews", "--packages", "T3CodeAmazonInternal"],
  probeTimeoutMs: 30_000,
  parseAuth: parseCruxAuth,
  installHint:
    "Run the T3 Amazon setup command. It installs MyCli and verifies the CRUX command set.",
} satisfies SourceControlCliDiscoverySpec;

function mapError(
  operation: string,
  cwd: string,
  error: CruxApi.CruxApiError | CruxCli.CruxCliError,
  reference?: string,
) {
  return new SourceControlProviderError({
    provider: "crux",
    operation,
    command: "command" in error ? error.command : "CriticService",
    cwd,
    ...(reference === undefined ? {} : { reference }),
    detail: error.detail,
    cause: error,
  });
}

export const make = Effect.gen(function* () {
  const api = yield* CruxApi.CruxApi;
  const crux = yield* CruxCli.CruxCli;
  const viewer = process.env.USER?.trim() || NodeOS.userInfo().username;
  const requireChangeRequest = (
    review: CruxApi.CruxReview,
    operation: string,
    cwd: string,
    reference: string,
    packageName: string,
  ) => {
    const changeRequest = cruxChangeRequest(review, packageName);
    return changeRequest === null
      ? Effect.fail(
          new SourceControlProviderError({
            provider: "crux",
            operation,
            command: "my",
            cwd,
            reference: SourceControlProvider.transportSafeSourceControlErrorValue(reference),
            detail:
              parseCruxReference(review.review.crId) === null
                ? `CRUX returned an invalid review id: ${review.review.crId}`
                : `Review ${review.review.crId} does not include package ${packageName}.`,
          }),
        )
      : Effect.succeed(changeRequest);
  };

  return SourceControlProvider.SourceControlProvider.of({
    kind: "crux",
    listChangeRequests: (input) => {
      const packageName = cruxPackageName(input.context?.remoteUrl ?? input.cwd);
      return crux
        .listOpenReviews({
          cwd: input.cwd,
          packageName,
          viewer,
        })
        .pipe(
          Effect.flatMap((items) =>
            Effect.gen(function* () {
              const matches: ChangeRequest[] = [];
              const targetBranch = SourceControlProvider.sourceBranch(input);
              const candidates = items.filter(
                (item) => item.author === undefined || item.author.trim() === viewer,
              );
              // Hydrate four metadata records at a time, stopping after the first exact match.
              for (let index = 0; index < candidates.length && matches.length === 0; index += 4) {
                const hydrated = yield* Effect.forEach(
                  candidates.slice(index, index + 4),
                  (item) => {
                    const number = parseCruxReference(item.crId ?? item.id ?? "");
                    if (number === null) return Effect.succeed(null);
                    return api.getReview({ number }).pipe(
                      Effect.map((review) =>
                        review.review.author === viewer &&
                        cruxReviewIncludesPackage(review, packageName)
                          ? cruxChangeRequest(review, packageName)
                          : null,
                      ),
                      Effect.catch((error) =>
                        error._tag === "CruxApiNotFoundError" || error._tag === "CruxApiDecodeError"
                          ? Effect.succeed(null)
                          : Effect.fail(error),
                      ),
                    );
                  },
                  { concurrency: 4 },
                );
                const match = hydrated.find(
                  (changeRequest) =>
                    changeRequest !== null &&
                    changeRequest.state ===
                      (input.state === "all" ? changeRequest.state : input.state) &&
                    changeRequest.headRefName === targetBranch,
                );
                if (match) matches.push(match);
              }
              return matches;
            }),
          ),
          Effect.mapError((error) =>
            mapError(
              "listChangeRequests",
              input.cwd,
              error,
              SourceControlProvider.transportSafeSourceControlErrorValue(input.headSelector),
            ),
          ),
        );
    },
    getChangeRequest: (input) => {
      const number = parseCruxReference(input.reference);
      if (number === null) {
        return Effect.fail(
          new SourceControlProviderError({
            provider: "crux",
            operation: "getChangeRequest",
            command: "my",
            cwd: input.cwd,
            reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
            detail: "Enter a CR id such as CR-123456 or a Code Browser review URL.",
          }),
        );
      }
      return api.getReview({ number }).pipe(
        Effect.mapError((error) => mapError("getChangeRequest", input.cwd, error, input.reference)),
        Effect.flatMap((review) =>
          requireChangeRequest(
            review,
            "getChangeRequest",
            input.cwd,
            input.reference,
            cruxPackageName(input.context?.remoteUrl ?? input.cwd),
          ),
        ),
      );
    },
    createChangeRequest: (input) =>
      crux
        .createReview({
          cwd: input.cwd,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.flatMap((number) => api.getReview({ number })),
          Effect.mapError((error) =>
            mapError("createChangeRequest", input.cwd, error, input.headSelector),
          ),
          Effect.flatMap((review) =>
            requireChangeRequest(
              review,
              "createChangeRequest",
              input.cwd,
              input.headSelector,
              cruxPackageName(input.context?.remoteUrl ?? input.cwd),
            ),
          ),
        ),
    getRepositoryCloneUrls: (input) =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "crux",
          operation: "getRepositoryCloneUrls",
          cwd: input.cwd,
          repository: input.repository,
          detail: "Use a GitFarm clone URL when adding an Amazon package.",
        }),
      ),
    createRepository: (input) =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "crux",
          operation: "createRepository",
          cwd: input.cwd,
          repository: input.repository,
          detail: "T3 does not create GitFarm packages.",
        }),
      ),
    getDefaultBranch: () => Effect.succeed("mainline"),
    checkoutChangeRequest: (input) =>
      Effect.fail(
        new SourceControlProviderError({
          provider: "crux",
          operation: "checkoutChangeRequest",
          cwd: input.cwd,
          reference: input.reference,
          detail: "CRUX checkout is not available in this release.",
        }),
      ),
  });
});
