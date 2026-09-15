import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerConfig,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Option from "effect/Option";

// Replace only connection snapshots. Exercise the production adapter and real atom registry;
// record reads when subscribed, not when an unused query atom is merely constructed.
vi.mock("./primaryEnvironment", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(null) };
});
vi.mock("./projects", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentProjects: { projectsAtom: Atom.make([]) } };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});

import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import { withAmazonReviewReader } from "./amazonReviews";

type Base = Parameters<typeof withAmazonReviewReader>[0];
type RecordedTarget = { readonly environmentId: EnvironmentId; readonly input: unknown };
type Event = { operation: string; target: RecordedTarget };
const local = EnvironmentId.make("local-reader");
const remote = EnvironmentId.make("cloud-desktop");
const project: EnvironmentProject = {
  environmentId: remote,
  id: ProjectId.make("shared-id"),
  title: "Remote package",
  workspaceRoot: "/remote/src/ExamplePackage",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  repositoryIdentity: {
    canonicalKey: "git.amazon.com/pkg/examplepackage",
    provider: "unknown",
    name: "examplepackage",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "ssh://git.amazon.com/pkg/ExamplePackage",
    },
  },
};
const target = {
  environmentId: remote,
  input: {
    projectId: project.id,
    repository: "ExamplePackage",
    number: 42,
    host: "code.amazon.com",
  },
};
const metadata = {
  environmentId: remote,
  projectId: project.id,
  repository: "ExamplePackage",
  title: project.title,
  workspaceRoot: project.workspaceRoot,
};
const writes = [
  "runAction",
  "update",
  "comment",
  "updateComment",
  "submitReview",
  "replyToThread",
  "requestReviewers",
  "setLabels",
  "setThreadResolution",
  "setReaction",
] as const satisfies ReadonlyArray<keyof Base>;
const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => registries.splice(0).forEach((registry) => registry.dispose()));

function config(enabled: boolean, compatible: boolean | undefined): ServerConfig {
  // The adapter consumes only these two config fields; no auth/session services are mocked.
  return {
    settings: { ...DEFAULT_SERVER_SETTINGS, amazonBetaEnabled: enabled },
    environment: {
      environmentId: local,
      label: "Reader",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "test",
      capabilities: {
        repositoryIdentity: true,
        pullRequests: true,
        ...(compatible === undefined ? {} : { amazonReadConnector: compatible }),
      },
    },
  } as ServerConfig;
}

function fixture(
  options: {
    enabled?: boolean;
    compatible?: boolean;
    noPrimary?: boolean;
    missingCapability?: boolean;
  } = {},
) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  // These module exports are writable snapshot atoms in this test only.
  registry.set(
    primaryEnvironmentIdAtom as Atom.Writable<EnvironmentId | null>,
    options.noPrimary ? null : local,
  );
  registry.set(
    environmentProjects.projectsAtom as Atom.Writable<ReadonlyArray<EnvironmentProject>>,
    [
      {
        ...project,
        environmentId: local,
        title: "Local project with the same ID",
        workspaceRoot: "/local/clone",
      },
      project,
    ],
  );
  const setConfig = (enabled: boolean, compatible: boolean | undefined) =>
    registry.set(
      environmentServerConfigsAtom as Atom.Writable<ReadonlyMap<EnvironmentId, ServerConfig>>,
      // A compatible secondary must not silently replace the selected primary.
      new Map([
        [local, config(enabled, compatible)],
        [remote, config(true, true)],
      ]),
    );
  setConfig(
    options.enabled ?? true,
    options.missingCapability ? undefined : (options.compatible ?? true),
  );
  const events: Event[] = [];
  const read = (operation: string) => (request: RecordedTarget) =>
    Atom.make(() => {
      events.push({ operation, target: request });
      return AsyncResult.success({ operation, reader: request.environmentId });
    });
  const command = (operation: string): AtomCommand<RecordedTarget, void, never> => ({
    label: operation,
    run: async (_registry, request) => {
      events.push({ operation, target: request });
      return AsyncResult.success(undefined);
    },
  });
  // Transport double: native payload codecs are covered by the RPC/service suites. This
  // suite records the effective dispatch destination and opaque payload of the adapter.
  const base = {
    detail: read("detail"),
    activity: read("activity"),
    diff: read("diff"),
    list: (request: RecordedTarget) =>
      Atom.make(() => {
        events.push({ operation: "list", target: request });
        return AsyncResult.success({
          viewers: { "code.amazon.com": "local-account" },
          providers: [],
          entries: [],
          errors: [],
          truncated: false,
          nextCursors: {},
        });
      }),
    listStats: read("listStats"),
    diffFileContents: command("diffFileContents"),
    threadComments: command("threadComments"),
    ...Object.fromEntries(writes.map((operation) => [operation, command(operation)])),
  } as unknown as Base;
  return { registry, setConfig, events, base, adapter: withAmazonReviewReader(base) };
}

describe("Amazon native review adapter", () => {
  it.each(["detail", "activity", "diff"] as const)(
    "dispatches %s to the opted-in primary and preserves origin metadata",
    (operation) => {
      const { registry, adapter, events } = fixture();
      const result = registry.get<AsyncResult.AsyncResult<unknown, unknown>>(
        adapter[operation](target),
      );
      expect(Option.getOrNull(AsyncResult.value(result))).toEqual({ operation, reader: local });
      expect(events).toEqual([
        {
          operation,
          target: {
            environmentId: local,
            input: { ...target.input, amazonProject: metadata },
          },
        },
      ]);
      expect(target.input).not.toHaveProperty("amazonProject");
    },
  );

  it("lists remote packages once through the primary without probing the execution provider", () => {
    const { registry, adapter, events } = fixture();
    registry.get(adapter.list({ environmentId: remote, input: { state: "open" } }));
    expect(events).toEqual([
      {
        operation: "list",
        target: {
          environmentId: local,
          input: { state: "open", host: "code.amazon.com", amazonProjects: [metadata] },
        },
      },
    ]);
  });

  it.each([
    { enabled: false },
    { compatible: false },
    { missingCapability: true },
    { noPrimary: true },
  ])("keeps native dispatch without an opted-in compatible primary: %j", (options) => {
    const { registry, adapter, events } = fixture(options);
    registry.get(adapter.detail(target));
    registry.get(adapter.list({ environmentId: remote, input: { state: "open" } }));
    expect(events).toEqual([
      { operation: "detail", target },
      { operation: "list", target: { environmentId: remote, input: { state: "open" } } },
    ]);
  });

  it("re-evaluates opt-out on a mounted read instead of retaining the central target", () => {
    const { registry, adapter, events, setConfig } = fixture();
    const atom = adapter.detail(target);
    registry.mount(atom);
    registry.get(atom);
    events.length = 0;
    setConfig(false, true);
    expect(Option.getOrNull(AsyncResult.value(registry.get(atom)))).toEqual({
      operation: "detail",
      reader: remote,
    });
    expect(events).toEqual([{ operation: "detail", target }]);
  });

  it.each(["diffFileContents", "threadComments"] as const)(
    "routes the read command %s, rechecking opt-out at invocation",
    async (operation) => {
      const { registry, adapter, events, setConfig } = fixture();
      const command = adapter[operation] as unknown as AtomCommand<RecordedTarget, unknown, unknown>;
      const request = {
        ...target,
        input: { ...target.input, cursor: "page-2", sourceBlobId: "blob-1" },
      };
      await command.run(registry, request);
      setConfig(false, true);
      await command.run(registry, request);
      expect(events).toEqual([
        {
          operation,
          target: { environmentId: local, input: { ...request.input, amazonProject: metadata } },
        },
        { operation, target: request },
      ]);
    },
  );

  it.each(writes)("never reroutes native write %s", async (operation) => {
    const { registry, adapter, events } = fixture();
    const request = {
      ...target,
      input: { ...target.input, action: "merge", body: "unsent", verdict: "approve" },
    };
    const command = adapter[operation] as unknown as AtomCommand<RecordedTarget, unknown, unknown>;
    await command.run(registry, request);
    expect(events).toEqual([{ operation, target: request }]);
    expect(events[0]?.target.input).not.toHaveProperty("amazonProject");
  });

  it("leaves GitHub reads and writes untouched for the existing account-guarded router", async () => {
    const { registry, adapter, events } = fixture();
    const github = {
      ...target,
      input: {
        ...target.input,
        host: "github.com",
        repository: "owner/repo",
        expectedAccountId: "account-123",
      },
    };
    registry.get(adapter.detail(github));
    await adapter.comment.run(registry, { ...github, input: { ...github.input, body: "unsent" } });
    expect(events).toEqual([
      { operation: "detail", target: github },
      { operation: "comment", target: { ...github, input: { ...github.input, body: "unsent" } } },
    ]);
  });
});
