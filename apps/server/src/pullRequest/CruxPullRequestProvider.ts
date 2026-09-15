import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestMergeCapabilities,
  PullRequestReviewCommentDraft,
  PullRequestReviewThread,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as CruxApi from "../sourceControl/CruxApi.ts";
import * as CruxCli from "../sourceControl/CruxCli.ts";
import { cruxPackageName, cruxReviewState } from "../sourceControl/CruxSourceControlProvider.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
  type PullRequestProviderFailure,
} from "./PullRequestProvider.ts";

const DRAFT_STATUSES = new Set(["DRAFT", "PENDING", "UNPUBLISHED"]);
const REQUEST_CHANGES_FALLBACK_BODY = "Requesting changes.";
const SNAPSHOT_TIMESTAMP_PATTERN = /(?:^|\/)(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})/u;

export const CRUX_CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: ["merge", "ready", "close"],
  mergeMethods: ["merge", "squash", "rebase"],
  search: false,
  reactions: false,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "request-changes"],
  },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: true, comment: false },
};

/** Maps command failures into the stable categories used by the shared review service. */
export function cruxProviderFailure(
  error: CruxApi.CruxApiError | CruxCli.CruxCliError,
): PullRequestProviderFailure {
  if (error._tag === "CruxCliUnavailableError") return { reason: "missing-tool" };
  // A 403 can mean missing permissions. Preserve its detail instead of replacing it with
  // the shared service's fixed expired-session message on review list and detail pages.
  if (error._tag === "MidwayCoralAuthenticationError" && error.status === 403) {
    return { reason: "failed" };
  }
  if (
    error._tag === "CruxCliAuthenticationError" ||
    error._tag === "MidwayCoralAuthenticationError"
  ) {
    return { reason: "unauthenticated" };
  }
  return { reason: "failed" };
}

function actor(login: string | undefined) {
  const normalized = login?.trim();
  return normalized ? { login: normalized, name: null, avatarUrl: null } : null;
}

function timestamp(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const numeric =
    typeof value === "number"
      ? value
      : /^\d+(?:\.\d+)?$/u.test(value.trim())
        ? Number(value)
        : null;
  const dateTime = DateTime.make(
    numeric === null ? value : numeric < 100_000_000_000 ? numeric * 1_000 : numeric,
  );
  return Option.match(dateTime, {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function snapshotTimestamp(snapshotId: string): string | null {
  const match = SNAPSHOT_TIMESTAMP_PATTERN.exec(snapshotId);
  if (!match) return null;
  return timestamp(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
}

function reviewTimestamps(
  review: CruxApi.CruxReview,
  listUpdatedAt?: number,
): { readonly createdAt: string; readonly updatedAt: string } | null {
  const created = review.comments.flatMap((comment) => {
    const value = timestamp(comment.createdAt);
    return value === null ? [] : [value];
  });
  const updated = review.comments.flatMap((comment) => {
    const value = timestamp(comment.lastUpdatedAt) ?? timestamp(comment.createdAt);
    return value === null ? [] : [value];
  });
  const listTimestamp = timestamp(listUpdatedAt);
  const snapshot = snapshotTimestamp(review.snapshot.id);
  const createdByCritic = timestamp(review.review.createdAt);
  const updatedByCritic = timestamp(review.review.lastUpdatedAt);
  const known = [
    ...(listTimestamp === null ? [] : [listTimestamp]),
    ...(snapshot === null ? [] : [snapshot]),
    ...(createdByCritic === null ? [] : [createdByCritic]),
    ...(updatedByCritic === null ? [] : [updatedByCritic]),
  ];
  const createdAt = [...created, ...known].toSorted()[0];
  const updatedAt = [...updated, ...known].toSorted().at(-1);
  return createdAt === undefined || updatedAt === undefined ? null : { createdAt, updatedAt };
}

function analyzerStatus(status: string | undefined): PullRequestCheck["status"] {
  switch (status?.trim().toUpperCase()) {
    case "PASS":
    case "PASSED":
    case "SUCCESS":
    case "SUCCEEDED":
    case "GREEN":
      return "success";
    case "FAIL":
    case "FAILED":
    case "FAILURE":
    case "FAULT":
    case "RED":
      return "failure";
    case "BLOCKED":
    case "PENDING":
    case "RUNNING":
    case "IN_PROGRESS":
    case "QUEUED":
      return "pending";
    case "SKIP":
    case "SKIPPED":
      return "skipped";
    case "CANCELLED":
    case "CANCELED":
      return "cancelled";
    default:
      return "neutral";
  }
}

function checks(review: CruxApi.CruxReview): ReadonlyArray<PullRequestCheck> {
  return review.analyzers.map((analyzer, index) => ({
    name: analyzer.name?.trim() || `Analyzer ${index + 1}`,
    status: analyzerStatus(analyzer.status),
    description: analyzer.message?.trim() || null,
    url: null,
  }));
}

function checksState(review: CruxApi.CruxReview): PullRequestChecksState | undefined {
  if (review.analyzers.length === 0) return undefined;
  const statuses = new Set(review.analyzers.map((analyzer) => analyzerStatus(analyzer.status)));
  if (statuses.has("failure")) return "failing";
  if (statuses.has("pending")) return "pending";
  return "passing";
}

function isDraft(review: CruxApi.CruxReview): boolean {
  return DRAFT_STATUSES.has(review.review.status.trim().toUpperCase());
}

interface CruxListedChangeRequest {
  readonly changeRequest: ProviderChangeRequest;
  readonly packageNames: ReadonlyArray<string>;
}

/** Maps MyCli's account index without requiring a Critic request for every visible row. */
function cruxListedChangeRequest(
  item: CruxCli.CruxUserReview,
  viewer: string,
): CruxListedChangeRequest | null {
  const number = CruxCli.parseCruxNumber(item.id ?? "");
  const createdAt = timestamp(item.revision?.createdAt ?? item.createdAt);
  if (number === null || createdAt === null) return null;
  const status = item.revision?.state?.trim() || "OPEN";
  const author = actor(item.revision?.author?.id);
  return {
    changeRequest: {
      number,
      title: item.revision?.title?.trim() || CruxCli.cruxId(number),
      url: `https://code.amazon.com/reviews/${CruxCli.cruxId(number)}`,
      author,
      headBranch: "review",
      baseBranch: "mainline",
      state: cruxReviewState(status),
      isDraft: DRAFT_STATUSES.has(status.toUpperCase()),
      mergeability: "unknown",
      additions: 0,
      deletions: 0,
      createdAt,
      updatedAt: createdAt,
      reviewRequestLogins: author !== null && author.login !== viewer ? [viewer] : [],
      labels: [],
      reviewDecision: "review-required",
    },
    packageNames: (item.revision?.packageNames ?? [])
      .map((packageName) => packageName.trim())
      .filter(Boolean),
  };
}

/** One CLI strategy applies to every package, so only shared strategies are safe to offer. */
function mergeStrategies(
  options: CruxCli.CruxMergeOptions,
  review: CruxApi.CruxReview,
): ReadonlySet<string> {
  const repositories = new Set(options.repositories.map((repository) => repository.repositoryId));
  if (
    options.crId !== review.review.crId ||
    options.revision !== review.review.revision ||
    review.snapshot.packages.length === 0 ||
    review.snapshot.packages.some((pkg) => !repositories.has(pkg.package_name))
  )
    return new Set();

  const [first, ...rest] = options.repositories.map(
    (repository) => new Set(repository.strategies.map((strategy) => strategy.toLowerCase())),
  );
  return new Set([...(first ?? [])].filter((strategy) => rest.every((set) => set.has(strategy))));
}

function mergeCapabilities(
  options: CruxCli.CruxMergeOptions,
  review: CruxApi.CruxReview,
): PullRequestMergeCapabilities {
  const strategies = mergeStrategies(options, review);
  return {
    merge: strategies.has("fast-forward") || strategies.has("three-way"),
    squash: strategies.has("squash"),
    rebase: strategies.has("rebase"),
  };
}

function emptyMergeOptions(review: CruxApi.CruxReview): CruxCli.CruxMergeOptions {
  return {
    crId: review.review.crId,
    revision: review.review.revision,
    repositories: [],
  };
}

export function cruxViewerPermissions(
  review: CruxApi.CruxReview,
  viewer = process.env.USER?.trim() || NodeOS.userInfo().username,
): PullRequestViewerPermissions {
  const state = cruxReviewState(review.review.status);
  const canMutate = review.review.author.trim() === viewer;
  const actions =
    state !== "open" || !canMutate
      ? []
      : isDraft(review)
        ? (["ready", "close"] as const)
        : (["merge"] as const);
  return {
    actions,
    comment: state === "open",
    resolve: state === "open",
    verdicts: state === "open" ? CRUX_CAPABILITIES.review.verdicts : [],
    requestReviewers: false,
  };
}

/** Converts one CRUX response into the shared row used by every T3 review surface. */
export function cruxChangeRequest(
  review: CruxApi.CruxReview,
  listUpdatedAt?: number,
  packageName?: string,
): ProviderChangeRequest | null {
  const number = CruxCli.parseCruxNumber(review.review.crId);
  if (number === null) return null;
  const snapshotPackage =
    review.snapshot.packages.find((pkg) => pkg.package_name.trim() === packageName) ??
    review.snapshot.packages[0];
  const times = reviewTimestamps(review, listUpdatedAt);
  if (times === null) return null;
  return {
    number,
    title: review.review.summary,
    url: `https://code.amazon.com/reviews/${CruxCli.cruxId(number)}`,
    author: actor(review.review.author),
    headBranch: snapshotPackage?.local_branch?.trim() || "review",
    baseBranch: snapshotPackage?.gitfarm_branch.trim() || "mainline",
    state: cruxReviewState(review.review.status),
    isDraft: isDraft(review),
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    ...times,
    reviewRequestLogins: review.reviewers.flatMap((reviewer) => {
      const id = reviewer.id?.trim();
      return id && reviewer.type?.trim().toUpperCase() === "USER" ? [id] : [];
    }),
    labels: [],
    reviewDecision: review.review.approved === true ? "approved" : "review-required",
    ...(checksState(review) === undefined ? {} : { checksState: checksState(review) }),
  };
}

function mergeStrategy(
  options: CruxCli.CruxMergeOptions,
  method: "merge" | "squash" | "rebase" | undefined,
  review: CruxApi.CruxReview,
): "fast-forward" | "rebase" | "squash" | "three-way" | null {
  const strategies = mergeStrategies(options, review);
  if (method === "squash") return strategies.has("squash") ? "squash" : null;
  if (method === "rebase") return strategies.has("rebase") ? "rebase" : null;
  if (method === "merge") {
    if (strategies.has("fast-forward")) return "fast-forward";
    return strategies.has("three-way") ? "three-way" : null;
  }
  if (strategies.has("fast-forward")) return "fast-forward";
  if (strategies.has("three-way")) return "three-way";
  if (strategies.has("squash")) return "squash";
  return strategies.has("rebase") ? "rebase" : null;
}

interface CruxLocation {
  readonly packageName: string;
  readonly path: string;
  readonly line: number | null;
  readonly side: "left" | "right";
}

export function parseCruxLocation(location: string | undefined): CruxLocation | null {
  if (!location || location === "TOP") return null;
  const parts = location.split(":");
  if (parts[0] !== "v4" || parts.length < 7 || parts[1] === "TOP") return null;
  const before = Number(parts[3] || parts[5]);
  const after = Number(parts[4] || parts[6]);
  const side = Number.isSafeInteger(after) && after > 0 ? "right" : "left";
  const line = side === "right" ? after : before;
  return {
    packageName: parts[1] ?? "",
    path: parts[2] ?? "",
    line: Number.isSafeInteger(line) && line > 0 ? line : null,
    side,
  };
}

function commentPost(comment: CruxApi.CruxComment): number | null {
  const post = Number(comment.id);
  return Number.isSafeInteger(post) && post > 0 ? post : null;
}

function commentReference(post: number, location: string | undefined): string {
  return `${post}|${encodeURIComponent(location ?? "TOP")}`;
}

function parseCommentReference(
  value: string,
): { readonly post: number; readonly location: string } | null {
  const separator = value.indexOf("|");
  if (separator < 1) return null;
  const post = Number(value.slice(0, separator));
  if (!Number.isSafeInteger(post) || post < 1) return null;
  try {
    return { post, location: decodeURIComponent(value.slice(separator + 1)) };
  } catch {
    return null;
  }
}

function commentTimestamp(comment: CruxApi.CruxComment, fallback: string): string {
  return timestamp(comment.createdAt) ?? timestamp(comment.lastUpdatedAt) ?? fallback;
}

function activity(review: CruxApi.CruxReview): ProviderChangeRequestActivity {
  const times = reviewTimestamps(review);
  if (times === null) {
    return {
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [],
    };
  }
  const fallback = times.createdAt;
  const comments = review.comments.flatMap((comment) => {
    const post = commentPost(comment);
    if (post === null) return [];
    const location = parseCruxLocation(comment.location);
    return [
      {
        id: commentReference(post, comment.location),
        kind: location === null ? ("issue-comment" as const) : ("review-comment" as const),
        author: actor(comment.author),
        body: comment.content ?? "",
        createdAt: commentTimestamp(comment, fallback),
        url: null,
        path:
          location === null
            ? null
            : review.snapshot.packages.length > 1
              ? `${location.packageName}/${location.path}`
              : location.path,
        reviewState: comment.importance === 1 ? "CHANGES_REQUESTED" : null,
      },
    ];
  });
  const byPost = new Map(
    review.comments.flatMap((comment) => {
      const post = commentPost(comment);
      return post === null ? [] : [[post, comment] as const];
    }),
  );
  const threadEntries = new Map<number, CruxApi.CruxComment[]>();
  for (const comment of review.comments) {
    const post = commentPost(comment);
    if (post === null) continue;
    const parent = Number(comment.parent);
    const rootPost = Number.isSafeInteger(parent) && parent > 0 ? parent : post;
    const root = byPost.get(rootPost);
    if (parseCruxLocation(root?.location) === null) continue;
    const entries = threadEntries.get(rootPost);
    if (entries === undefined) threadEntries.set(rootPost, [comment]);
    else entries.push(comment);
  }
  const reviewThreads: PullRequestReviewThread[] = [];
  for (const [rootPost, entries] of threadEntries) {
    const root = byPost.get(rootPost);
    const location = parseCruxLocation(root?.location);
    if (root === undefined || location === null) continue;
    const path =
      review.snapshot.packages.length > 1
        ? `${location.packageName}/${location.path}`
        : location.path;
    reviewThreads.push({
      id: commentReference(rootPost, root.location),
      path,
      line: location.line,
      side: location.side,
      isResolved: root.fixed === true,
      isOutdated: false,
      comments: entries
        .toSorted((left, right) =>
          commentTimestamp(left, fallback).localeCompare(commentTimestamp(right, fallback)),
        )
        .flatMap((comment) => {
          const post = commentPost(comment);
          return post === null
            ? []
            : [
                {
                  id: commentReference(post, comment.location ?? root.location),
                  author: actor(comment.author),
                  body: comment.content ?? "",
                  createdAt: commentTimestamp(comment, fallback),
                  url: null,
                },
              ];
        }),
    });
  }
  return {
    comments: comments.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    commentCount: comments.length,
    commentsTruncated: false,
    reviewThreads,
    // Snapshot tips are package boundaries, not a commit history. Keep the full-review diff
    // selected until CRUX supports genuine commit-scoped diffs and their metadata.
    commits: [],
  };
}

function splitDisplayPath(review: CruxApi.CruxReview, path: string) {
  if (review.snapshot.packages.length <= 1) {
    return {
      packageName: review.snapshot.packages[0]?.package_name ?? "",
      path,
    };
  }
  const separator = path.indexOf("/");
  return separator < 1
    ? { packageName: review.snapshot.packages[0]?.package_name ?? "", path }
    : { packageName: path.slice(0, separator), path: path.slice(separator + 1) };
}

function locationForDraft(
  review: CruxApi.CruxReview,
  draft: PullRequestReviewCommentDraft,
): string {
  const target = splitDisplayPath(review, draft.path);
  switch (draft.position.kind) {
    case "added":
      return `v4:${target.packageName}:${target.path}::${draft.position.newLine}::${draft.position.newLine}:`;
    case "deleted":
      return `v4:${target.packageName}:${target.path}:${draft.position.oldLine}::${draft.position.oldLine}::`;
    case "context":
      return draft.position.side === "right"
        ? `v4:${target.packageName}:${target.path}::${draft.position.newLine}::${draft.position.newLine}:`
        : `v4:${target.packageName}:${target.path}:${draft.position.oldLine}::${draft.position.oldLine}::`;
  }
}

export const make = Effect.gen(function* () {
  const api = yield* CruxApi.CruxApi;
  const cli = yield* CruxCli.CruxCli;
  const viewer = process.env.USER?.trim() || NodeOS.userInfo().username;

  const fail = (operation: string) => (error: CruxApi.CruxApiError | CruxCli.CruxCliError) =>
    new PullRequestProviderError({
      provider: "crux",
      operation,
      ...cruxProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  const unsupported = (operation: string, detail: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: "crux",
        operation,
        reason: "failed",
        detail,
      }),
    );

  const getReview = (input: { readonly number: number }, operation: string) =>
    api.getReview({ number: input.number }).pipe(Effect.mapError(fail(operation)));

  const listUserChangeRequests = Effect.fn("CruxPullRequestProvider.listUserChangeRequests")(
    function* (input: {
      readonly cwd: string;
      readonly state: "all" | "open" | "closed" | "merged";
      readonly involvement: "all" | "reviewing" | "authored";
      readonly viewer: string;
      readonly query?: string | undefined;
      readonly operation: "listChangeRequests" | "listChangeRequestsAcross";
    }): Effect.fn.Return<
      {
        readonly items: ReadonlyArray<CruxListedChangeRequest>;
        readonly truncated: boolean;
      },
      PullRequestProviderError
    > {
      if (input.state !== "open" && input.state !== "all") {
        return { items: [], truncated: false };
      }
      const page = yield* cli
        .listUserOpenReviews({ cwd: input.cwd, viewer: input.viewer })
        .pipe(Effect.mapError(fail(input.operation)));
      const query = input.query?.trim().toLowerCase();
      const items = page.codeReviews
        .flatMap((item) => {
          const listed = cruxListedChangeRequest(item, input.viewer);
          return listed === null ? [] : [listed];
        })
        .filter(({ changeRequest }) => {
          if (input.state !== "all" && changeRequest.state !== input.state) return false;
          const author = changeRequest.author?.login;
          if (input.involvement === "authored" && author !== input.viewer) return false;
          if (
            input.involvement === "reviewing" &&
            (author === undefined || author === input.viewer)
          ) {
            return false;
          }
          return !query || changeRequest.title.toLowerCase().includes(query);
        })
        .toSorted((left, right) =>
          right.changeRequest.updatedAt.localeCompare(left.changeRequest.updatedAt),
        );
      return { items, truncated: page.truncated === true };
    },
  );

  const requireChangeRequest = (
    review: CruxApi.CruxReview,
    operation: string,
    packageName: string,
  ): Effect.Effect<ProviderChangeRequest, PullRequestProviderError> => {
    const number = CruxCli.parseCruxNumber(review.review.crId);
    if (number === null) {
      return Effect.fail(
        new PullRequestProviderError({
          provider: "crux",
          operation,
          reason: "failed",
          detail: `CRUX returned an invalid review id: ${review.review.crId}`,
        }),
      );
    }
    const changeRequest = cruxChangeRequest(review, undefined, packageName);
    if (changeRequest !== null) return Effect.succeed(changeRequest);
    return Effect.fail(
      new PullRequestProviderError({
        provider: "crux",
        operation,
        reason: "failed",
        detail: `CRUX returned no usable timestamp metadata for ${CruxCli.cruxId(number)}.`,
      }),
    );
  };

  const provider: PullRequestProviderApi = {
    kind: "crux",
    capabilities: CRUX_CAPABILITIES,

    getViewer: () => Effect.succeed(viewer),

    listChangeRequests: (input) => {
      const packageName = cruxPackageName(input.repository);
      return listUserChangeRequests({
        ...input,
        operation: "listChangeRequests",
      }).pipe(
        Effect.map((page) => {
          const items = page.items
            .filter(({ packageNames }) =>
              packageNames.some((candidate) => candidate === packageName),
            )
            .map(({ changeRequest }) => changeRequest);
          return {
            items: items.slice(0, input.limit),
            truncated: page.truncated || items.length > input.limit,
            continues: false,
          };
        }),
      );
    },

    listChangeRequestsAcross: (input) => {
      const anchor = input.repositories[0];
      if (anchor === undefined) return Effect.succeed({ items: [], truncated: false });
      const repositoriesByPackage = new Map(
        input.repositories.map((repository) => [
          cruxPackageName(repository).toLowerCase(),
          repository,
        ]),
      );
      return listUserChangeRequests({
        ...input,
        operation: "listChangeRequestsAcross",
      }).pipe(
        Effect.map((page) => {
          const items = page.items.flatMap(({ changeRequest, packageNames }) => {
            const repository = packageNames
              .map((packageName) => repositoriesByPackage.get(packageName.toLowerCase()))
              .find((repository) => repository !== undefined);
            // An account-wide result is not evidence that a CR belongs to the first project.
            return repository === undefined ? [] : [{ ...changeRequest, repository }];
          });
          return {
            items: items.slice(0, input.limit),
            truncated: page.truncated || items.length > input.limit,
          };
        }),
      );
    },

    getChangeRequest: (input) =>
      getReview(input, "getChangeRequest").pipe(
        Effect.flatMap((review) =>
          Effect.all(
            {
              files: api
                .getDiffFiles({ packages: review.snapshot.packages })
                .pipe(Effect.mapError(fail("getChangeRequest"))),
              // Merge options are optional detail. Drafts and closed reviews cannot merge, and
              // a MyCli failure must not hide review metadata or the GitFarm diff.
              mergeOptions:
                isDraft(review) || cruxReviewState(review.review.status) !== "open"
                  ? Effect.succeed(emptyMergeOptions(review))
                  : cli
                      .listMergeOptions({
                        cwd: input.cwd,
                        number: input.number,
                        revision: review.review.revision,
                      })
                      .pipe(Effect.orElseSucceed(() => emptyMergeOptions(review))),
            },
            { concurrency: "unbounded" },
          ).pipe(
            Effect.flatMap(({ files, mergeOptions }) =>
              requireChangeRequest(
                review,
                "getChangeRequest",
                cruxPackageName(input.repository),
              ).pipe(
                Effect.map((changeRequest): ProviderChangeRequestDetail => ({
                  ...changeRequest,
                  body: review.review.description ?? "",
                  changedFiles: files.length,
                  // Critic does not expose merge or close event times in this response.
                  mergedAt: null,
                  closedAt: null,
                  reviewers: review.reviewers.flatMap((reviewer) => {
                    if (reviewer.type?.trim().toUpperCase() !== "USER") return [];
                    const value = actor(reviewer.id);
                    return value === null ? [] : [value];
                  }),
                  checks: checks(review),
                  mergeCapabilities: mergeCapabilities(mergeOptions, review),
                  viewerPermissions: cruxViewerPermissions(review, viewer),
                })),
              ),
            ),
          ),
        ),
      ),

    getChangeRequestActivity: (input) =>
      getReview(input, "getChangeRequestActivity").pipe(Effect.map(activity)),

    getViewerPermissions: (input) =>
      getReview(input, "getViewerPermissions").pipe(
        Effect.map((review) => cruxViewerPermissions(review, viewer)),
      ),

    getDiff: (input) =>
      input.commit !== undefined
        ? unsupported(
            "getDiff",
            "CRUX commit diffs are not available. Select the full review diff.",
          )
        : getReview(input, "getDiff").pipe(
            Effect.flatMap((review) =>
              api.getDiffFiles({ packages: review.snapshot.packages }).pipe(
                Effect.mapError(fail("getDiff")),
                Effect.map((files) => ({
                  patch: "",
                  files,
                  truncated: false,
                  nextCursor: null,
                })),
              ),
            ),
          ),

    getDiffFileContents: (input) => {
      if (
        input.packageName === undefined ||
        input.sourceBlobId === undefined ||
        input.destinationBlobId === undefined
      ) {
        return unsupported(
          "getDiffFileContents",
          "The CRUX file identity is incomplete. Refresh the diff and retry.",
        );
      }
      return api
        .getDiffFileContents({
          packageName: input.packageName,
          sourceBlobId: input.sourceBlobId,
          destinationBlobId: input.destinationBlobId,
        })
        .pipe(Effect.mapError(fail("getDiffFileContents")));
    },

    runAction: (input) =>
      getReview(input, "runAction").pipe(
        Effect.flatMap((review) => {
          switch (input.action) {
            case "ready": {
              if (!isDraft(review)) {
                return unsupported("runAction", "This CRUX review is already published.");
              }
              return api
                .publishReview({
                  number: input.number,
                  revision: review.review.revision,
                })
                .pipe(Effect.mapError(fail("runAction")));
            }
            case "merge":
              return cli
                .listMergeOptions({
                  cwd: input.cwd,
                  number: input.number,
                  revision: review.review.revision,
                })
                .pipe(
                  Effect.mapError(fail("runAction")),
                  Effect.flatMap((options) => {
                    const strategy = mergeStrategy(options, input.mergeMethod, review);
                    return strategy === null
                      ? unsupported(
                          "runAction",
                          "CRUX does not offer the selected merge method for this review.",
                        )
                      : cli
                          .mergeReview({
                            cwd: input.cwd,
                            number: input.number,
                            strategy,
                            repositoryIds: review.snapshot.packages.map((pkg) => pkg.package_name),
                          })
                          .pipe(Effect.mapError(fail("runAction")));
                  }),
                );
            case "close":
              return isDraft(review)
                ? api
                    .discardReview({
                      number: input.number,
                      revision: review.review.revision,
                    })
                    .pipe(Effect.mapError(fail("runAction")))
                : unsupported("runAction", "Only an unpublished CRUX draft can be discarded.");
            default:
              return unsupported("runAction", `CRUX does not support ${input.action} here.`);
          }
        }),
      ),

    updateChangeRequest: (input) =>
      getReview(input, "updateChangeRequest").pipe(
        Effect.flatMap((review) =>
          cli
            .updateRevision({
              cwd: input.cwd,
              number: input.number,
              revision: review.review.revision,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
            })
            .pipe(Effect.mapError(fail("updateChangeRequest"))),
        ),
      ),

    comment: (input) =>
      getReview(input, "comment").pipe(
        Effect.flatMap((review) =>
          api
            .createComment({
              number: input.number,
              revision: review.review.revision,
              location: "v4:TOP::::::",
              content: input.body,
              importance: 0,
            })
            .pipe(
              Effect.flatMap(() =>
                api.publishComments({
                  number: input.number,
                  revision: review.review.revision,
                }),
              ),
              Effect.mapError(fail("comment")),
            ),
        ),
      ),

    submitReview: (input) =>
      getReview(input, "submitReview").pipe(
        Effect.flatMap((review) => {
          const topLevelBody = input.body.trim()
            ? input.body
            : input.verdict === "request-changes" && input.comments.length === 0
              ? REQUEST_CHANGES_FALLBACK_BODY
              : null;
          return Effect.all(
            [
              ...(topLevelBody === null
                ? []
                : [
                    api.createComment({
                      number: input.number,
                      revision: review.review.revision,
                      location: "v4:TOP::::::",
                      content: topLevelBody,
                      importance: input.verdict === "request-changes" ? 1 : 0,
                    }),
                  ]),
              ...input.comments.map((comment) =>
                api.createComment({
                  number: input.number,
                  revision: review.review.revision,
                  content: comment.body,
                  importance: input.verdict === "request-changes" ? 1 : 0,
                  location: locationForDraft(review, comment),
                }),
              ),
            ],
            { concurrency: 1, discard: true },
          ).pipe(
            Effect.flatMap(() =>
              api.publishComments({
                number: input.number,
                revision: review.review.revision,
              }),
            ),
            Effect.mapError(fail("submitReview")),
          );
        }),
      ),

    listReviewerCandidates: () =>
      unsupported("listReviewerCandidates", "CRUX reviewer search is not available yet."),

    setReviewerRequest: () =>
      unsupported("setReviewerRequest", "CRUX reviewer changes are not available yet."),

    replyToThread: (input) => {
      const reference = parseCommentReference(input.threadId);
      if (reference === null) {
        return unsupported("replyToThread", "The CRUX comment reference is invalid.");
      }
      return getReview(input, "replyToThread").pipe(
        Effect.flatMap((review) =>
          api
            .createComment({
              number: input.number,
              revision: review.review.revision,
              content: input.body,
              importance: 0,
              parent: reference.post,
              location: reference.location,
            })
            .pipe(
              Effect.flatMap(() =>
                api.publishComments({
                  number: input.number,
                  revision: review.review.revision,
                }),
              ),
              Effect.mapError(fail("replyToThread")),
            ),
        ),
      );
    },

    setThreadResolution: (input) => {
      const reference = parseCommentReference(input.threadId);
      if (reference === null) {
        return unsupported("setThreadResolution", "The CRUX comment reference is invalid.");
      }
      return getReview(input, "setThreadResolution").pipe(
        Effect.flatMap((review) =>
          api
            .updateComment({
              number: input.number,
              revision: review.review.revision,
              post: reference.post,
              location: reference.location,
              fixed: input.resolved,
            })
            .pipe(Effect.mapError(fail("setThreadResolution"))),
        ),
      );
    },

    setReaction: () => unsupported("setReaction", "CRUX does not support reactions here."),
  };

  return provider;
});
