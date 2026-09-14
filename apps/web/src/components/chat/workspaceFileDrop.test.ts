import { describe, expect, it, vi } from "@effect/vitest";
import {
  makeWorkspaceFileDropHandlers,
  type WorkspaceFileDragEvent,
  type WorkspaceFileDropHost,
} from "./workspaceFileDrop";

function makeDragEvent(options?: {
  types?: string[];
  files?: File[];
  items?: DataTransferItem[];
  movedWithinTarget?: boolean;
}) {
  const preventDefault = vi.fn();
  const event = {
    dataTransfer: {
      types: options?.types ?? ["Files"],
      files: options?.files ?? [],
      items: options?.items,
      dropEffect: "none",
    },
    relatedTarget: options?.movedWithinTarget ? ({} as EventTarget) : null,
    currentTarget: {
      contains: () => options?.movedWithinTarget ?? false,
    },
    preventDefault,
  } satisfies WorkspaceFileDragEvent;
  return { event, preventDefault };
}

function makeHost() {
  const setDragActive = vi.fn();
  const addFiles = vi.fn();
  const host = { setDragActive, addFiles } satisfies WorkspaceFileDropHost;
  return { host, setDragActive, addFiles };
}

describe("makeWorkspaceFileDropHandlers", () => {
  it("activates the target for an external file drag", () => {
    const { host, setDragActive } = makeHost();
    const { event, preventDefault } = makeDragEvent();

    makeWorkspaceFileDropHandlers(host).onDragEnter(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setDragActive).toHaveBeenCalledWith(true);
  });

  it("ignores non-file drags", () => {
    const { host, setDragActive } = makeHost();
    const { event, preventDefault } = makeDragEvent({ types: ["text/plain"] });

    makeWorkspaceFileDropHandlers(host).onDragOver(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(setDragActive).not.toHaveBeenCalled();
  });

  it("does not flicker when the drag moves between children", () => {
    const { host, setDragActive } = makeHost();
    const { event } = makeDragEvent({ movedWithinTarget: true });

    const handlers = makeWorkspaceFileDropHandlers(host);
    handlers.onDragEnter(event);
    handlers.onDragLeave(event);

    expect(setDragActive).not.toHaveBeenCalled();
  });

  it("forwards dropped files and clears the active state", () => {
    const file = new File(["contents"], "example.txt", { type: "text/plain" });
    const { host, setDragActive, addFiles } = makeHost();
    const { event } = makeDragEvent({ files: [file] });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(setDragActive).toHaveBeenCalledWith(false);
    expect(addFiles).toHaveBeenCalledWith([file]);
  });

  it("archives dropped folders and adds the archive as a file", async () => {
    const plain = new File(["x"], "notes.txt", { type: "text/plain" });
    const placeholder = new File([], "proj", { type: "" });
    const archive = new File(["zip"], "proj.zip", { type: "application/zip" });
    const directoryEntry = {
      name: "proj",
      isDirectory: true,
      isFile: false,
      createReader: () => ({
        readEntries: (onSuccess: (entries: never[]) => void) => onSuccess([]),
      }),
    } as unknown as FileSystemEntry;
    const items = [
      { kind: "file", webkitGetAsEntry: () => directoryEntry },
      { kind: "file", webkitGetAsEntry: () => null },
    ] as unknown as DataTransferItem[];
    const { host, addFiles } = makeHost();
    const onDirectoryArchived = vi.fn();
    const archiver = vi.fn(async () => ({ archive, fileCount: 3 }));
    const { event } = makeDragEvent({ files: [placeholder, plain], items });

    makeWorkspaceFileDropHandlers(
      { ...host, onDirectoryArchived },
      { archiveDirectory: archiver },
    ).onDrop(event);
    await vi.waitFor(() => expect(addFiles).toHaveBeenCalledTimes(2));

    expect(addFiles).toHaveBeenNthCalledWith(1, [plain]);
    expect(addFiles).toHaveBeenNthCalledWith(2, [archive]);
    expect(archiver).toHaveBeenCalledOnce();
    expect(onDirectoryArchived).toHaveBeenCalledWith({
      directoryName: "proj",
      archive,
      fileCount: 3,
    });
  });

  it("reports folders that fail to archive without touching the composer", async () => {
    const directoryEntry = {
      name: "big",
      isDirectory: true,
      isFile: false,
      createReader: () => ({
        readEntries: (onSuccess: (entries: never[]) => void) => onSuccess([]),
      }),
    } as unknown as FileSystemEntry;
    const items = [
      { kind: "file", webkitGetAsEntry: () => directoryEntry },
    ] as unknown as DataTransferItem[];
    const { host, addFiles } = makeHost();
    const onDirectoryError = vi.fn();
    const archiver = vi.fn(async () => {
      throw new Error("Folder 'big' is too large to attach.");
    });
    const { event } = makeDragEvent({ files: [new File([], "big")], items });

    makeWorkspaceFileDropHandlers(
      { ...host, onDirectoryError },
      { archiveDirectory: archiver },
    ).onDrop(event);
    await vi.waitFor(() => expect(onDirectoryError).toHaveBeenCalledOnce());

    expect(onDirectoryError).toHaveBeenCalledWith("Folder 'big' is too large to attach.");
    expect(addFiles).not.toHaveBeenCalled();
  });
});
