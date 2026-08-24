// @effect-diagnostics nodeBuiltinImport:off - Tests create real temporary filesystem layouts.
import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
} from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

afterEach(() => {
  vi.restoreAllMocks();
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => NodeFSP.rm(directory, { recursive: true })),
  );
});

async function temporaryWorkspace(): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workspace-index-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fileItem(relativePath: string): FileItem {
  return {
    relativePath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size: 1,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

it.effect("filters image searches before applying the result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 200 }, (_, index) => fileItem(`src/file-${index}.ts`)),
        fileItem("public/icon.svg"),
      ];
      const fileSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 25_002 });
    }),
  ),
);

it.effect("preserves unexpected FileFinder creation failures", () =>
  Effect.gen(function* () {
    const cause = new Error("native initialization failed");
    vi.spyOn(FileFinder, "create").mockImplementationOnce(() => {
      throw cause;
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "FileFinder.create threw unexpectedly.",
      cause,
    });
  }),
);

it.effect("falls back to Node when the native index is incompatible", () =>
  Effect.gen(function* () {
    const cwd = yield* Effect.promise(temporaryWorkspace);
    yield* Effect.promise(() =>
      NodeFSP.mkdir(NodePath.join(cwd, "src", "nested"), { recursive: true }),
    );
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(cwd, ".git"), { recursive: true }));
    yield* Effect.promise(() =>
      NodeFSP.mkdir(NodePath.join(cwd, "node_modules", "dependency"), { recursive: true }),
    );
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "README.md"), "readme"));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(cwd, "src", "nested", "SearchIndex.ts"), "code"),
    );
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, ".git", "config"), "ignored"));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(cwd, "node_modules", "dependency", "index.js"), "ignored"),
    );
    vi.spyOn(FileFinder, "create").mockImplementationOnce(() => {
      throw new Error(
        "libfff_c.so: version `GLIBC_2.29' not found (required by ffi-rs.linux-x64-gnu.node)",
      );
    });

    const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
    const listed = yield* searchIndex.list();
    const searched = yield* searchIndex.search("sit", 10);

    expect(listed).toEqual({
      entries: [
        { kind: "file", path: "README.md" },
        { kind: "directory", path: "src" },
        { kind: "directory", path: "src/nested" },
        { kind: "file", path: "src/nested/SearchIndex.ts" },
      ],
      truncated: false,
    });
    expect(searched.entries).toEqual([{ kind: "file", path: "src/nested/SearchIndex.ts" }]);
  }),
);

it.effect("falls back to Node when the native module cannot load", () =>
  Effect.gen(function* () {
    const cwd = yield* Effect.promise(temporaryWorkspace);
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "fallback.txt"), "fallback"));

    const searchIndex = yield* WorkspaceSearchIndex.make(cwd, "paths", {
      loadFileFinderModule: async () => {
        throw new Error("undefined symbol: memfd_create");
      },
    });
    const listed = yield* searchIndex.list();

    expect(listed.entries).toEqual([{ kind: "file", path: "fallback.txt" }]);
  }),
);

it.effect("refreshes the Node fallback and reports content search as unavailable", () =>
  Effect.gen(function* () {
    const cwd = yield* Effect.promise(temporaryWorkspace);
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "before.txt"), "before"));
    vi.spyOn(FileFinder, "create").mockImplementationOnce(() => {
      const error = new Error("native module failed");
      Object.assign(error, { code: "ERR_DLOPEN_FAILED" });
      throw error;
    });

    const searchIndex = yield* WorkspaceSearchIndex.make(cwd, "content");
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "after.txt"), "after"));
    yield* searchIndex.refresh();
    const listed = yield* searchIndex.list();
    const contentError = yield* Effect.flip(
      searchIndex.searchContents({
        query: "after",
        limit: 10,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      }),
    );

    expect(listed.entries).toEqual([
      { kind: "file", path: "after.txt" },
      { kind: "file", path: "before.txt" },
    ]);
    expect(contentError).toMatchObject({
      _tag: "WorkspaceSearchIndexSearchFailed",
      reason:
        "Content search is unavailable because the native workspace index is incompatible with this system.",
    });
  }),
);

it.effect("uses Git files for the fallback and excludes ignored entries", () =>
  Effect.gen(function* () {
    const cwd = yield* Effect.promise(temporaryWorkspace);
    yield* Effect.promise(() => execFileAsync("git", ["init", cwd]));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(cwd, ".gitignore"), "ignored.txt\n"),
    );
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "tracked.txt"), "tracked"));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(cwd, "untracked.txt"), "untracked"),
    );
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(cwd, "ignored.txt"), "ignored"));
    yield* Effect.promise(() =>
      execFileAsync("git", ["-C", cwd, "add", ".gitignore", "tracked.txt"]),
    );
    vi.spyOn(FileFinder, "create").mockImplementationOnce(() => {
      throw new Error("undefined symbol: memfd_create");
    });

    const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
    const listed = yield* searchIndex.list();

    expect(listed.entries).toEqual([
      { kind: "file", path: ".gitignore" },
      { kind: "file", path: "tracked.txt" },
      { kind: "file", path: "untracked.txt" },
    ]);
  }),
);

it.effect("keeps returned FileFinder creation diagnostics out of the cause chain", () =>
  Effect.gen(function* () {
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({
      ok: false,
      error: "native index rejected the directory",
    });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexCreateFailed",
      cwd: "/workspace/project",
      reason: "native index rejected the directory",
    });
    expect(error.cause).toBeUndefined();
  }),
);

it.effect("waits for the full content index warmup before returning", () =>
  Effect.gen(function* () {
    const waitForIndexReady = vi.fn(async () => ({ ok: true as const, value: true }));
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady,
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    yield* Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "content"));

    expect(waitForIndexReady).toHaveBeenCalledWith(15_000);
  }),
);

it.effect("preserves a full-index warmup timeout as a structured error", () =>
  Effect.gen(function* () {
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: false })),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "content")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexScanTimedOut",
      cwd: "/workspace/project",
      timeout: "15 seconds",
    });
  }),
);

it.effect("preserves FileFinder destroy failures as structured defects", () =>
  Effect.gen(function* () {
    const cause = new Error("native destroy failed");
    const finder = {
      destroy: vi.fn(() => {
        throw cause;
      }),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    const exit = yield* Effect.scoped(WorkspaceSearchIndex.make("/workspace/project")).pipe(
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(WorkspaceSearchIndex.WorkspaceSearchIndexDestroyFailed);
      expect(error).toMatchObject({
        _tag: "WorkspaceSearchIndexDestroyFailed",
        cwd: "/workspace/project",
        cause,
      });
    }
  }),
);

it.effect("preserves search and refresh failures with operation context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const searchCause = new Error("native search failed");
      const refreshCause = new Error("native scan failed");
      const contentSearchCause = new Error("native grep failed");
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => {
          throw searchCause;
        }),
        grep: vi.fn(() => {
          throw contentSearchCause;
        }),
        scanFiles: vi.fn(() => {
          throw refreshCause;
        }),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const contentSearchError = yield* Effect.flip(
        searchIndex.searchContents({
          query,
          limit: 3,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        }),
      );
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "FileFinder.mixedSearch threw unexpectedly.",
        cause: searchCause,
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(contentSearchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 3,
        reason: "FileFinder.grep threw unexpectedly.",
        cause: contentSearchCause,
      });
      expect(contentSearchError).not.toHaveProperty("query");
      expect(contentSearchError.message).not.toMatch(/Bearer|secret-token/);
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "FileFinder.scanFiles threw unexpectedly.",
        cause: refreshCause,
      });
    }),
  ),
);

it.effect("keeps returned search diagnostics out of the cause chain", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        mixedSearch: vi.fn(() => ({ ok: false, error: "native query rejected" })),
        scanFiles: vi.fn(() => ({ ok: false, error: "native refresh rejected" })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const query = "authorization: Bearer secret-token";
      const searchError = yield* Effect.flip(searchIndex.search(query, 3));
      const refreshError = yield* Effect.flip(searchIndex.refresh());

      expect(searchError).toMatchObject({
        _tag: "WorkspaceSearchIndexSearchFailed",
        cwd: "/workspace/project",
        queryLength: query.length,
        pageSize: 4,
        reason: "native query rejected",
      });
      expect(searchError).not.toHaveProperty("query");
      expect(searchError.message).not.toMatch(/Bearer|secret-token/);
      expect(searchError.cause).toBeUndefined();
      expect(refreshError).toMatchObject({
        _tag: "WorkspaceSearchIndexRefreshFailed",
        cwd: "/workspace/project",
        reason: "native refresh rejected",
      });
      expect(refreshError.cause).toBeUndefined();
    }),
  ),
);

it.effect("continues whole-word searches after a filtered grep page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nextCursor = {
        __brand: "GrepCursor",
        _offset: 1,
      } as GrepCursor;
      const grepResult = (
        lineContent: string,
        matchRanges: Array<[number, number]>,
        cursor: GrepCursor | null,
      ): GrepResult => ({
        items: [
          {
            relativePath: "src/words.ts",
            fileName: "words.ts",
            gitStatus: "unmodified",
            size: lineContent.length,
            modified: 0,
            isBinary: false,
            totalFrecencyScore: 0,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            lineNumber: 1,
            col: 0,
            byteOffset: 0,
            lineContent,
            matchRanges,
          },
        ],
        totalMatched: 1,
        totalFilesSearched: 1,
        totalFiles: 1,
        filteredFileCount: 1,
        nextCursor: cursor,
      });
      const grep = vi.fn((_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        grep,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", "content");
      const result = yield* searchIndex.searchContents({
        query: "needle",
        limit: 1,
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
      });

      expect(result).toEqual({
        matches: [
          {
            path: "src/words.ts",
            lineNumber: 1,
            lineContent: "needle",
            matchRanges: [{ start: 0, end: 6 }],
          },
        ],
        truncated: false,
      });
      expect(grep).toHaveBeenCalledTimes(2);
      expect(grep.mock.calls[1]?.[1]?.cursor).toBe(nextCursor);
    }),
  ),
);
