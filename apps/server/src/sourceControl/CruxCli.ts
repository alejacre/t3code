import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import type { VcsError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";

const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const CR_ID_PATTERN = /\bCR-(\d+)\b/u;

const CruxListItemSchema = Schema.Struct({
  author: Schema.optional(Schema.String),
  crId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.Number),
});

const CruxListValueSchema = Schema.Union([
  Schema.Array(CruxListItemSchema),
  Schema.Struct({ error: Schema.String }),
]);

export const CruxOpenReviewsSchema = Schema.Record(Schema.String, CruxListValueSchema);
const CruxPendingReviewsSchema = Schema.Struct({
  codeReviews: Schema.Array(CruxListItemSchema),
});
export type CruxOpenReviews = typeof CruxOpenReviewsSchema.Type;
export type CruxListItem = typeof CruxListItemSchema.Type;

const CruxUserReviewSchema = Schema.Struct({
  createdAt: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.String),
  revision: Schema.optional(
    Schema.Struct({
      author: Schema.optional(
        Schema.Struct({
          id: Schema.optional(Schema.String),
        }),
      ),
      createdAt: Schema.optional(Schema.Number),
      packageNames: Schema.optional(Schema.Array(Schema.String)),
      state: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
});

const CruxUserReviewsSchema = Schema.Struct({
  codeReviews: Schema.Array(CruxUserReviewSchema),
  truncated: Schema.optional(Schema.Boolean),
});
export type CruxUserReview = typeof CruxUserReviewSchema.Type;
export type CruxUserReviews = typeof CruxUserReviewsSchema.Type;

const CruxMergeOptionsSchema = Schema.Struct({
  crId: Schema.String,
  revision: Schema.Number,
  repositories: Schema.Array(
    Schema.Struct({
      repositoryId: Schema.String,
      strategies: Schema.Array(Schema.String),
    }),
  ),
});
export type CruxMergeOptions = typeof CruxMergeOptionsSchema.Type;

const CruxMergeResultSchema = Schema.Struct({
  crId: Schema.String,
  abortedMerges: Schema.Array(Schema.Unknown),
  failedMerges: Schema.Array(Schema.Unknown),
  partialMerge: Schema.Boolean,
  successfulMerges: Schema.Array(
    Schema.Struct({ repositoryId: Schema.String, tipCommits: Schema.Array(Schema.String) }),
  ),
});

const CruxMutationResultSchema = Schema.Struct({
  crId: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Number),
});

const commandErrorFields = {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  cause: Schema.Defect(),
};

export class CruxCliUnavailableError extends Schema.TaggedError<CruxCliUnavailableError>()(
  "CruxCliUnavailableError",
  commandErrorFields,
) {
  get detail(): string {
    return "CRUX requires MyCli (`my`) and the CRUX CLI (`cr`) on PATH.";
  }
}

export class CruxCliAuthenticationError extends Schema.TaggedError<CruxCliAuthenticationError>()(
  "CruxCliAuthenticationError",
  commandErrorFields,
) {
  get detail(): string {
    return "CRUX could not use the current Midway session. Run `mwinit` and retry.";
  }
}

export class CruxCliCommandError extends Schema.TaggedError<CruxCliCommandError>()(
  "CruxCliCommandError",
  commandErrorFields,
) {
  get detail(): string {
    if (this.operation === "mergeReview") {
      return "CRUX did not confirm a complete merge. Check the review's merge status before retrying.";
    }
    return "The CRUX command failed.";
  }
}

export class CruxCliDecodeError extends Schema.TaggedError<CruxCliDecodeError>()(
  "CruxCliDecodeError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    outputLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "MyCli returned an unreadable CRUX response.";
  }
}

export type CruxCliError =
  | CruxCliUnavailableError
  | CruxCliAuthenticationError
  | CruxCliCommandError
  | CruxCliDecodeError;

export type CruxCliAccessError = CruxCliUnavailableError | CruxCliAuthenticationError;

/**
 * Returns true when retrying another review cannot recover because CRUX itself is unavailable.
 *
 * Listing callers may skip one malformed or missing review, but they must surface missing tools
 * and expired Midway sessions instead of rendering a misleading empty list.
 */
export function isCruxCliAccessError(error: CruxCliError): error is CruxCliAccessError {
  return error._tag === "CruxCliUnavailableError" || error._tag === "CruxCliAuthenticationError";
}

function fromVcsError(
  operation: string,
  command: string,
  cwd: string,
  error: VcsError,
): CruxCliError {
  const fields = { operation, command, cwd, cause: error };
  return Match.valueTags(error, {
    VcsProcessSpawnError: () => new CruxCliUnavailableError(fields),
    VcsProcessExitError: (cause) =>
      cause.failureKind === "authentication"
        ? new CruxCliAuthenticationError(fields)
        : new CruxCliCommandError(fields),
    VcsProcessTimeoutError: () => new CruxCliCommandError(fields),
    VcsProcessStdinWriteError: () => new CruxCliCommandError(fields),
    VcsProcessOutputReadError: () => new CruxCliCommandError(fields),
    VcsProcessOutputLimitError: () => new CruxCliCommandError(fields),
    VcsProcessMissingExitCodeError: () => new CruxCliCommandError(fields),
    VcsRepositoryDetectionError: () => new CruxCliCommandError(fields),
    VcsUnsupportedOperationError: () => new CruxCliCommandError(fields),
  });
}

/** Returns true when CRUX output tells the user to refresh or restore Midway authentication. */
export function isCruxAuthenticationMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("run `mwinit`") ||
    normalized.includes("run mwinit") ||
    normalized.includes("midway session") ||
    normalized.includes("midway authentication") ||
    normalized.includes("authentication failed") ||
    normalized.includes("unauthorized")
  );
}

function decodeJson<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  raw: string,
  context: { readonly operation: string; readonly command: string; readonly cwd: string },
): Effect.Effect<S["Type"], CruxCliDecodeError> {
  const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(schema))(raw);
  if (Exit.isFailure(decoded)) {
    return Effect.fail(
      new CruxCliDecodeError({
        ...context,
        outputLength: raw.length,
        cause: Cause.squash(decoded.cause),
      }),
    );
  }
  return Effect.succeed(decoded.value);
}

export function cruxId(number: number): string {
  return `CR-${number}`;
}

export function parseCruxNumber(value: string): number | null {
  const match = CR_ID_PATTERN.exec(value);
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Combines package-open rows with the current viewer's unpublished revisions.
 * Pending fields win because that list is authoritative for authored drafts.
 */
function mergeOpenReviews(
  packageOpen: ReadonlyArray<CruxListItem>,
  pending: ReadonlyArray<CruxListItem>,
  viewer: string,
): ReadonlyArray<CruxListItem> {
  const byId = new Map<string, CruxListItem>();
  const withoutId: CruxListItem[] = [];
  const add = (item: CruxListItem, authoredPending: boolean) => {
    const normalized =
      authoredPending && item.author === undefined ? { ...item, author: viewer } : item;
    const rawId = normalized.crId ?? normalized.id;
    const number = rawId === undefined ? null : parseCruxNumber(rawId);
    if (number === null) {
      withoutId.push(normalized);
      return;
    }
    const id = cruxId(number);
    const previous = byId.get(id);
    byId.set(id, previous === undefined ? normalized : { ...previous, ...normalized });
  };

  packageOpen.forEach((item) => add(item, false));
  pending.forEach((item) => add(item, true));
  return [...byId.values(), ...withoutId];
}

/**
 * Runs the standard CRUX and MyCli commands through T3's bounded process service.
 * All structured responses are decoded before they cross the provider boundary.
 */
export class CruxCli extends Context.Service<
  CruxCli,
  {
    readonly listOpenReviews: (input: {
      readonly cwd: string;
      readonly packageName: string;
      readonly viewer: string;
    }) => Effect.Effect<ReadonlyArray<CruxListItem>, CruxCliError>;
    readonly listUserOpenReviews: (input: {
      readonly cwd: string;
      readonly viewer: string;
    }) => Effect.Effect<CruxUserReviews, CruxCliError>;
    readonly createReview: (input: {
      readonly cwd: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<number, CruxCliError>;
    readonly listMergeOptions: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly revision: number;
    }) => Effect.Effect<CruxMergeOptions, CruxCliError>;
    readonly mergeReview: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly repositoryIds: ReadonlyArray<string>;
      readonly strategy: "fast-forward" | "rebase" | "squash" | "three-way";
    }) => Effect.Effect<void, CruxCliError>;
    readonly updateRevision: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly revision: number;
      readonly title?: string;
      readonly body?: string;
    }) => Effect.Effect<void, CruxCliError>;
  }
>()("t3/sourceControl/CruxCli") {}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute = (
    command: "my" | "cr",
    args: ReadonlyArray<string>,
    input: {
      readonly operation: string;
      readonly cwd: string;
      readonly timeoutMs: number;
    },
  ) =>
    process
      .run({
        operation: input.operation,
        command,
        args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      .pipe(Effect.mapError((error) => fromVcsError(input.operation, command, input.cwd, error)));

  const executeMyJson = <S extends Schema.Codec<unknown, unknown, never, never>>(
    schema: S,
    args: ReadonlyArray<string>,
    input: { readonly operation: string; readonly cwd: string; readonly timeoutMs: number },
  ) =>
    execute("my", args, input).pipe(
      Effect.flatMap((output) =>
        decodeJson(schema, output.stdout.trim(), {
          operation: input.operation,
          command: "my",
          cwd: input.cwd,
        }),
      ),
    );

  const mutation = (
    args: ReadonlyArray<string>,
    input: { readonly operation: string; readonly cwd: string },
  ) =>
    executeMyJson(CruxMutationResultSchema, args, {
      ...input,
      timeoutMs: WRITE_TIMEOUT_MS,
    }).pipe(Effect.asVoid);

  const listPackageOpenReviews = Effect.fn("CruxCli.listPackageOpenReviews")(function* (input: {
    readonly cwd: string;
    readonly packageName: string;
  }): Effect.fn.Return<ReadonlyArray<CruxListItem>, CruxCliError> {
    const result = yield* executeMyJson(
      CruxOpenReviewsSchema,
      ["cr", "list-open-reviews", "--packages", input.packageName],
      { operation: "listOpenReviews", cwd: input.cwd, timeoutMs: READ_TIMEOUT_MS },
    );
    const authenticationFailure = Object.values(result).find(
      (entry) => "error" in entry && isCruxAuthenticationMessage(entry.error),
    );
    if (authenticationFailure !== undefined && "error" in authenticationFailure) {
      return yield* new CruxCliAuthenticationError({
        operation: "listOpenReviews",
        command: "my",
        cwd: input.cwd,
        cause: new Error(authenticationFailure.error),
      });
    }
    const value = result[input.packageName];
    if (value !== undefined) {
      if (!("error" in value)) return value;
      return yield* new CruxCliCommandError({
        operation: "listOpenReviews",
        command: "my",
        cwd: input.cwd,
        cause: new Error(value.error),
      });
    }
    const alternatives = Object.values(result).flatMap((entry) =>
      "error" in entry ? [] : [entry],
    );
    return alternatives.length === 1 ? alternatives[0]! : [];
  });

  const listUserOpenReviews = Effect.fn("CruxCli.listUserOpenReviews")(function* (input: {
    readonly cwd: string;
    readonly viewer: string;
  }): Effect.fn.Return<CruxUserReviews, CruxCliError> {
    return yield* Effect.suspend(() =>
      executeMyJson(
        CruxUserReviewsSchema,
        ["cr", "list-reviews", "--user", input.viewer, "--status", "open"],
        { operation: "listUserOpenReviews", cwd: input.cwd, timeoutMs: READ_TIMEOUT_MS },
      ),
    ).pipe(
      // MyCli reads several internal services for this index. Retry one transient command or
      // decode failure, but never repeat missing-tool or expired-session failures.
      Effect.retry({
        while: (error) => !isCruxCliAccessError(error),
        times: 1,
      }),
    );
  });

  return CruxCli.of({
    listOpenReviews: (input) =>
      // A failed draft collection is not an empty collection. Keep the error visible so a
      // successful package-open query cannot silently hide the user's unpublished reviews.
      Effect.all(
        {
          packageOpen: listPackageOpenReviews(input),
          pending: executeMyJson(
            CruxPendingReviewsSchema,
            [
              "cr",
              "list-reviews",
              "--user",
              input.viewer,
              "--status",
              "pending",
              "--direction",
              "from",
            ],
            { operation: "listPendingReviews", cwd: input.cwd, timeoutMs: READ_TIMEOUT_MS },
          ).pipe(Effect.map((result) => result.codeReviews)),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ packageOpen, pending }) =>
          mergeOpenReviews(packageOpen, pending, input.viewer),
        ),
      ),
    listUserOpenReviews,
    createReview: (input) =>
      execute(
        "cr",
        [
          "--summary",
          input.title,
          "--description",
          input.bodyFile,
          "--new-review",
          "--no-amend",
          "--no-open",
          "--no-auto-publish",
          "--no-auto-merge",
        ],
        { operation: "createReview", cwd: input.cwd, timeoutMs: WRITE_TIMEOUT_MS },
      ).pipe(
        Effect.flatMap((output) => {
          const number = parseCruxNumber(`${output.stdout}\n${output.stderr}`);
          return number === null
            ? Effect.fail(
                new CruxCliDecodeError({
                  operation: "createReview",
                  command: "cr",
                  cwd: input.cwd,
                  outputLength: output.stdout.length + output.stderr.length,
                  cause: new Error("The CRUX CLI output contained no CR id."),
                }),
              )
            : Effect.succeed(number);
        }),
      ),
    listMergeOptions: (input) =>
      executeMyJson(
        CruxMergeOptionsSchema,
        [
          "cr",
          "list-merge-options",
          "--id",
          cruxId(input.number),
          "--revision",
          String(input.revision),
        ],
        { operation: "listMergeOptions", cwd: input.cwd, timeoutMs: READ_TIMEOUT_MS },
      ),
    mergeReview: (input) =>
      executeMyJson(
        CruxMergeResultSchema,
        ["cr", "merge-review", "--id", cruxId(input.number), "--strategy", input.strategy],
        { operation: "mergeReview", cwd: input.cwd, timeoutMs: WRITE_TIMEOUT_MS },
      ).pipe(
        Effect.flatMap((result) => {
          // MyCli can exit zero after a partial merge. Confirm every snapshot package before
          // telling the client to show success; a missing repository is an incomplete result.
          const succeeded = new Set(result.successfulMerges.map((merge) => merge.repositoryId));
          return result.crId === cruxId(input.number) &&
            result.failedMerges.length === 0 &&
            result.abortedMerges.length === 0 &&
            !result.partialMerge &&
            input.repositoryIds.length > 0 &&
            input.repositoryIds.every((id) => succeeded.has(id))
            ? Effect.void
            : Effect.fail(
                new CruxCliCommandError({
                  operation: "mergeReview",
                  command: "my",
                  cwd: input.cwd,
                  cause: new Error("CRUX did not confirm success for every requested repository."),
                }),
              );
        }),
      ),
    updateRevision: (input) =>
      mutation(
        [
          "cr",
          "update-revision",
          "--id",
          cruxId(input.number),
          "--revision",
          String(input.revision),
          ...(input.title === undefined ? [] : ["--summary", input.title]),
          ...(input.body === undefined ? [] : ["--description", input.body]),
        ],
        { operation: "updateRevision", cwd: input.cwd },
      ),
  });
});

export const layer = Layer.effect(CruxCli, make);
