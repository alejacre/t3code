import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeOS from "node:os";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CruxApi from "./CruxApi.ts";
import * as CruxCli from "./CruxCli.ts";
import { MidwayCoralAuthenticationError, MidwayCoralRequestError } from "./MidwayCoralClient.ts";
import { make, parseCruxAuth } from "./CruxSourceControlProvider.ts";

const viewer = process.env.USER?.trim() || NodeOS.userInfo().username;

function review(author: string, number: number): CruxApi.CruxReview {
  return {
    snapshot: {
      id: `snapshot-${number}`,
      auto_publish: false,
      status: "OPEN",
      approved_by: [],
      packages: [
        {
          package_name: "T3CodeAmazonInternal",
          base_commit: "base",
          tip_commit: "tip",
          local_branch: "feature/crux",
          gitfarm_branch: "mainline",
        },
      ],
    },
    review: {
      crId: `CR-${number}`,
      revision: 1,
      summary: `Review ${number}`,
      status: "OPEN",
      author,
      approved_by: [],
    },
    reviewers: [],
    analyzers: [],
    comments: [],
  };
}

function providerLayer(options?: {
  readonly api?: Partial<CruxApi.CruxApi["Service"]>;
  readonly cli?: Partial<CruxCli.CruxCli["Service"]>;
}) {
  return Layer.merge(
    Layer.mock(CruxApi.CruxApi)({
      getReview: ({ number }) => Effect.succeed(review(viewer, number)),
      ...options?.api,
    }),
    Layer.mock(CruxCli.CruxCli)({
      listOpenReviews: () => Effect.succeed([]),
      listUserOpenReviews: () => Effect.succeed({ codeReviews: [], truncated: false }),
      createReview: () => Effect.succeed(42),
      listMergeOptions: () => Effect.succeed({ crId: "CR-42", revision: 1, repositories: [] }),
      ...options?.cli,
    }),
  );
}

it("treats an exit-zero CRUX error payload as unauthenticated", () => {
  expect(
    parseCruxAuth({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: '{"T3CodeAmazonInternal":{"error":"Run `mwinit` and retry."}}',
      stderr: "",
    }).status,
  ).toBe("unauthenticated");
});

it("does not report a non-auth CRUX list error as an expired Midway session", () => {
  const auth = parseCruxAuth({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: '{"T3CodeAmazonInternal":{"error":"Package is not available."}}',
    stderr: "",
  });

  expect(auth.status).toBe("unknown");
  expect(Option.getOrNull(auth.detail)).toBe("Package is not available.");
});

it.effect("matches branches with Critic metadata for reviews authored by the current user", () => {
  const getReview = vi.fn(({ number }: { readonly number: number }) =>
    Effect.succeed(review(number === 2 ? viewer : "other-user", number)),
  );
  const listOpenReviews = vi.fn(() =>
    Effect.succeed([
      { author: "other-user", crId: "CR-1" },
      { author: viewer, crId: "CR-2" },
    ]),
  );

  return Effect.gen(function* () {
    const provider = yield* make;
    const matches = yield* provider.listChangeRequests({
      cwd: "/workspace/T3CodeAmazonInternal",
      headSelector: "feature/crux",
      state: "open",
      limit: 20,
    });

    expect(matches.map((item) => item.number)).toEqual([2]);
    expect(getReview).toHaveBeenCalledTimes(1);
    expect(getReview).toHaveBeenCalledWith({ number: 2 });
    expect(listOpenReviews).toHaveBeenCalledWith({
      cwd: "/workspace/T3CodeAmazonInternal",
      packageName: "T3CodeAmazonInternal",
      viewer,
    });
  }).pipe(
    Effect.provide(
      providerLayer({
        api: { getReview },
        cli: { listOpenReviews },
      }),
    ),
  );
});

it.effect("filters hydrated pending reviews back to the current package", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const matches = yield* provider.listChangeRequests({
      cwd: "/workspace/T3CodeAmazonInternal",
      headSelector: "feature/crux",
      state: "open",
      limit: 20,
    });

    expect(matches).toEqual([]);
  }).pipe(
    Effect.provide(
      providerLayer({
        api: {
          getReview: () => {
            const pending = review(viewer, 2);
            return Effect.succeed({
              ...pending,
              snapshot: {
                ...pending.snapshot,
                packages: pending.snapshot.packages.map((snapshotPackage) => ({
                  ...snapshotPackage,
                  package_name: "OtherPackage",
                })),
              },
            });
          },
        },
        cli: {
          listOpenReviews: () =>
            Effect.succeed([{ author: viewer, id: "CR-2", status: "PENDING" }]),
        },
      }),
    ),
  ),
);

it.effect("uses the matching package's branches for list, lookup, and creation", () => {
  const detail = review(viewer, 42);
  const multiPackageReview: CruxApi.CruxReview = {
    ...detail,
    snapshot: {
      ...detail.snapshot,
      packages: [
        {
          ...detail.snapshot.packages[0]!,
          package_name: "OtherPackage",
          local_branch: "other-feature",
        },
        {
          ...detail.snapshot.packages[0]!,
          gitfarm_branch: "release",
          local_branch: "feature/crux",
        },
      ],
    },
  };
  // The worktree directory differs from the package name; repository context is authoritative.
  const context = {
    provider: { kind: "crux" as const, name: "CRUX", baseUrl: "https://code.amazon.com" },
    remoteName: "origin",
    remoteUrl: "ssh://git.amazon.com/pkg/T3CodeAmazonInternal",
  };
  return Effect.gen(function* () {
    const provider = yield* make;
    const matches = yield* provider.listChangeRequests({
      cwd: "/worktree/custom",
      context,
      headSelector: "feature/crux",
      state: "open",
    });
    expect(matches).toHaveLength(1);
    const fetched = yield* provider.getChangeRequest({
      cwd: "/worktree/custom",
      context,
      reference: "CR-42",
    });
    const created = yield* provider.createChangeRequest({
      cwd: "/worktree/custom",
      context,
      headSelector: "feature/crux",
      baseRefName: "release",
      title: "Change both packages",
      bodyFile: "/tmp/cr-body.md",
    });
    for (const result of [matches[0], fetched, created]) {
      expect(result).toMatchObject({
        number: 42,
        headRefName: "feature/crux",
        baseRefName: "release",
        isCrossRepository: true,
      });
    }
    const wrongBranch = yield* provider.listChangeRequests({
      cwd: "/worktree/custom",
      context,
      headSelector: "other-feature",
      state: "open",
    });
    expect(wrongBranch).toEqual([]);
  }).pipe(
    Effect.provide(
      providerLayer({
        api: { getReview: () => Effect.succeed(multiPackageReview) },
        cli: { listOpenReviews: () => Effect.succeed([{ author: viewer, crId: "CR-42" }]) },
      }),
    ),
  );
});

it.effect("finds a matching package after the old twenty-review cap", () => {
  const getReview = vi.fn(({ number }: { readonly number: number }) => {
    const detail = review(viewer, number);
    return Effect.succeed(
      number === 21
        ? detail
        : {
            ...detail,
            snapshot: {
              ...detail.snapshot,
              packages: detail.snapshot.packages.map((snapshotPackage) => ({
                ...snapshotPackage,
                package_name: "OtherPackage",
              })),
            },
          },
    );
  });

  return Effect.gen(function* () {
    const provider = yield* make;
    const matches = yield* provider.listChangeRequests({
      cwd: "/workspace/T3CodeAmazonInternal",
      headSelector: "feature/crux",
      state: "open",
      limit: 20,
    });

    expect(matches.map((item) => item.number)).toEqual([21]);
    expect(getReview).toHaveBeenCalledTimes(21);
  }).pipe(
    Effect.provide(
      providerLayer({
        api: { getReview },
        cli: {
          listOpenReviews: () =>
            Effect.succeed(
              Array.from({ length: 21 }, (_, index) => ({
                author: viewer,
                id: `CR-${index + 1}`,
                status: "PENDING",
              })),
            ),
        },
      }),
    ),
  );
});

it.effect("does not use another author's review when a list row claims the current viewer", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const matches = yield* provider.listChangeRequests({
      cwd: "/workspace/T3CodeAmazonInternal",
      headSelector: "feature/crux",
      state: "open",
      limit: 20,
    });
    expect(matches).toEqual([]);
  }).pipe(
    Effect.provide(
      providerLayer({
        api: { getReview: () => Effect.succeed(review("other-user", 1)) },
        cli: { listOpenReviews: () => Effect.succeed([{ author: viewer, crId: "CR-1" }]) },
      }),
    ),
  ),
);

it.effect("stops after the first bounded batch containing a matching CRUX branch", () => {
  const getReview = vi.fn(({ number }: { readonly number: number }) =>
    Effect.succeed(review(viewer, number)),
  );

  return Effect.gen(function* () {
    const provider = yield* make;
    const matches = yield* provider.listChangeRequests({
      cwd: "/workspace/T3CodeAmazonInternal",
      headSelector: "feature/crux",
      state: "open",
      limit: 20,
    });

    expect(matches.map((item) => item.number)).toEqual([1]);
    expect(getReview).toHaveBeenCalledTimes(4);
  }).pipe(
    Effect.provide(
      providerLayer({
        api: { getReview },
        cli: {
          listOpenReviews: () =>
            Effect.succeed(
              Array.from({ length: 12 }, (_, index) => ({
                author: viewer,
                crId: `CR-${index + 1}`,
              })),
            ),
        },
      }),
    ),
  );
});

it.effect("skips a listed review whose Critic response has a malformed id", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const matches = yield* provider.listChangeRequests({
      cwd: "/workspace/T3CodeAmazonInternal",
      headSelector: "feature/crux",
      state: "open",
      limit: 20,
    });
    expect(matches).toEqual([]);
  }).pipe(
    Effect.provide(
      providerLayer({
        api: {
          getReview: () =>
            Effect.succeed({
              ...review(viewer, 2),
              review: { ...review(viewer, 2).review, crId: "not-a-review" },
            }),
        },
        cli: { listOpenReviews: () => Effect.succeed([{ author: viewer, crId: "CR-2" }]) },
      }),
    ),
  ),
);

it.effect("skips a listed review whose Critic response cannot be decoded", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const matches = yield* provider.listChangeRequests({
      cwd: "/workspace/T3CodeAmazonInternal",
      headSelector: "feature/crux",
      state: "open",
      limit: 20,
    });
    expect(matches).toEqual([]);
  }).pipe(
    Effect.provide(
      providerLayer({
        api: {
          getReview: () =>
            Effect.fail(
              new CruxApi.CruxApiDecodeError({
                operation: "GetRevision",
                cause: new Error("invalid response"),
              }),
            ),
        },
        cli: { listOpenReviews: () => Effect.succeed([{ author: viewer, crId: "CR-2" }]) },
      }),
    ),
  ),
);

it.effect("surfaces stale Midway while hydrating listed reviews", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const error = yield* provider
      .listChangeRequests({
        cwd: "/workspace/T3CodeAmazonInternal",
        headSelector: "feature/crux",
        state: "open",
        limit: 20,
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({
      _tag: "SourceControlProviderError",
      operation: "listChangeRequests",
      cause: { _tag: "MidwayCoralAuthenticationError" },
    });
  }).pipe(
    Effect.provide(
      providerLayer({
        api: {
          getReview: () =>
            Effect.fail(
              new MidwayCoralAuthenticationError({
                endpoint: "https://critic-service-sso.corp.amazon.com",
              }),
            ),
        },
        cli: { listOpenReviews: () => Effect.succeed([{ author: viewer, crId: "CR-2" }]) },
      }),
    ),
  ),
);

it.effect("surfaces service outages while hydrating listed reviews", () =>
  Effect.gen(function* () {
    const provider = yield* make;
    const error = yield* provider
      .listChangeRequests({
        cwd: "/workspace/T3CodeAmazonInternal",
        headSelector: "feature/crux",
        state: "open",
        limit: 20,
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({
      _tag: "SourceControlProviderError",
      operation: "listChangeRequests",
      cause: { _tag: "MidwayCoralRequestError", status: 503 },
    });
  }).pipe(
    Effect.provide(
      providerLayer({
        api: {
          getReview: () =>
            Effect.fail(
              new MidwayCoralRequestError({
                endpoint: "https://critic-service-sso.corp.amazon.com",
                operation: "GetRevision",
                status: 503,
              }),
            ),
        },
        cli: { listOpenReviews: () => Effect.succeed([{ author: viewer, crId: "CR-2" }]) },
      }),
    ),
  ),
);

it.effect("returns the exact draft read from Critic after the CRUX CLI creates it", () => {
  const created = review(viewer, 42);
  return Effect.gen(function* () {
    const provider = yield* make;
    const result = yield* provider.createChangeRequest({
      cwd: "/workspace/T3CodeAmazonInternal",
      baseRefName: "mainline",
      headSelector: "feature/crux",
      title: "Add CRUX support",
      bodyFile: "/tmp/cr-body.md",
    });

    expect(result).toEqual({
      provider: "crux",
      number: 42,
      title: "Review 42",
      url: "https://code.amazon.com/reviews/CR-42",
      baseRefName: "mainline",
      headRefName: "feature/crux",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: false,
    });
  }).pipe(
    Effect.provide(
      providerLayer({
        api: { getReview: () => Effect.succeed(created) },
        cli: { createReview: () => Effect.succeed(42) },
      }),
    ),
  );
});
