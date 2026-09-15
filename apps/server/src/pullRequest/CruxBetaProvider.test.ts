import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Crux from "./CruxPullRequestProvider.ts";
import * as CruxApi from "../sourceControl/CruxApi.ts";
import * as CruxCli from "../sourceControl/CruxCli.ts";
import { PullRequestProviderError } from "./PullRequestProvider.ts";
import { make, readOnlyCrux } from "./CruxBetaProvider.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { ServerSettingsService } from "../serverSettings.ts";

it.effect(
  "retains the existing reader opt-in and directs disabled readers to Source Control settings",
  () => {
    const previous = process.env.T3CODE_AMAZON_BETA;
    let enabled = true;
    return Effect.gen(function* () {
      process.env.T3CODE_AMAZON_BETA = "1";
      const beta = yield* make;
      const ref = { cwd: "/reader", host: "code.amazon.com" };
      expect(Exit.isSuccess(yield* Effect.exit(beta.getViewer(ref)))).toBe(true);
      enabled = false;
      const error = yield* beta.getViewer(ref).pipe(Effect.flip);
      expect(error.detail).toContain("Settings > Source Control");
      expect(error.detail).not.toContain("Taskei");
      enabled = true;
      process.env.T3CODE_AMAZON_BETA = "0";
      expect(Exit.isFailure(yield* Effect.exit(beta.getViewer(ref)))).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(CruxApi.CruxApi)({}),
          Layer.mock(CruxCli.CruxCli)({}),
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.sync(() => ({
              ...DEFAULT_SERVER_SETTINGS,
              amazonBetaEnabled: enabled,
            })),
          }),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.T3CODE_AMAZON_BETA;
          else process.env.T3CODE_AMAZON_BETA = previous;
        }),
      ),
    );
  },
);

it.effect("blocks remote write methods before touching Critic or the CLI", () =>
  Effect.gen(function* () {
    const original = yield* Crux.make;
    const beta = readOnlyCrux(original, Effect.void);
    const ref = { cwd: "/tmp", host: "code.amazon.com", repository: "Example", number: 1 };
    const writes = [
      beta.comment({ ...ref, body: "no" }),
      beta.runAction({ ...ref, action: "merge" }),
      beta.submitReview({ ...ref, verdict: "comment", body: "no", comments: [] }),
      beta.replyToThread({ ...ref, threadId: "r1p1", body: "no" }),
      beta.setThreadResolution({ ...ref, threadId: "r1p1", resolved: true }),
      beta.setReviewerRequest({ ...ref, reviewers: [], requested: true }),
    ];
    for (const write of writes) expect(Exit.isFailure(yield* Effect.exit(write))).toBe(true);
    expect(beta.capabilities.comment).toBe(false);
    expect(beta.capabilities.actions).toEqual([]);
    expect((yield* beta.getViewerPermissions(ref)).verdicts).toEqual([]);
    const off = readOnlyCrux(
      original,
      Effect.fail(
        new PullRequestProviderError({
          provider: "crux",
          reason: "failed",
          operation: "betaRead",
          detail: "disabled",
        }),
      ),
    );
    expect(Exit.isFailure(yield* Effect.exit(off.getChangeRequest(ref)))).toBe(true);
  }).pipe(
    Effect.provide(Layer.merge(Layer.mock(CruxApi.CruxApi)({}), Layer.mock(CruxCli.CruxCli)({}))),
  ),
);
