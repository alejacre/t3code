import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";
import type { PullRequestDiffFile } from "@t3tools/contracts";

import { MidwayCoralClient, type MidwayCoralError } from "./MidwayCoralClient.ts";

const CRITIC_URL = "https://critic-service-sso.corp.amazon.com";
const CRITIC_TARGET = "com.amazon.critic.CriticService";
const WORKSPACE_SNAPSHOT_URL = "https://workspace-snapshots-sso.corp.amazon.com/";
const WORKSPACE_SNAPSHOT_TARGET = "com.amazon.workspacesnapshot.WorkspaceSnapshotService";
const GITFARM_URL = "https://gitfarm-sso.corp.amazon.com";
const GITFARM_TARGET = "com.amazon.brazil.gitfarm.service.GitFarmService";
const PACKAGE_CONCURRENCY = 4;
const MISSING_GIT_OBJECT = /^0{40}$/u;

const EntitySchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
});

const ReviewRevisionIdSchema = Schema.Struct({
  cr: Schema.String,
  revision: Schema.Number,
});

const RevisionSummarySchema = Schema.Struct({
  id: Schema.optional(ReviewRevisionIdSchema),
  status: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
});

const RevisionListSchema = Schema.Struct({
  reviews: Schema.optional(Schema.Array(RevisionSummarySchema)),
});

const ApprovalStatusSchema = Schema.Struct({
  approved: Schema.optional(Schema.Boolean),
});

const CriticReviewerSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  requiredCount: Schema.optional(Schema.Number),
  requiredMinimum: Schema.optional(Schema.Number),
});

const CriticAnalyzerSchema = Schema.Struct({
  partner_id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  statusMessage: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});

const CriticCommentSchema = Schema.Struct({
  author: Schema.optional(EntitySchema),
  content: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
  lastUpdatedAt: Schema.optional(Schema.Number),
  fixed: Schema.optional(Schema.Boolean),
  importance: Schema.optional(Schema.Number),
  parent: Schema.optional(Schema.NullOr(Schema.Number)),
  published: Schema.optional(Schema.Boolean),
  location: Schema.optional(
    Schema.Struct({
      location: Schema.optional(Schema.String),
      post: Schema.optional(Schema.Number),
    }),
  ),
});

const CriticRevisionSchema = Schema.Struct({
  id: Schema.optional(ReviewRevisionIdSchema),
  summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  author: Schema.optional(EntitySchema),
  autoPublish: Schema.optional(Schema.Boolean),
  approvedBy: Schema.optional(Schema.Array(Schema.String)),
  approvedByEntities: Schema.optional(Schema.Array(EntitySchema)),
  createdAt: Schema.optional(Schema.Number),
  lastUpdatedAt: Schema.optional(Schema.Number),
  packages: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) }))),
  reviewers: Schema.optional(Schema.Array(CriticReviewerSchema)),
  analyzers: Schema.optional(Schema.Array(CriticAnalyzerSchema)),
  comments: Schema.optional(Schema.Array(CriticCommentSchema)),
  diffSource: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      id: Schema.String,
    }),
  ),
});

const SnapshotBranchSchema = Schema.Struct({
  base_commit: Schema.optional(Schema.String),
  tip_commit: Schema.optional(Schema.String),
  local_branch: Schema.optional(Schema.String),
  gitfarm_branch: Schema.optional(Schema.String),
});

const SnapshotResponseSchema = Schema.Struct({
  snapshots: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        content: Schema.optional(
          Schema.Array(
            Schema.Struct({
              package_name: Schema.String,
              branches: Schema.optional(Schema.Array(SnapshotBranchSchema)),
            }),
          ),
        ),
      }),
    ),
  ),
});

const RawDiffEntrySchema = Schema.Struct({
  sourcePath: Schema.optional(Schema.String),
  destinationPath: Schema.optional(Schema.String),
  sourceBlobId: Schema.optional(Schema.String),
  destinationBlobId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});

const RawDiffResponseSchema = Schema.Struct({
  diff: Schema.optional(Schema.Array(RawDiffEntrySchema)),
});

const BlobResponseSchema = Schema.Struct({
  content: Schema.optional(Schema.String),
});

export interface CruxPackage {
  readonly package_name: string;
  readonly base_commit: string;
  readonly tip_commit: string;
  readonly local_branch?: string | undefined;
  readonly gitfarm_branch: string;
}

export interface CruxReviewer {
  readonly id?: string | undefined;
  readonly type?: string | undefined;
  readonly requiredCount?: number | undefined;
}

export interface CruxAnalyzer {
  readonly name?: string | undefined;
  readonly status?: string | undefined;
  readonly message?: string | undefined;
  readonly required?: boolean | undefined;
}

export interface CruxComment {
  readonly id?: string | number | undefined;
  readonly parent?: string | number | null | undefined;
  readonly location?: string | undefined;
  readonly author?: string | undefined;
  readonly authorType?: string | undefined;
  readonly importance?: number | undefined;
  readonly fixed?: boolean | undefined;
  readonly content?: string | undefined;
  readonly createdAt?: string | number | undefined;
  readonly lastUpdatedAt?: string | number | undefined;
}

export interface CruxReview {
  readonly snapshot: {
    readonly id: string;
    readonly auto_publish: boolean;
    readonly status: string;
    readonly approved_by: ReadonlyArray<string>;
    readonly packages: ReadonlyArray<CruxPackage>;
  };
  readonly review: {
    readonly crId: string;
    readonly revision: number;
    readonly summary: string;
    readonly description?: string | undefined;
    readonly status: string;
    readonly author: string;
    readonly approved_by: ReadonlyArray<string>;
    readonly createdAt?: number | undefined;
    /** Critic evaluates all required users and groups; individual approvals are insufficient. */
    readonly approved?: boolean | undefined;
    readonly lastUpdatedAt?: number | undefined;
  };
  readonly reviewers: ReadonlyArray<CruxReviewer>;
  readonly analyzers: ReadonlyArray<CruxAnalyzer>;
  readonly comments: ReadonlyArray<CruxComment>;
}

export class CruxApiDecodeError extends Schema.TaggedError<CruxApiDecodeError>()(
  "CruxApiDecodeError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "CRUX returned an unreadable response.";
  }
}

export class CruxApiNotFoundError extends Schema.TaggedError<CruxApiNotFoundError>()(
  "CruxApiNotFoundError",
  {
    crId: Schema.String,
  },
) {
  get detail(): string {
    return `CRUX review ${this.crId} was not found.`;
  }
}

export type CruxApiError = MidwayCoralError | CruxApiDecodeError | CruxApiNotFoundError;

function decode<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
  operation: string,
): Effect.Effect<S["Type"], CruxApiDecodeError> {
  const decoded = Schema.decodeUnknownExit(schema)(value);
  if (Exit.isSuccess(decoded)) return Effect.succeed(decoded.value);
  return Effect.fail(
    new CruxApiDecodeError({
      operation,
      cause: Cause.squash(decoded.cause),
    }),
  );
}

function cruxId(number: number): string {
  return `CR-${number}`;
}

function approvedAliases(revision: typeof CriticRevisionSchema.Type): ReadonlyArray<string> {
  return [
    ...(revision.approvedBy ?? []),
    ...(revision.approvedByEntities ?? []).map((entity) => entity.id),
  ];
}

function latestRevision(reviews: ReadonlyArray<typeof RevisionSummarySchema.Type>): number | null {
  let latest: number | null = null;
  for (const summary of reviews) {
    const revision = summary.id?.revision;
    if (revision !== undefined && (latest === null || revision > latest)) latest = revision;
  }
  return latest;
}

/** Direct Critic, Workspace Snapshot, and GitFarm client matching AgentSpaces Desktop's CR path. */
export class CruxApi extends Context.Service<
  CruxApi,
  {
    readonly getReview: (input: {
      readonly number: number;
      readonly revision?: number | undefined;
    }) => Effect.Effect<CruxReview, CruxApiError>;
    readonly getDiffFiles: (input: {
      readonly packages: ReadonlyArray<CruxPackage>;
    }) => Effect.Effect<ReadonlyArray<PullRequestDiffFile>, CruxApiError>;
    readonly getDiffFileContents: (input: {
      readonly packageName: string;
      readonly sourceBlobId: string;
      readonly destinationBlobId: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      CruxApiError
    >;
    readonly createComment: (input: {
      readonly number: number;
      readonly revision: number;
      readonly location: string;
      readonly content: string;
      readonly importance: number;
      readonly parent?: number | undefined;
    }) => Effect.Effect<void, CruxApiError>;
    readonly publishComments: (input: {
      readonly number: number;
      readonly revision: number;
    }) => Effect.Effect<void, CruxApiError>;
    readonly updateComment: (input: {
      readonly number: number;
      readonly revision: number;
      readonly post: number;
      readonly location: string;
      readonly fixed: boolean;
    }) => Effect.Effect<void, CruxApiError>;
    readonly publishReview: (input: {
      readonly number: number;
      readonly revision: number;
    }) => Effect.Effect<void, CruxApiError>;
    readonly discardReview: (input: {
      readonly number: number;
      readonly revision: number;
    }) => Effect.Effect<void, CruxApiError>;
  }
>()("t3/sourceControl/CruxApi") {}

export const make = Effect.gen(function* () {
  const coral = yield* MidwayCoralClient;
  const currentUser = process.env.USER?.trim() || NodeOS.userInfo().username;

  const callCritic = (operation: string, body: Readonly<Record<string, unknown>>) =>
    coral.call({
      endpoint: CRITIC_URL,
      target: `${CRITIC_TARGET}.${operation}`,
      body,
    });

  const callSnapshot = (operation: string, body: Readonly<Record<string, unknown>>) =>
    coral.call({
      endpoint: WORKSPACE_SNAPSHOT_URL,
      target: `${WORKSPACE_SNAPSHOT_TARGET}.${operation}`,
      body,
    });

  const callGitFarm = (operation: string, body: Readonly<Record<string, unknown>>) =>
    coral.call({
      endpoint: GITFARM_URL,
      target: `${GITFARM_TARGET}.${operation}`,
      body,
    });

  const getReview: CruxApi["Service"]["getReview"] = Effect.fn("CruxApi.getReview")(
    function* (input) {
      const id = cruxId(input.number);
      let revision = input.revision;
      if (revision === undefined) {
        const rawSummaries = yield* callCritic("GetRevisionsByReview", { cr: id });
        const summaries = yield* decode(RevisionListSchema, rawSummaries, "GetRevisionsByReview");
        revision = latestRevision(summaries.reviews ?? []) ?? undefined;
      }
      if (revision === undefined) return yield* new CruxApiNotFoundError({ crId: id });

      const rawRevision = yield* callCritic("GetRevision", {
        reviewRevision: { cr: id, revision },
      });
      const critic = yield* decode(CriticRevisionSchema, rawRevision, "GetRevision");
      const rawApprovalStatus = yield* callCritic("GetApprovalStatus", {
        reviewRevision: { cr: id, revision },
      });
      const approvalStatus = yield* decode(
        ApprovalStatusSchema,
        rawApprovalStatus,
        "GetApprovalStatus",
      );
      const approvals = approvedAliases(critic);
      let packages: ReadonlyArray<CruxPackage> = (critic.packages ?? []).flatMap((item) =>
        item.name
          ? [
              {
                package_name: item.name,
                base_commit: "",
                tip_commit: "",
                local_branch: "review",
                gitfarm_branch: "mainline",
              },
            ]
          : [],
      );

      if (critic.diffSource?.type === "WSNAP") {
        const rawSnapshot = yield* callSnapshot("getSnapshots", {
          snapshot_ids: [critic.diffSource.id],
        });
        const snapshot = yield* decode(SnapshotResponseSchema, rawSnapshot, "getSnapshots");
        const first = Object.values(snapshot.snapshots ?? {})[0];
        packages = (first?.content ?? []).map((item) => {
          const branch = item.branches?.[0];
          return {
            package_name: item.package_name,
            base_commit: branch?.base_commit ?? "",
            tip_commit: branch?.tip_commit ?? "",
            ...(branch?.local_branch === undefined ? {} : { local_branch: branch.local_branch }),
            gitfarm_branch: branch?.gitfarm_branch ?? "mainline",
          };
        });
      }

      const comments = (critic.comments ?? [])
        .filter(
          (comment) =>
            comment.published !== false ||
            (comment.author?.id !== undefined && comment.author.id === currentUser),
        )
        .map((comment): CruxComment => ({
          id: comment.location?.post,
          parent: comment.parent,
          location: comment.location?.location,
          author: comment.author?.id,
          authorType: comment.author?.type,
          importance: comment.importance,
          fixed: comment.fixed,
          content: comment.content,
          createdAt: comment.createdAt,
          lastUpdatedAt: comment.lastUpdatedAt,
        }));

      return {
        snapshot: {
          id: critic.diffSource?.id ?? "",
          auto_publish: critic.autoPublish ?? false,
          status: critic.status ?? "OPEN",
          approved_by: approvals,
          packages,
        },
        review: {
          crId: critic.id?.cr ?? id,
          revision: critic.id?.revision ?? revision,
          summary: critic.summary ?? id,
          ...(critic.description === undefined ? {} : { description: critic.description }),
          status: critic.status ?? "OPEN",
          author: critic.author?.id ?? "",
          approved_by: approvals,
          ...(critic.createdAt === undefined ? {} : { createdAt: critic.createdAt }),
          approved: approvalStatus.approved === true,
          ...(critic.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: critic.lastUpdatedAt }),
        },
        reviewers: (critic.reviewers ?? []).map((reviewer) => ({
          id: reviewer.id,
          type: reviewer.type,
          requiredCount: reviewer.requiredCount,
        })),
        analyzers: (critic.analyzers ?? []).map((analyzer) => ({
          name: analyzer.partner_id,
          status: analyzer.status,
          message: analyzer.statusMessage,
          required: analyzer.required,
        })),
        comments,
      } satisfies CruxReview;
    },
  );

  const getDiffFiles: CruxApi["Service"]["getDiffFiles"] = Effect.fn("CruxApi.getDiffFiles")(
    function* (input) {
      const packageFiles = yield* Effect.all(
        input.packages.map((pkg) =>
          Effect.gen(function* () {
            if (!pkg.base_commit || !pkg.tip_commit) return [];
            const raw = yield* callGitFarm("rawDiff", {
              repositoryId: `pkg/${pkg.package_name}`,
              firstCommit: pkg.base_commit,
              secondCommit: pkg.tip_commit,
              findCopiesHarder: true,
            });
            const response = yield* decode(RawDiffResponseSchema, raw, "rawDiff");
            return (response.diff ?? []).flatMap((entry): ReadonlyArray<PullRequestDiffFile> => {
              const source = entry.sourcePath ?? entry.destinationPath ?? "";
              const destination = entry.destinationPath ?? entry.sourcePath ?? "";
              if (!source || !destination) return [];
              return [
                {
                  packageName: pkg.package_name,
                  sourcePath: source,
                  destinationPath: destination,
                  sourceBlobId:
                    entry.sourceBlobId === undefined || MISSING_GIT_OBJECT.test(entry.sourceBlobId)
                      ? ""
                      : entry.sourceBlobId,
                  destinationBlobId:
                    entry.destinationBlobId === undefined ||
                    MISSING_GIT_OBJECT.test(entry.destinationBlobId)
                      ? ""
                      : entry.destinationBlobId,
                  status: entry.status ?? "M",
                },
              ];
            });
          }),
        ),
        { concurrency: PACKAGE_CONCURRENCY },
      );
      return packageFiles.flat();
    },
  );

  const getBlob = Effect.fn("CruxApi.getBlob")(function* (packageName: string, blobId: string) {
    if (!blobId) return "";
    const raw = yield* callGitFarm("getBlob", {
      repositoryId: `pkg/${packageName}`,
      object: blobId,
    });
    const response = yield* decode(BlobResponseSchema, raw, "getBlob");
    return Buffer.from(response.content ?? "", "base64").toString("utf8");
  });

  const getDiffFileContents: CruxApi["Service"]["getDiffFileContents"] = Effect.fn(
    "CruxApi.getDiffFileContents",
  )(function* (input) {
    const [oldContents, newContents] = yield* Effect.all(
      [
        getBlob(input.packageName, input.sourceBlobId),
        getBlob(input.packageName, input.destinationBlobId),
      ],
      { concurrency: 2 },
    );
    return { oldContents, newContents };
  });

  const createComment: CruxApi["Service"]["createComment"] = Effect.fn("CruxApi.createComment")(
    function* (input) {
      yield* callCritic("CreateComment", {
        location: {
          cr: cruxId(input.number),
          revision: input.revision,
          location: input.location,
        },
        content: input.content,
        importance: input.importance,
        ...(input.parent === undefined ? {} : { parent: input.parent }),
      });
    },
    Effect.asVoid,
  );

  // Critic publishes every draft by this caller on the revision, including Code Browser drafts.
  // Posting controls disclose that scope because this operation has no per-comment selector.
  const publishComments: CruxApi["Service"]["publishComments"] = Effect.fn(
    "CruxApi.publishComments",
  )(function* (input) {
    yield* callCritic("PublishComments", {
      reviewRevision: { cr: cruxId(input.number), revision: input.revision },
    });
  }, Effect.asVoid);

  const updateComment: CruxApi["Service"]["updateComment"] = Effect.fn("CruxApi.updateComment")(
    function* (input) {
      yield* callCritic("UpdateComment", {
        location: {
          cr: cruxId(input.number),
          revision: input.revision,
          post: input.post,
          location: input.location,
        },
        fixed: input.fixed,
      });
    },
    Effect.asVoid,
  );

  const publishReview: CruxApi["Service"]["publishReview"] = Effect.fn("CruxApi.publishReview")(
    function* (input) {
      yield* callCritic("PublishReviewRevision", {
        reviewRevision: { cr: cruxId(input.number), revision: input.revision },
      });
    },
    Effect.asVoid,
  );

  const discardReview: CruxApi["Service"]["discardReview"] = Effect.fn("CruxApi.discardReview")(
    function* (input) {
      yield* callCritic("DeleteReviewRevision", {
        reviewRevision: { cr: cruxId(input.number), revision: input.revision },
      });
    },
    Effect.asVoid,
  );

  return CruxApi.of({
    getReview,
    getDiffFiles,
    getDiffFileContents,
    createComment,
    publishComments,
    updateComment,
    publishReview,
    discardReview,
  });
});

export const layer = Layer.effect(CruxApi, make);
