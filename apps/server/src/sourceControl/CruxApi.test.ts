import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CruxApi from "./CruxApi.ts";
import { MidwayCoralClient } from "./MidwayCoralClient.ts";

function apiLayer(call: MidwayCoralClient["Service"]["call"]) {
  return CruxApi.layer.pipe(Layer.provide(Layer.mock(MidwayCoralClient)({ call })));
}

describe("CruxApi", () => {
  for (const approved of [true, false, undefined]) {
    it.effect(`uses the complete approval status (${approved}) for the requested revision`, () => {
      const call = vi.fn(({ target }: { readonly target: string }) =>
        Effect.succeed(
          target.endsWith("GetApprovalStatus")
            ? { approved }
            : {
                id: { cr: "CR-123", revision: 4 },
                approvedBy: ["one-approver"],
                reviewers: [{ id: "team", type: "GROUP", requiredCount: 2 }],
              },
        ),
      );
      return Effect.gen(function* () {
        const api = yield* CruxApi.CruxApi;
        const detail = yield* api.getReview({ number: 123, revision: 4 });
        expect(detail.review.approved).toBe(approved === true);
        expect(detail.review.approved_by).toEqual(["one-approver"]);
        expect(call).toHaveBeenCalledWith({
          endpoint: "https://critic-service-sso.corp.amazon.com",
          target: "com.amazon.critic.CriticService.GetApprovalStatus",
          body: { reviewRevision: { cr: "CR-123", revision: 4 } },
        });
      }).pipe(Effect.provide(apiLayer(call)));
    });
  }

  it.effect("maps Critic metadata and Workspace Snapshot commit pairs", () => {
    const call = vi.fn(({ target }: { readonly target: string }) => {
      if (target.endsWith("GetRevisionsByReview")) {
        return Effect.succeed({
          reviews: [{ id: { cr: "CR-123", revision: 2 }, status: "PENDING" }],
        });
      }
      if (target.endsWith("GetRevision")) {
        return Effect.succeed({
          id: { cr: "CR-123", revision: 2 },
          summary: "Direct CRUX",
          description: "Uses Critic.",
          status: "PENDING",
          author: { id: "sidkvmar", type: "USER" },
          autoPublish: false,
          approvedByEntities: [{ id: "approver", type: "USER" }],
          createdAt: 1_788_739_200,
          lastUpdatedAt: 1_788_739_320,
          packages: [{ name: "Pkg" }],
          reviewers: [{ id: "reviewer", type: "USER", requiredCount: 1 }],
          analyzers: [{ partner_id: "Unit", status: "PASS", statusMessage: "Passed" }],
          comments: [
            {
              author: { id: "reviewer", type: "USER" },
              content: "Published",
              createdAt: 1_788_739_200,
              lastUpdatedAt: 1_788_739_200,
              fixed: false,
              importance: 1,
              published: true,
              location: { post: 10, location: "v4:Pkg:a.ts::1::1:" },
            },
            {
              author: { id: "other", type: "USER" },
              content: "Hidden draft",
              published: false,
              location: { post: 11, location: "v4:Pkg:a.ts::2::2:" },
            },
          ],
          diffSource: { type: "WSNAP", id: "snapshot-1" },
        });
      }
      return Effect.succeed({
        snapshots: {
          "snapshot-1": {
            content: [
              {
                package_name: "Pkg",
                branches: [
                  {
                    base_commit: "base",
                    tip_commit: "tip",
                    local_branch: "feature/direct",
                    gitfarm_branch: "mainline",
                  },
                ],
              },
            ],
          },
        },
      });
    });

    return Effect.gen(function* () {
      const api = yield* CruxApi.CruxApi;
      const review = yield* api.getReview({ number: 123 });
      expect(review).toMatchObject({
        review: {
          crId: "CR-123",
          revision: 2,
          summary: "Direct CRUX",
          author: "sidkvmar",
          approved_by: ["approver"],
        },
        snapshot: {
          id: "snapshot-1",
          packages: [
            {
              package_name: "Pkg",
              base_commit: "base",
              tip_commit: "tip",
              local_branch: "feature/direct",
              gitfarm_branch: "mainline",
            },
          ],
        },
      });
      expect(review.comments.map((comment) => comment.content)).toEqual(["Published"]);
    }).pipe(Effect.provide(apiLayer(call)));
  });

  it.effect("normalizes added and deleted rawDiff entries and all-zero object ids", () => {
    const call = vi.fn(({ target }: { readonly target: string }) =>
      target.endsWith("rawDiff")
        ? Effect.succeed({
            diff: [
              {
                destinationPath: "new.ts",
                sourceBlobId: "0000000000000000000000000000000000000000",
                destinationBlobId: "new-blob",
                status: "A",
              },
              {
                sourcePath: "old.ts",
                sourceBlobId: "old-blob",
                destinationBlobId: "0000000000000000000000000000000000000000",
                status: "D",
              },
            ],
          })
        : Effect.succeed({}),
    );

    return Effect.gen(function* () {
      const api = yield* CruxApi.CruxApi;
      const files = yield* api.getDiffFiles({
        packages: [
          {
            package_name: "Pkg",
            base_commit: "base",
            tip_commit: "tip",
            gitfarm_branch: "mainline",
          },
        ],
      });
      expect(files).toEqual([
        {
          packageName: "Pkg",
          sourcePath: "new.ts",
          destinationPath: "new.ts",
          sourceBlobId: "",
          destinationBlobId: "new-blob",
          status: "A",
        },
        {
          packageName: "Pkg",
          sourcePath: "old.ts",
          destinationPath: "old.ts",
          sourceBlobId: "old-blob",
          destinationBlobId: "",
          status: "D",
        },
      ]);
    }).pipe(Effect.provide(apiLayer(call)));
  });

  it.effect("decodes both GitFarm blobs and accepts omitted content for an empty blob", () => {
    const call = vi.fn(({ body }: { readonly body: Readonly<Record<string, unknown>> }) =>
      body.object === "old"
        ? Effect.succeed({ content: Buffer.from("before\n").toString("base64") })
        : Effect.succeed({}),
    );

    return Effect.gen(function* () {
      const api = yield* CruxApi.CruxApi;
      const contents = yield* api.getDiffFileContents({
        packageName: "Pkg",
        sourceBlobId: "old",
        destinationBlobId: "empty",
      });
      expect(contents).toEqual({ oldContents: "before\n", newContents: "" });
    }).pipe(Effect.provide(apiLayer(call)));
  });

  it.effect("loads both GitFarm blobs in parallel", () => {
    let active = 0;
    let maxActive = 0;
    const call = vi.fn(({ body }: { readonly body: Readonly<Record<string, unknown>> }) =>
      Effect.promise(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        await Promise.resolve();
        active -= 1;
        return { content: Buffer.from(String(body.object)).toString("base64") };
      }),
    );

    return Effect.gen(function* () {
      const api = yield* CruxApi.CruxApi;
      const contents = yield* api.getDiffFileContents({
        packageName: "Pkg",
        sourceBlobId: "old",
        destinationBlobId: "new",
      });
      expect(contents).toEqual({ oldContents: "old", newContents: "new" });
      expect(maxActive).toBe(2);
    }).pipe(Effect.provide(apiLayer(call)));
  });

  it.effect("sends Critic comment and publish operations with exact revision identity", () => {
    const call = vi.fn(() => Effect.succeed({}));
    return Effect.gen(function* () {
      const api = yield* CruxApi.CruxApi;
      yield* api.createComment({
        number: 123,
        revision: 2,
        location: "v4:Pkg:a.ts::1::1:",
        content: "Fix this.",
        importance: 1,
      });
      yield* api.publishComments({ number: 123, revision: 2 });

      expect(call).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          target: "com.amazon.critic.CriticService.CreateComment",
          body: expect.objectContaining({
            location: { cr: "CR-123", revision: 2, location: "v4:Pkg:a.ts::1::1:" },
          }),
        }),
      );
      expect(call).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          target: "com.amazon.critic.CriticService.PublishComments",
          body: { reviewRevision: { cr: "CR-123", revision: 2 } },
        }),
      );
    }).pipe(Effect.provide(apiLayer(call)));
  });
});
