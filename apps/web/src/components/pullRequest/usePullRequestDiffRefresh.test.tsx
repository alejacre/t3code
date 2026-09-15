import { act, useRef, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cruxDiffFileKey } from "./pullRequestCruxDiff.logic";
import { usePullRequestDiffRefresh } from "./usePullRequestDiffRefresh";

const backend = {
  packageName: "ExamplePackage",
  sourcePath: "backend/api/AGENTS.md",
  destinationPath: "backend/api/AGENTS.md",
  sourceBlobId: "old-blob",
  destinationBlobId: "new-blob",
  status: "M",
};
const backendKey = cruxDiffFileKey(backend);
const fileKeys = ["AUTOSDE.yaml", backendKey];
interface Snapshot {
  files: ReadonlyArray<string>;
  loaded: ReadonlyMap<string, string>;
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
}
interface Controls {
  snapshot: Snapshot;
  receive: (files: ReadonlyArray<string>) => void;
  expand: (file: string, contents: Promise<string>) => Promise<void>;
}
const empty = (): Snapshot => ({
  files: [],
  loaded: new Map(),
  expanded: new Set(),
  loading: new Set(),
});

// Exercise the real refresh lifecycle with a pending immutable-blob load. No timers,
// transport, filesystem, browser or viewer virtualization is needed to reproduce the reset.
function Harness({
  scopeKey,
  token,
  capture,
  reset,
  refresh,
}: {
  scopeKey: string;
  token: number;
  capture: (controls: Controls) => void;
  reset: () => void;
  refresh: () => void;
}) {
  const [snapshot, setSnapshot] = useState(empty);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  usePullRequestDiffRefresh({
    scopeKey,
    refreshToken: token,
    resetScope: () => {
      reset();
      setSnapshot(empty());
    },
    revalidate: refresh,
  });
  capture({
    snapshot,
    receive: (files) => setSnapshot((previous) => ({ ...previous, files })),
    expand: async (file, contents) => {
      setSnapshot((previous) => ({ ...previous, loading: new Set(previous.loading).add(file) }));
      const text = await contents;
      if (currentScope.current !== scopeKey) return;
      setSnapshot((previous) => ({
        ...previous,
        loaded: new Map(previous.loaded).set(file, text),
        expanded: new Set(previous.expanded).add(file),
        loading: new Set([...previous.loading].filter((key) => key !== file)),
      }));
    },
  });
  return null;
}

let renderer: ReactTestRenderer | undefined;
let controls: Controls | undefined;
const reset = vi.fn();
const refresh = vi.fn();
const capture = (value: Controls) => {
  controls = value;
};
function current() {
  if (controls === undefined) throw new Error("Harness is not mounted");
  return controls;
}
async function render(scopeKey: string, token: number) {
  await act(() => {
    const element = (
      <Harness
        scopeKey={scopeKey}
        token={token}
        capture={capture}
        reset={reset}
        refresh={refresh}
      />
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reset.mockClear();
  refresh.mockClear();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  controls = undefined;
  vi.unstubAllGlobals();
});

describe("CRUX Code tab refresh lifecycle", () => {
  it("keeps two files and an in-flight expansion through three unrelated turn refreshes", async () => {
    await render("cloud:review-42:all", 0);
    await act(() => current().receive(fileKeys));
    let finish!: (text: string) => void;
    const contents = new Promise<string>((resolve) => {
      finish = resolve;
    });
    let loading!: Promise<void>;
    await act(() => {
      loading = current().expand(backendKey, contents);
    });
    for (const token of [1, 2, 3]) {
      await render("cloud:review-42:all", token);
      expect(current().snapshot.files).toEqual(fileKeys);
      expect(current().snapshot.loading.has(backendKey)).toBe(true);
    }
    await act(async () => {
      finish("complete old/new blob diff");
      await loading;
    });
    expect(current().snapshot.loaded.get(backendKey)).toBe("complete old/new blob diff");
    expect(current().snapshot.expanded.has(backendKey)).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    await render("cloud:review-42:all", 4);
    expect(current().snapshot.files).toEqual(fileKeys);
    expect(current().snapshot.expanded.has(backendKey)).toBe(true);
    expect(current().snapshot.loaded.has(backendKey)).toBe(true);
  });

  it("does not reset or reread for new callback identities with the same scope and token", async () => {
    await render("cloud:review-42:all", 8);
    await act(() => current().receive(fileKeys));
    const snapshot = current().snapshot;
    await render("cloud:review-42:all", 8);
    expect(current().snapshot).toBe(snapshot);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["local:review-42:all", "cloud:review-43:all", "cloud:review-42:commit-2"])(
    "discards prior state only when the environment/review/commit changes to %s",
    async (scope) => {
      await render("cloud:review-42:all", 0);
      await act(() => current().receive(fileKeys));
      let finish!: (text: string) => void;
      const contents = new Promise<string>((resolve) => {
        finish = resolve;
      });
      let loading!: Promise<void>;
      await act(() => {
        loading = current().expand(backendKey, contents);
      });
      await render(scope, 1);
      await act(async () => {
        finish("old scope response");
        await loading;
      });
      expect(current().snapshot).toEqual(empty());
      expect(reset).toHaveBeenCalledTimes(2);
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it("uses new blob IDs for a changed page without reusing the old expanded model", async () => {
    await render("cloud:review-42:all", 0);
    await act(() => current().receive(fileKeys));
    await act(async () => {
      await current().expand(backendKey, Promise.resolve("revision 1"));
    });
    await render("cloud:review-42:all", 1);
    const changedKey = cruxDiffFileKey({ ...backend, destinationBlobId: "revision-2-blob" });
    await act(() => current().receive(["AUTOSDE.yaml", changedKey]));
    expect(current().snapshot.files).toHaveLength(2);
    expect(current().snapshot.loaded.has(changedKey)).toBe(false);
    expect(current().snapshot.expanded.has(changedKey)).toBe(false);
    expect(changedKey).not.toBe(backendKey);
  });
});
