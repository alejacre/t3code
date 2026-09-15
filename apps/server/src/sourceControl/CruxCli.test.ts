import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  CruxCliAuthenticationError,
  CruxCliCommandError,
  CruxCliDecodeError,
  make,
  parseCruxNumber,
} from "./CruxCli.ts";

const completeMerge = {
  crId: "CR-123456",
  abortedMerges: [],
  failedMerges: [],
  partialMerge: false,
  successfulMerges: [
    { repositoryId: "Service", tipCommits: ["service-tip"] },
    { repositoryId: "Model", tipCommits: ["model-tip"] },
  ],
};

for (const [name, response, errorClass] of [
  ["complete", completeMerge, null],
  ["failed", { ...completeMerge, failedMerges: [{ repositoryId: "Model" }] }, CruxCliCommandError],
  [
    "aborted",
    { ...completeMerge, abortedMerges: [{ repositoryId: "Model" }] },
    CruxCliCommandError,
  ],
  ["partial", { ...completeMerge, partialMerge: true }, CruxCliCommandError],
  [
    "missing package",
    { ...completeMerge, successfulMerges: [completeMerge.successfulMerges[0]] },
    CruxCliCommandError,
  ],
  ["empty", { ...completeMerge, successfulMerges: [] }, CruxCliCommandError],
  ["wrong review", { ...completeMerge, crId: "CR-999" }, CruxCliCommandError],
  ["missing outcome", { crId: "CR-123456" }, CruxCliDecodeError],
  ["malformed", { ...completeMerge, partialMerge: "false" }, CruxCliDecodeError],
] as const) {
  it.effect(`validates an exit-zero ${name} merge response`, () => {
    const run = vi.fn(() =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: JSON.stringify(response),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    );
    return Effect.gen(function* () {
      const cli = yield* make;
      const merge = cli.mergeReview({
        cwd: "/workspace/src/Service",
        number: 123456,
        strategy: "fast-forward",
        repositoryIds: ["Service", "Model"],
      });
      if (errorClass === null) yield* merge;
      else {
        const error = yield* merge.pipe(Effect.flip);
        expect(error).toBeInstanceOf(errorClass);
      }
      expect(run).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
  });
}

it("parses a CR id from CLI output without accepting unrelated numbers", () => {
  expect(parseCruxNumber("Created https://code.amazon.com/reviews/CR-123456")).toBe(123456);
  expect(parseCruxNumber("revision 2")).toBeNull();
});

it.effect("creates a new draft without amending the local commits", () => {
  const run = vi.fn(() =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: "Created https://code.amazon.com/reviews/CR-123456/revisions/1\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* make;
    const number = yield* cli.createReview({
      cwd: "/workspace/src/Service",
      title: "Add CRUX support",
      bodyFile: "/tmp/cr-body.md",
    });

    expect(number).toBe(123456);
    expect(run).toHaveBeenCalledWith({
      operation: "createReview",
      command: "cr",
      args: [
        "--summary",
        "Add CRUX support",
        "--description",
        "/tmp/cr-body.md",
        "--new-review",
        "--no-amend",
        "--no-open",
        "--no-auto-publish",
        "--no-auto-merge",
      ],
      cwd: "/workspace/src/Service",
      timeoutMs: 120_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
  }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
});

it.effect("reads merge strategies without fetching the full review", () => {
  const run = vi.fn(() =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout:
        '{"crId":"CR-123456","revision":2,"repositories":[{"repositoryId":"Service","strategies":["fast-forward","squash"]}]}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* make;
    const options = yield* cli.listMergeOptions({
      cwd: "/workspace/src/Service",
      number: 123456,
      revision: 2,
    });

    expect(options.repositories[0]?.strategies).toEqual(["fast-forward", "squash"]);
    expect(run).toHaveBeenCalledWith({
      operation: "listMergeOptions",
      command: "my",
      args: ["cr", "list-merge-options", "--id", "CR-123456", "--revision", "2"],
      cwd: "/workspace/src/Service",
      timeoutMs: 60_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
  }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
});

it.effect("lists the current user's open review index without package scoping", () => {
  const run = vi.fn(() =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: JSON.stringify({
        codeReviews: [
          {
            id: "CR-123456",
            createdAt: 1_788_739_100,
            revision: {
              author: { id: "sidkvmar", type: "HUMAN" },
              createdAt: 1_788_739_200,
              packageNames: ["Service", "Model"],
              state: "DRAFT",
              title: "Add CRUX integration",
            },
          },
        ],
        truncated: false,
      }),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* make;
    const reviews = yield* cli.listUserOpenReviews({
      cwd: "/workspace/src/Service",
      viewer: "sidkvmar",
    });

    expect(reviews).toEqual({
      codeReviews: [
        {
          id: "CR-123456",
          createdAt: 1_788_739_100,
          revision: {
            author: { id: "sidkvmar" },
            createdAt: 1_788_739_200,
            packageNames: ["Service", "Model"],
            state: "DRAFT",
            title: "Add CRUX integration",
          },
        },
      ],
      truncated: false,
    });
    expect(run).toHaveBeenCalledWith({
      operation: "listUserOpenReviews",
      command: "my",
      args: ["cr", "list-reviews", "--user", "sidkvmar", "--status", "open"],
      cwd: "/workspace/src/Service",
      timeoutMs: 60_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
  }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
});

it.effect("retries one unreadable account review response", () => {
  let calls = 0;
  const run = vi.fn(() => {
    calls += 1;
    return Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: calls === 1 ? "not json" : '{"codeReviews":[],"truncated":false}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  return Effect.gen(function* () {
    const cli = yield* make;
    const reviews = yield* cli.listUserOpenReviews({
      cwd: "/workspace/src/Service",
      viewer: "sidkvmar",
    });

    expect(reviews.codeReviews).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
});

it.effect("keeps authentication errors fatal even when the requested package succeeds", () => {
  const run = vi.fn((input: { readonly operation: string }) =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout:
        input.operation === "listOpenReviews"
          ? JSON.stringify({
              Service: [{ crId: "CR-123456" }],
              OtherPackage: { error: "Run mwinit and retry." },
            })
          : '{"codeReviews":[]}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* make;
    const error = yield* cli
      .listOpenReviews({
        cwd: "/workspace/src/Service",
        packageName: "Service",
        viewer: "sidkvmar",
      })
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(CruxCliAuthenticationError);
  }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
});

it.effect("fails when the requested package has a non-auth list error", () => {
  const run = vi.fn((input: { readonly operation: string }) =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout:
        input.operation === "listOpenReviews"
          ? '{"Service":{"error":"Package is not available."}}'
          : '{"codeReviews":[]}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* make;
    const error = yield* cli
      .listOpenReviews({
        cwd: "/workspace/src/Service",
        packageName: "Service",
        viewer: "sidkvmar",
      })
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(CruxCliCommandError);
  }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
});

it.effect("ignores unrelated package non-auth errors", () => {
  const run = vi.fn((input: { readonly operation: string }) =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout:
        input.operation === "listOpenReviews"
          ? JSON.stringify({
              Service: [{ crId: "CR-123456", author: "sidkvmar" }],
              OtherPackage: { error: "Package is not available." },
            })
          : '{"codeReviews":[]}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* make;
    const reviews = yield* cli.listOpenReviews({
      cwd: "/workspace/src/Service",
      packageName: "Service",
      viewer: "sidkvmar",
    });

    expect(reviews).toEqual([{ crId: "CR-123456", author: "sidkvmar" }]);
  }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
});

it.effect("uses a sole differently keyed CRUX review list", () => {
  const run = vi.fn((input: { readonly operation: string }) =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout:
        input.operation === "listOpenReviews"
          ? '{"pkg/Service":[{"crId":"CR-123456","author":"sidkvmar"}]}'
          : '{"codeReviews":[]}',
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* make;
    const reviews = yield* cli.listOpenReviews({
      cwd: "/workspace/src/Service",
      packageName: "Service",
      viewer: "sidkvmar",
    });

    expect(reviews).toEqual([{ crId: "CR-123456", author: "sidkvmar" }]);
  }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
});

it.effect("merges authored drafts by CR id and prefers pending fields", () => {
  const run = vi.fn((input: { readonly operation: string }) =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout:
        input.operation === "listOpenReviews"
          ? JSON.stringify({
              Service: [
                { crId: "CR-1", author: "reviewer", summary: "Published review" },
                { crId: "CR-2", author: "reviewer", summary: "Stale package row" },
              ],
            })
          : JSON.stringify({
              codeReviews: [
                { id: "CR-2", summary: "Current draft", status: "PENDING" },
                { id: "CR-3", summary: "Draft only", status: "PENDING" },
              ],
            }),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );

  return Effect.gen(function* () {
    const cli = yield* make;
    const reviews = yield* cli.listOpenReviews({
      cwd: "/workspace/src/Service",
      packageName: "Service",
      viewer: "sidkvmar",
    });

    expect(reviews).toHaveLength(3);
    expect(reviews.find((item) => item.crId === "CR-1")).toMatchObject({
      author: "reviewer",
      summary: "Published review",
    });
    expect(reviews.find((item) => item.id === "CR-2")).toMatchObject({
      author: "sidkvmar",
      summary: "Current draft",
      status: "PENDING",
    });
    expect(reviews.find((item) => item.id === "CR-3")).toMatchObject({
      author: "sidkvmar",
      summary: "Draft only",
      status: "PENDING",
    });
    expect(run).toHaveBeenCalledWith({
      operation: "listOpenReviews",
      command: "my",
      args: ["cr", "list-open-reviews", "--packages", "Service"],
      cwd: "/workspace/src/Service",
      timeoutMs: 60_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
    expect(run).toHaveBeenCalledWith({
      operation: "listPendingReviews",
      command: "my",
      args: [
        "cr",
        "list-reviews",
        "--user",
        "sidkvmar",
        "--status",
        "pending",
        "--direction",
        "from",
      ],
      cwd: "/workspace/src/Service",
      timeoutMs: 60_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
  }).pipe(Effect.provide(Layer.mock(VcsProcess.VcsProcess)({ run })));
});
