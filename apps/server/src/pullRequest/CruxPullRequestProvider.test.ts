import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CruxApi from "../sourceControl/CruxApi.ts";
import * as CruxCli from "../sourceControl/CruxCli.ts";
import { MidwayCoralAuthenticationError } from "../sourceControl/MidwayCoralClient.ts";
import {
  cruxChangeRequest,
  cruxViewerPermissions,
  make,
  parseCruxLocation,
} from "./CruxPullRequestProvider.ts";

const review = {
  snapshot: {
    id: "sidkvmar/2026-09-07T22-47-51-00007af65b72-dc24-48af-a4bb-1713685b45c8",
    auto_publish: false,
    status: "PENDING",
    approved_by: [],
    packages: [
      {
        package_name: "Service",
        base_commit: "base-service",
        tip_commit: "tip-service",
        local_branch: "feature/crux",
        gitfarm_branch: "mainline",
      },
      {
        package_name: "Model",
        base_commit: "base-model",
        tip_commit: "tip-model",
        local_branch: "feature/crux",
        gitfarm_branch: "mainline",
      },
    ],
  },
  review: {
    crId: "CR-123456",
    revision: 2,
    summary: "Add CRUX integration",
    description: "Uses Critic and GitFarm.",
    status: "PENDING",
    author: "sidkvmar",
    approved_by: [],
    createdAt: 1_788_739_200,
    lastUpdatedAt: 1_788_739_320,
  },
  reviewers: [
    { id: "reviewer", type: "USER", requiredCount: 1 },
    { id: "arn:aws:sns:us-west-2:123456789012:review-team", type: "SNS", requiredCount: 0 },
  ],
  analyzers: [{ name: "Unit tests", status: "PASS", message: "Passed", required: true }],
  comments: [
    {
      id: 10,
      parent: null,
      location: "v4:Service:src/app.ts::8::8:",
      author: "reviewer",
      importance: 1,
      fixed: false,
      content: "Handle the failure.",
      createdAt: 1_788_739_200,
      lastUpdatedAt: 1_788_739_260,
    },
    {
      id: 11,
      parent: 10,
      location: "v4:Service:src/app.ts::8::8:",
      author: "sidkvmar",
      importance: 0,
      fixed: false,
      content: "Fixed locally.",
      createdAt: 1_788_739_300,
      lastUpdatedAt: 1_788_739_300,
    },
  ],
} satisfies CruxApi.CruxReview;

function listedReview(input: {
  readonly id: string;
  readonly author: string;
  readonly createdAt: number;
  readonly packageNames: ReadonlyArray<string>;
  readonly state?: string;
  readonly title: string;
}) {
  return {
    id: input.id,
    revision: {
      author: { id: input.author },
      createdAt: input.createdAt,
      packageNames: [...input.packageNames],
      state: input.state ?? "OPEN",
      title: input.title,
    },
  };
}

const diffFiles = [
  {
    packageName: "Service",
    sourcePath: "src/app.ts",
    destinationPath: "src/app.ts",
    sourceBlobId: "old-service",
    destinationBlobId: "new-service",
    status: "M",
  },
  {
    packageName: "Model",
    sourcePath: "src/app.ts",
    destinationPath: "src/app.ts",
    sourceBlobId: "",
    destinationBlobId: "new-model",
    status: "A",
  },
] as const;

function providerLayer(options?: {
  readonly api?: Partial<CruxApi.CruxApi["Service"]>;
  readonly cli?: Partial<CruxCli.CruxCli["Service"]>;
}) {
  return Layer.merge(
    Layer.mock(CruxApi.CruxApi)({
      getReview: () => Effect.succeed(review),
      getDiffFiles: () => Effect.succeed(diffFiles),
      getDiffFileContents: () =>
        Effect.succeed({ oldContents: "before\n", newContents: "after\n" }),
      createComment: () => Effect.void,
      publishComments: () => Effect.void,
      updateComment: () => Effect.void,
      publishReview: () => Effect.void,
      discardReview: () => Effect.void,
      ...options?.api,
    }),
    Layer.mock(CruxCli.CruxCli)({
      listOpenReviews: () => Effect.succeed([]),
      listUserOpenReviews: () => Effect.succeed({ codeReviews: [], truncated: false }),
      createReview: () => Effect.succeed(123456),
      listMergeOptions: () =>
        Effect.succeed({
          crId: "CR-123456",
          revision: 2,
          repositories: ["Service", "Model"].map((repositoryId) => ({
            repositoryId,
            strategies: ["fast-forward", "three-way", "squash", "rebase"],
          })),
        }),
      mergeReview: () => Effect.void,
      updateRevision: () => Effect.void,
      ...options?.cli,
    }),
  );
}

describe("CRUX review mapping", () => {
  it("requires Critic's complete approval decision even when an individual has approved", () => {
    for (const approved of [true, false, undefined]) {
      const detail: CruxApi.CruxReview = {
        ...review,
        review: { ...review.review, approved_by: ["reviewer"], approved },
        reviewers: [{ id: "team", type: "GROUP", requiredCount: 2 }],
      };
      expect(cruxChangeRequest(detail)?.reviewDecision).toBe(
        approved === true ? "approved" : "review-required",
      );
    }
  });

  it("maps the selected package's branch in review rows", () => {
    const detail = {
      ...review,
      snapshot: {
        ...review.snapshot,
        packages: review.snapshot.packages.map((pkg) => ({
          ...pkg,
          package_name: ` ${pkg.package_name} `,
          local_branch: `${pkg.package_name}-feature`,
          gitfarm_branch: `${pkg.package_name}-base`,
        })),
      },
    };
    expect(cruxChangeRequest(detail, undefined, "Model")).toMatchObject({
      headBranch: "Model-feature",
      baseBranch: "Model-base",
    });
  });

  it("maps Critic metadata into a T3 review row", () => {
    expect(cruxChangeRequest(review)).toEqual({
      number: 123456,
      title: "Add CRUX integration",
      url: "https://code.amazon.com/reviews/CR-123456",
      author: { login: "sidkvmar", name: null, avatarUrl: null },
      headBranch: "feature/crux",
      baseBranch: "mainline",
      state: "open",
      isDraft: true,
      mergeability: "unknown",
      additions: 0,
      deletions: 0,
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T22:47:51.000Z",
      reviewRequestLogins: ["reviewer"],
      labels: [],
      reviewDecision: "review-required",
      checksState: "passing",
    });
  });

  it("uses Critic timestamps when a review has no comments", () => {
    const changeRequest = cruxChangeRequest({ ...review, comments: [] });
    expect(changeRequest).toMatchObject({
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T22:47:51.000Z",
    });
  });

  it("reads CRUX v4 locations on both sides of a diff", () => {
    expect(parseCruxLocation("v4:Service:src/app.ts::8::8:")).toEqual({
      packageName: "Service",
      path: "src/app.ts",
      line: 8,
      side: "right",
    });
    expect(parseCruxLocation("v4:Service:src/app.ts:4::4::")).toEqual({
      packageName: "Service",
      path: "src/app.ts",
      line: 4,
      side: "left",
    });
  });

  it("offers publish and discard for drafts, then merge for published reviews", () => {
    expect(cruxViewerPermissions(review, "sidkvmar").actions).toEqual(["ready", "close"]);
    expect(
      cruxViewerPermissions({ ...review, review: { ...review.review, status: "OPEN" } }, "sidkvmar")
        .actions,
    ).toEqual(["merge"]);
    expect(cruxViewerPermissions(review, "reviewer").actions).toEqual([]);
  });
});

describe("CRUX direct service operations", () => {
  it.effect(
    "lists matching account reviews without assigning unrelated packages to the anchor",
    () => {
      const getReview = vi.fn(() => Effect.succeed(review));
      const listUserOpenReviews = vi.fn(() =>
        Effect.succeed({
          codeReviews: [
            listedReview({
              id: "CR-123456",
              author: "sidkvmar",
              createdAt: 1_788_739_320,
              packageNames: ["OtherPackage"],
              state: "DRAFT",
              title: "Unpublished account review",
            }),
            listedReview({
              id: "CR-123455",
              author: "reviewer",
              createdAt: 1_788_739_200,
              packageNames: ["Model"],
              title: "Review requested from me",
            }),
          ],
          truncated: false,
        }),
      );
      return Effect.gen(function* () {
        const provider = yield* make;
        const page = yield* provider.listChangeRequestsAcross!({
          cwd: "/workspace/src/Service",
          host: "git.amazon.com",
          repositories: ["Service", "Model"],
          state: "open",
          involvement: "all",
          viewer: "sidkvmar",
          limit: 20,
        });

        expect(page.items).toMatchObject([
          {
            number: 123455,
            repository: "Model",
            title: "Review requested from me",
            isDraft: false,
            author: { login: "reviewer" },
          },
        ]);
        expect(getReview).not.toHaveBeenCalled();
        expect(listUserOpenReviews).toHaveBeenCalledWith({
          cwd: "/workspace/src/Service",
          viewer: "sidkvmar",
        });
      }).pipe(
        Effect.provide(
          providerLayer({
            api: { getReview },
            cli: { listUserOpenReviews },
          }),
        ),
      );
    },
  );

  it.effect("keeps repository fallback package-scoped and applies account filters", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const page = yield* provider.listChangeRequests({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        state: "open",
        involvement: "authored",
        viewer: "sidkvmar",
        query: "draft",
        limit: 20,
      });

      expect(page.items).toMatchObject([
        {
          number: 123456,
          title: "Service draft",
          isDraft: true,
          author: { login: "sidkvmar" },
        },
      ]);
      expect(page.continues).toBe(false);
    }).pipe(
      Effect.provide(
        providerLayer({
          cli: {
            listUserOpenReviews: () =>
              Effect.succeed({
                codeReviews: [
                  listedReview({
                    id: "CR-123456",
                    author: "sidkvmar",
                    createdAt: 1_788_739_320,
                    packageNames: ["Service"],
                    state: "DRAFT",
                    title: "Service draft",
                  }),
                  listedReview({
                    id: "CR-123455",
                    author: "sidkvmar",
                    createdAt: 1_788_739_200,
                    packageNames: ["OtherPackage"],
                    state: "DRAFT",
                    title: "Other draft",
                  }),
                  listedReview({
                    id: "CR-123454",
                    author: "reviewer",
                    createdAt: 1_788_739_100,
                    packageNames: ["Service"],
                    title: "Service review",
                  }),
                ],
                truncated: false,
              }),
          },
        }),
      ),
    ),
  );

  it.effect("maps non-authored account rows to the reviewing view", () => {
    return Effect.gen(function* () {
      const provider = yield* make;
      const page = yield* provider.listChangeRequestsAcross!({
        cwd: "/workspace/src/Service",
        host: "git.amazon.com",
        repositories: ["Service"],
        state: "open",
        involvement: "reviewing",
        viewer: "sidkvmar",
        limit: 20,
      });
      expect(page.items.map((item) => item.number)).toEqual([123455]);
    }).pipe(
      Effect.provide(
        providerLayer({
          cli: {
            listUserOpenReviews: () =>
              Effect.succeed({
                codeReviews: [
                  listedReview({
                    id: "CR-123456",
                    author: "sidkvmar",
                    createdAt: 1_788_739_320,
                    packageNames: ["Service"],
                    title: "Authored",
                  }),
                  listedReview({
                    id: "CR-123455",
                    author: "reviewer",
                    createdAt: 1_788_739_200,
                    packageNames: ["Service"],
                    title: "Reviewing",
                  }),
                ],
                truncated: false,
              }),
          },
        }),
      ),
    );
  });

  it.effect("keeps the list available when Critic is transiently unavailable", () => {
    const getReview = vi.fn(() =>
      Effect.fail(
        new CruxApi.CruxApiDecodeError({
          operation: "GetRevision",
          cause: new Error("temporary Critic failure"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const provider = yield* make;
      const page = yield* provider.listChangeRequests({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        state: "open",
        involvement: "all",
        viewer: "sidkvmar",
        limit: 20,
      });

      expect(page.items.map((item) => item.number)).toEqual([123456]);
      expect(getReview).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        providerLayer({
          api: { getReview },
          cli: {
            listUserOpenReviews: () =>
              Effect.succeed({
                codeReviews: [
                  listedReview({
                    id: "CR-123456",
                    author: "sidkvmar",
                    createdAt: 1_788_739_320,
                    packageNames: ["Service"],
                    title: "Still visible",
                  }),
                ],
                truncated: false,
              }),
          },
        }),
      ),
    );
  });

  it.effect("surfaces a stale Midway session from the account index", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const error = yield* provider
        .listChangeRequests({
          cwd: "/workspace/src/Service",
          repository: "Service",
          host: "git.amazon.com",
          state: "open",
          involvement: "all",
          viewer: "sidkvmar",
          limit: 20,
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "unauthenticated" });
    }).pipe(
      Effect.provide(
        providerLayer({
          cli: {
            listUserOpenReviews: () =>
              Effect.fail(
                new CruxCli.CruxCliAuthenticationError({
                  operation: "listUserOpenReviews",
                  command: "my",
                  cwd: "/workspace/src/Service",
                  cause: new Error("Run mwinit and retry."),
                }),
              ),
          },
        }),
      ),
    ),
  );

  it.effect("keeps permissions guidance on review detail failures", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const input = {
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
      };
      const detailError = yield* provider.getChangeRequest(input).pipe(Effect.flip);
      expect(detailError.reason).toBe("failed");
      expect(detailError.detail).toContain("service permissions");
    }).pipe(
      Effect.provide(
        providerLayer({
          api: {
            getReview: () =>
              Effect.fail(
                new MidwayCoralAuthenticationError({
                  endpoint: "https://critic-service-sso.corp.amazon.com",
                  status: 403,
                }),
              ),
          },
        }),
      ),
    ),
  );

  it.effect("reports an invalid CR id when detail mapping cannot parse the review id", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const error = yield* provider
        .getChangeRequest({
          cwd: "/workspace/src/Service",
          repository: "Service",
          host: "git.amazon.com",
          number: 123456,
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        operation: "getChangeRequest",
        reason: "failed",
        detail: "CRUX returned an invalid review id: not-a-review",
      });
    }).pipe(
      Effect.provide(
        providerLayer({
          api: {
            getReview: () =>
              Effect.succeed({
                ...review,
                review: { ...review.review, crId: "not-a-review" },
              }),
          },
        }),
      ),
    ),
  );

  it.effect("reports missing timestamp metadata for a valid CR id", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const error = yield* provider
        .getChangeRequest({
          cwd: "/workspace/src/Service",
          repository: "Service",
          host: "git.amazon.com",
          number: 123456,
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        operation: "getChangeRequest",
        reason: "failed",
        detail: "CRUX returned no usable timestamp metadata for CR-123456.",
      });
    }).pipe(
      Effect.provide(
        providerLayer({
          api: {
            getReview: () =>
              Effect.succeed({
                ...review,
                snapshot: { ...review.snapshot, id: "snapshot-without-a-timestamp" },
                review: {
                  crId: review.review.crId,
                  revision: review.review.revision,
                  summary: review.review.summary,
                  description: review.review.description,
                  status: review.review.status,
                  author: review.review.author,
                  approved_by: review.review.approved_by,
                },
                comments: [],
              }),
          },
        }),
      ),
    ),
  );

  it.effect("counts GitFarm files in the core detail", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
      });
      expect(detail.changedFiles).toBe(2);
      expect(detail.body).toBe("Uses Critic and GitFarm.");
    }).pipe(Effect.provide(providerLayer())),
  );

  it.effect("opens draft details without requiring merge options", () => {
    const listMergeOptions = vi.fn(() =>
      Effect.fail(
        new CruxCli.CruxCliCommandError({
          operation: "listMergeOptions",
          command: "my",
          cwd: "/workspace/src/Service",
          cause: new Error("not available for drafts"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
      });
      expect(detail.changedFiles).toBe(2);
      expect(detail.mergeCapabilities).toEqual({ merge: false, squash: false, rebase: false });
      expect(listMergeOptions).not.toHaveBeenCalled();
    }).pipe(Effect.provide(providerLayer({ cli: { listMergeOptions } })));
  });

  it.effect("keeps published details when merge option discovery fails", () => {
    const listMergeOptions = vi.fn(() =>
      Effect.fail(
        new CruxCli.CruxCliCommandError({
          operation: "listMergeOptions",
          command: "my",
          cwd: "/workspace/src/Service",
          cause: new Error("temporary failure"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
      });
      expect(detail.changedFiles).toBe(2);
      expect(detail.mergeCapabilities).toEqual({ merge: false, squash: false, rebase: false });
      expect(listMergeOptions).toHaveBeenCalledTimes(1);
    }).pipe(
      Effect.provide(
        providerLayer({
          api: {
            getReview: () =>
              Effect.succeed({ ...review, review: { ...review.review, status: "OPEN" } }),
          },
          cli: { listMergeOptions },
        }),
      ),
    );
  });

  it.effect("returns GitFarm file identities without a flattened patch", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const diff = yield* provider.getDiff({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
      });
      expect(diff.patch).toBe("");
      expect(diff.files).toEqual(diffFiles);
    }).pipe(Effect.provide(providerLayer())),
  );

  it.effect("keeps package tips out of commit history and rejects stale commit selections", () => {
    const getDiffFiles = vi.fn(() => Effect.succeed(diffFiles));
    return Effect.gen(function* () {
      const provider = yield* make;
      const input = {
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
      };
      const activity = yield* provider.getChangeRequestActivity!(input);
      expect(activity.commits).toEqual([]);
      const error = yield* provider.getDiff({ ...input, commit: "tip-service" }).pipe(Effect.flip);
      expect(error.detail).toContain("Select the full review diff");
      expect(getDiffFiles).not.toHaveBeenCalled();
    }).pipe(Effect.provide(providerLayer({ api: { getDiffFiles } })));
  });

  for (const [name, repositories, capabilities] of [
    [
      "intersection",
      [
        { repositoryId: "Service", strategies: ["fast-forward", "squash"] },
        { repositoryId: "Model", strategies: ["fast-forward", "rebase"] },
      ],
      { merge: true, squash: false, rebase: false },
    ],
    [
      "disjoint",
      [
        { repositoryId: "Service", strategies: ["fast-forward"] },
        { repositoryId: "Model", strategies: ["three-way"] },
      ],
      { merge: false, squash: false, rebase: false },
    ],
    [
      "missing package",
      [{ repositoryId: "Service", strategies: ["fast-forward", "squash", "rebase"] }],
      { merge: false, squash: false, rebase: false },
    ],
    ["empty", [], { merge: false, squash: false, rebase: false }],
  ] as const) {
    it.effect(`offers and executes only shared strategies with ${name} options`, () => {
      const mergeReview = vi.fn(() => Effect.void);
      return Effect.gen(function* () {
        const provider = yield* make;
        const input = {
          cwd: "/workspace/src/Service",
          repository: "Service",
          host: "git.amazon.com",
          number: 123456,
        };
        const detail = yield* provider.getChangeRequest(input);
        expect(detail.mergeCapabilities).toEqual(capabilities);
        for (const mergeMethod of ["squash", "rebase", "merge"] as const) {
          const action = provider.runAction({ ...input, action: "merge", mergeMethod });
          if (capabilities[mergeMethod]) yield* action;
          else {
            const error = yield* action.pipe(Effect.flip);
            expect(error.detail).toContain("does not offer the selected merge method");
          }
        }
        expect(mergeReview).toHaveBeenCalledTimes(capabilities.merge ? 1 : 0);
        if (capabilities.merge)
          expect(mergeReview).toHaveBeenCalledWith({
            cwd: input.cwd,
            number: input.number,
            strategy: "fast-forward",
            repositoryIds: ["Service", "Model"],
          });
      }).pipe(
        Effect.provide(
          providerLayer({
            api: {
              getReview: () =>
                Effect.succeed({ ...review, review: { ...review.review, status: "OPEN" } }),
            },
            cli: {
              listMergeOptions: () =>
                Effect.succeed({ crId: "CR-123456", revision: 2, repositories }),
              mergeReview,
            },
          }),
        ),
      );
    });
  }

  it.effect("loads the exact old and new GitFarm blobs", () => {
    const getDiffFileContents = vi.fn(() =>
      Effect.succeed({ oldContents: "old\n", newContents: "new\n" }),
    );
    return Effect.gen(function* () {
      const provider = yield* make;
      const contents = yield* provider.getDiffFileContents!({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
        changeType: "change",
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        packageName: "Service",
        sourceBlobId: "old-service",
        destinationBlobId: "new-service",
      });

      expect(contents).toEqual({ oldContents: "old\n", newContents: "new\n" });
      expect(getDiffFileContents).toHaveBeenCalledWith({
        packageName: "Service",
        sourceBlobId: "old-service",
        destinationBlobId: "new-service",
      });
    }).pipe(Effect.provide(providerLayer({ api: { getDiffFileContents } })));
  });

  it.effect("publishes a draft through CriticService", () => {
    const publishReview = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const provider = yield* make;
      yield* provider.runAction({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
        action: "ready",
      });
      expect(publishReview).toHaveBeenCalledWith({ number: 123456, revision: 2 });
    }).pipe(Effect.provide(providerLayer({ api: { publishReview } })));
  });

  it.effect("keeps merge as a MyCli operation", () => {
    const mergeReview = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const provider = yield* make;
      yield* provider.runAction({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
        action: "merge",
        mergeMethod: "squash",
      });
      expect(mergeReview).toHaveBeenCalledWith({
        cwd: "/workspace/src/Service",
        number: 123456,
        strategy: "squash",
        repositoryIds: ["Service", "Model"],
      });
    }).pipe(
      Effect.provide(
        providerLayer({
          api: {
            getReview: () =>
              Effect.succeed({ ...review, review: { ...review.review, status: "OPEN" } }),
          },
          cli: { mergeReview },
        }),
      ),
    );
  });

  it.effect("does not replace an explicit merge with squash or rebase", () => {
    const mergeReview = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const provider = yield* make;
      const error = yield* provider
        .runAction({
          cwd: "/workspace/src/Service",
          repository: "Service",
          host: "git.amazon.com",
          number: 123456,
          action: "merge",
          mergeMethod: "merge",
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        operation: "runAction",
        detail: "CRUX does not offer the selected merge method for this review.",
      });
      expect(mergeReview).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        providerLayer({
          api: {
            getReview: () =>
              Effect.succeed({ ...review, review: { ...review.review, status: "OPEN" } }),
          },
          cli: {
            listMergeOptions: () =>
              Effect.succeed({
                crId: "CR-123456",
                revision: 2,
                repositories: ["Service", "Model"].map((repositoryId) => ({
                  repositoryId,
                  strategies: ["squash", "rebase"],
                })),
              }),
            mergeReview,
          },
        }),
      ),
    );
  });

  it.effect("uses an available strategy when the caller does not choose one", () => {
    const mergeReview = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const provider = yield* make;
      yield* provider.runAction({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
        action: "merge",
      });
      expect(mergeReview).toHaveBeenCalledWith({
        cwd: "/workspace/src/Service",
        number: 123456,
        strategy: "squash",
        repositoryIds: ["Service", "Model"],
      });
    }).pipe(
      Effect.provide(
        providerLayer({
          api: {
            getReview: () =>
              Effect.succeed({ ...review, review: { ...review.review, status: "OPEN" } }),
          },
          cli: {
            listMergeOptions: () =>
              Effect.succeed({
                crId: "CR-123456",
                revision: 2,
                repositories: ["Service", "Model"].map((repositoryId) => ({
                  repositoryId,
                  strategies: ["squash", "rebase"],
                })),
              }),
            mergeReview,
          },
        }),
      ),
    );
  });

  it.effect("creates and publishes a top-level Critic comment", () => {
    const createComment = vi.fn(() => Effect.void);
    const publishComments = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const provider = yield* make;
      yield* provider.comment({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
        body: "Looks good.",
      });
      expect(createComment).toHaveBeenCalledWith({
        number: 123456,
        revision: 2,
        location: "v4:TOP::::::",
        content: "Looks good.",
        importance: 0,
      });
      expect(publishComments).toHaveBeenCalledWith({ number: 123456, revision: 2 });
    }).pipe(Effect.provide(providerLayer({ api: { createComment, publishComments } })));
  });

  it.effect("publishes multi-package inline feedback once", () => {
    const createComment = vi.fn(() => Effect.void);
    const publishComments = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const provider = yield* make;
      yield* provider.submitReview({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
        verdict: "request-changes",
        body: "",
        comments: [
          {
            path: "Model/src/app.ts",
            position: { kind: "added", newLine: 1 },
            body: "Keep this type private.",
          },
        ],
      });
      expect(createComment).toHaveBeenCalledWith({
        number: 123456,
        revision: 2,
        content: "Keep this type private.",
        importance: 1,
        location: "v4:Model:src/app.ts::1::1:",
      });
      expect(publishComments).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(providerLayer({ api: { createComment, publishComments } })));
  });

  it.effect("replies to and resolves a Critic thread", () => {
    const createComment = vi.fn(() => Effect.void);
    const publishComments = vi.fn(() => Effect.void);
    const updateComment = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const provider = yield* make;
      const threadId = `10|${encodeURIComponent("v4:Service:src/app.ts::8::8:")}`;
      yield* provider.replyToThread({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
        threadId,
        body: "Fixed.",
      });
      yield* provider.setThreadResolution({
        cwd: "/workspace/src/Service",
        repository: "Service",
        host: "git.amazon.com",
        number: 123456,
        threadId,
        resolved: true,
      });

      expect(createComment).toHaveBeenCalledWith({
        number: 123456,
        revision: 2,
        content: "Fixed.",
        importance: 0,
        parent: 10,
        location: "v4:Service:src/app.ts::8::8:",
      });
      expect(publishComments).toHaveBeenCalledTimes(1);
      expect(updateComment).toHaveBeenCalledWith({
        number: 123456,
        revision: 2,
        post: 10,
        location: "v4:Service:src/app.ts::8::8:",
        fixed: true,
      });
    }).pipe(
      Effect.provide(providerLayer({ api: { createComment, publishComments, updateComment } })),
    );
  });
});
