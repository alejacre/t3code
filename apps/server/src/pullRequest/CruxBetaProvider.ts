import * as Effect from "effect/Effect";
import { PullRequestProviderError, type PullRequestProviderApi } from "./PullRequestProvider.ts";
import * as Crux from "./CruxPullRequestProvider.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const permissions = {
  actions: [],
  comment: false,
  resolve: false,
  verdicts: [],
  requestReviewers: false,
  labels: false,
  stackRebase: false,
} as const;

/** The beta never delegates a remote mutation, even when a client forges a write RPC. */
export function readOnlyCrux(
  provider: PullRequestProviderApi,
  enabled: Effect.Effect<void, PullRequestProviderError>,
): PullRequestProviderApi {
  const denied = () =>
    Effect.fail(
      new PullRequestProviderError({
        provider: "crux",
        reason: "failed",
        operation: "betaWrite",
        detail: "Amazon beta is read-only. Open Code Browser to change this review.",
      }),
    );
  const read =
    <Args extends ReadonlyArray<unknown>, A>(
      fn: (...args: Args) => Effect.Effect<A, PullRequestProviderError>,
    ) =>
    (...args: Args) =>
      enabled.pipe(Effect.andThen(() => fn(...args)));
  return {
    ...provider,
    capabilities: {
      ...provider.capabilities,
      comment: false,
      actions: [],
      mergeMethods: [],
      review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
      edit: { changeRequest: false, comment: false },
      reviewers: { request: false, listCandidates: false },
    },
    getViewer: read(provider.getViewer),
    listChangeRequests: read(provider.listChangeRequests),
    ...(provider.listChangeRequestsAcross
      ? { listChangeRequestsAcross: read(provider.listChangeRequestsAcross) }
      : {}),
    getChangeRequest: read((input) =>
      provider.getChangeRequest(input).pipe(
        Effect.map((detail) => ({
          ...detail,
          viewerPermissions: permissions,
          mergeCapabilities: { merge: false, squash: false, rebase: false },
        })),
      ),
    ),
    getChangeRequestActivity: read(provider.getChangeRequestActivity),
    getViewerPermissions: read(() => Effect.succeed(permissions)),
    getDiff: read(provider.getDiff),
    ...(provider.getDiffFileContents
      ? { getDiffFileContents: read(provider.getDiffFileContents) }
      : {}),
    runAction: denied,
    updateChangeRequest: denied,
    comment: denied,
    updateComment: denied,
    submitReview: denied,
    setReviewerRequest: denied,
    setLabels: denied,
    replyToThread: denied,
    setReaction: denied,
    setThreadResolution: denied,
  };
}

export const make = Effect.gen(function* () {
  const provider = yield* Crux.make;
  const settings = yield* ServerSettingsService;
  const enabled = settings.getSettings.pipe(
    Effect.mapError(
      () =>
        new PullRequestProviderError({
          provider: "crux",
          reason: "failed",
          operation: "betaRead",
          detail: "Cannot read Amazon beta settings.",
        }),
    ),
    Effect.flatMap((value) =>
      process.env.T3CODE_AMAZON_BETA === "1" && value.amazonBetaEnabled
        ? Effect.void
        : Effect.fail(
            new PullRequestProviderError({
              provider: "crux",
              reason: "failed",
              operation: "betaRead",
              detail:
                "Enable Code Amazon/CRUX beta in Settings > Source Control on the primary reader.",
            }),
          ),
    ),
  );
  return readOnlyCrux(provider, enabled);
});
