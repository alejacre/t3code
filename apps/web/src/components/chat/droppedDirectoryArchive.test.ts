import { describe, expect, it } from "@effect/vitest";
import JSZip from "jszip";
import {
  archiveDroppedDirectory,
  collectDroppedDirectoryFiles,
  type DroppedDirectoryEntry,
  DroppedDirectoryEmptyError,
  type DroppedDirectoryFile,
  type DroppedFileEntry,
  DroppedDirectoryTooLargeError,
  type DroppedEntry,
  partitionDroppedItems,
} from "./droppedDirectoryArchive";

type FakeTree = { readonly [name: string]: string | FakeTree };

function makeFileEntry(name: string, contents: string): DroppedEntry {
  const entry: DroppedFileEntry = {
    name,
    isFile: true,
    isDirectory: false,
    file: async () => new File([contents], name, { type: "text/plain", lastModified: 0 }),
  };
  return entry;
}

/** Emits entries in batches of two and then an empty batch, like the platform reader. */
function makeDirectoryEntry(name: string, tree: FakeTree): DroppedDirectoryEntry {
  const children = Object.entries(tree).map(([childName, value]) =>
    typeof value === "string"
      ? makeFileEntry(childName, value)
      : makeDirectoryEntry(childName, value),
  );
  let cursor = 0;
  return {
    name,
    isFile: false,
    isDirectory: true,
    readEntries: async () => {
      const batch = children.slice(cursor, cursor + 2);
      cursor += batch.length;
      return batch;
    },
  };
}

function relativePaths(files: ReadonlyArray<DroppedDirectoryFile>): string[] {
  return files.map((file) => file.relativePath);
}

describe("collectDroppedDirectoryFiles", () => {
  it("walks nested folders across reader batches in a stable order", async () => {
    const root = makeDirectoryEntry("proj", {
      "z.txt": "z",
      "a.txt": "a",
      "m.txt": "m",
      src: { "index.ts": "export {}", lib: { "util.ts": "" } },
    });

    const files = await collectDroppedDirectoryFiles(root);

    expect(relativePaths(files)).toEqual([
      "a.txt",
      "m.txt",
      "src/index.ts",
      "src/lib/util.ts",
      "z.txt",
    ]);
  });

  it("skips dependency, VCS, and build directories at any depth", async () => {
    const root = makeDirectoryEntry("proj", {
      "keep.txt": "k",
      node_modules: { "left-pad.js": "..." },
      ".git": { HEAD: "ref" },
      src: { dist: { "bundle.js": "..." }, "app.ts": "" },
    });

    const files = await collectDroppedDirectoryFiles(root);

    expect(relativePaths(files)).toEqual(["keep.txt", "src/app.ts"]);
  });

  it("rejects folders whose raw size exceeds the cap", async () => {
    const root = makeDirectoryEntry("big", { "a.txt": "12345", "b.txt": "12345" });

    await expect(collectDroppedDirectoryFiles(root, { maxRawBytes: 8 })).rejects.toBeInstanceOf(
      DroppedDirectoryTooLargeError,
    );
  });

  it("rejects folders with more files than the cap", async () => {
    const root = makeDirectoryEntry("many", { "a.txt": "1", "b.txt": "2", "c.txt": "3" });

    await expect(collectDroppedDirectoryFiles(root, { maxFiles: 2 })).rejects.toBeInstanceOf(
      DroppedDirectoryTooLargeError,
    );
  });

  it("rejects folders that contain no attachable files", async () => {
    const root = makeDirectoryEntry("empty", { node_modules: { "x.js": "" } });

    await expect(collectDroppedDirectoryFiles(root)).rejects.toBeInstanceOf(
      DroppedDirectoryEmptyError,
    );
  });
});

describe("archiveDroppedDirectory", () => {
  it("packs the folder into <name>.zip with paths rooted at the folder name", async () => {
    const root = makeDirectoryEntry("proj", {
      "README.md": "# hi",
      src: { "index.ts": "export const x = 1;" },
    });

    const { archive, fileCount } = await archiveDroppedDirectory(root);

    expect(archive.name).toBe("proj.zip");
    expect(archive.type).toBe("application/zip");
    expect(fileCount).toBe(2);
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    const names = Object.keys(zip.files)
      .filter((name) => !zip.files[name]!.dir)
      .sort();
    expect(names).toEqual(["proj/README.md", "proj/src/index.ts"]);
    expect(await zip.file("proj/src/index.ts")!.async("string")).toBe("export const x = 1;");
  });
});

describe("partitionDroppedItems", () => {
  function makeItem(entry: FileSystemEntry | null): DataTransferItem {
    return { kind: "file", webkitGetAsEntry: () => entry } as unknown as DataTransferItem;
  }

  function makeDirectoryFsEntry(name: string): FileSystemEntry {
    return {
      name,
      isDirectory: true,
      isFile: false,
      createReader: () => ({
        readEntries: (onSuccess: (entries: never[]) => void) => onSuccess([]),
      }),
    } as unknown as FileSystemEntry;
  }

  it("drops the placeholder File Chromium emits for a dropped folder", () => {
    const placeholder = new File([], "proj", { type: "" });
    const plain = new File(["x"], "notes.txt", { type: "text/plain" });

    const result = partitionDroppedItems({
      items: [makeItem(makeDirectoryFsEntry("proj")), makeItem(null)],
      files: [placeholder, plain],
    });

    expect(result.files).toEqual([plain]);
    expect(result.directories.map((directory) => directory.name)).toEqual(["proj"]);
  });

  it("passes every file through when the drop has no directories", () => {
    const plain = new File(["x"], "notes.txt", { type: "text/plain" });

    const result = partitionDroppedItems({ items: undefined, files: [plain] });

    expect(result.files).toEqual([plain]);
    expect(result.directories).toEqual([]);
  });
});
