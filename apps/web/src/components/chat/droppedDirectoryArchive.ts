import JSZip from "jszip";

/**
 * Folders dropped onto the composer cannot travel as attachments one file at a
 * time: a turn accepts a handful of attachments and the server only knows
 * files. Instead the renderer walks the dropped directory through the
 * File and Directory Entries API and packs it into a single `<folder>.zip`,
 * which then rides the ordinary attachment upload. That keeps remote (SSH)
 * environments working without any server change: the agent receives the
 * archive path in its prompt and extracts it where it needs it.
 */

/** Minimal structural view of `FileSystemEntry` so the walker is testable without a DOM. */
export interface DroppedEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface DroppedFileEntry extends DroppedEntry {
  readonly isFile: true;
  readonly isDirectory: false;
  file(): Promise<File>;
}

export interface DroppedDirectoryEntry extends DroppedEntry {
  readonly isFile: false;
  readonly isDirectory: true;
  /** One batch per call; an empty batch marks the end, as in `FileSystemDirectoryReader`. */
  readEntries(): Promise<ReadonlyArray<DroppedEntry>>;
}

export interface DroppedDirectoryFile {
  /** Forward-slash path relative to the dropped folder, without the folder name. */
  readonly relativePath: string;
  readonly file: File;
}

/**
 * Directories that are never worth shipping to an agent: dependency caches,
 * VCS internals, and build output. Matched on the directory name at any depth.
 */
export const DROPPED_DIRECTORY_IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".DS_Store",
]);

/**
 * Raw bytes read before the walker gives up. Compression usually shrinks the
 * archive well below the per-file attachment limit, so this is deliberately
 * looser than that limit; the composer still enforces the real limit on the
 * resulting zip.
 */
export const DROPPED_DIRECTORY_MAX_RAW_BYTES = 200 * 1024 * 1024;

export const DROPPED_DIRECTORY_MAX_FILES = 5000;

export class DroppedDirectoryTooLargeError extends Error {
  constructor(readonly directoryName: string) {
    super(
      `Folder '${directoryName}' is too large to attach. Drop a smaller folder or upload it another way.`,
    );
    this.name = "DroppedDirectoryTooLargeError";
  }
}

export class DroppedDirectoryEmptyError extends Error {
  constructor(readonly directoryName: string) {
    super(`Folder '${directoryName}' has no files to attach.`);
    this.name = "DroppedDirectoryEmptyError";
  }
}

function isDirectoryEntry(entry: DroppedEntry): entry is DroppedDirectoryEntry {
  return entry.isDirectory;
}

function isFileEntry(entry: DroppedEntry): entry is DroppedFileEntry {
  return entry.isFile;
}

async function readAllEntries(directory: DroppedDirectoryEntry): Promise<DroppedEntry[]> {
  // The platform reader returns entries in batches of at most 100 and signals
  // the end with an empty batch; a single call silently truncates big folders.
  const entries: DroppedEntry[] = [];
  for (;;) {
    const batch = await directory.readEntries();
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

/** Walks a dropped directory depth-first, skipping ignored names and enforcing size caps. */
export async function collectDroppedDirectoryFiles(
  root: DroppedDirectoryEntry,
  options?: { readonly maxRawBytes?: number; readonly maxFiles?: number },
): Promise<DroppedDirectoryFile[]> {
  const maxRawBytes = options?.maxRawBytes ?? DROPPED_DIRECTORY_MAX_RAW_BYTES;
  const maxFiles = options?.maxFiles ?? DROPPED_DIRECTORY_MAX_FILES;
  const collected: DroppedDirectoryFile[] = [];
  let totalBytes = 0;

  const visit = async (directory: DroppedDirectoryEntry, prefix: string): Promise<void> => {
    const entries = await readAllEntries(directory);
    // Stable order keeps the archive deterministic for the same folder.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (DROPPED_DIRECTORY_IGNORED_NAMES.has(entry.name)) continue;
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (isDirectoryEntry(entry)) {
        await visit(entry, relativePath);
        continue;
      }
      if (!isFileEntry(entry)) continue;
      const file = await entry.file();
      totalBytes += file.size;
      if (totalBytes > maxRawBytes || collected.length + 1 > maxFiles) {
        throw new DroppedDirectoryTooLargeError(root.name);
      }
      collected.push({ relativePath, file });
    }
  };

  await visit(root, "");
  if (collected.length === 0) {
    throw new DroppedDirectoryEmptyError(root.name);
  }
  return collected;
}

/** Packs collected files into `<folderName>.zip`, preserving relative paths under the folder name. */
export async function archiveDroppedDirectoryFiles(
  folderName: string,
  files: ReadonlyArray<DroppedDirectoryFile>,
): Promise<File> {
  const zip = new JSZip();
  const folder = zip.folder(folderName);
  if (!folder) {
    throw new Error(`Could not create archive folder for '${folderName}'.`);
  }
  for (const entry of files) {
    // ArrayBuffer input is recognized by jszip in every runtime; Blob/File
    // detection is unreliable outside the browser.
    folder.file(entry.relativePath, await entry.file.arrayBuffer(), {
      date: new Date(entry.file.lastModified),
    });
  }
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return new File([blob], `${folderName}.zip`, {
    type: "application/zip",
    lastModified: Date.now(),
  });
}

export async function archiveDroppedDirectory(root: DroppedDirectoryEntry): Promise<{
  readonly archive: File;
  readonly fileCount: number;
}> {
  const files = await collectDroppedDirectoryFiles(root);
  const archive = await archiveDroppedDirectoryFiles(root.name, files);
  return { archive, fileCount: files.length };
}

/**
 * Adapts a platform `FileSystemDirectoryEntry` (callback-based) to the
 * promise-based structural interface the walker consumes.
 */
export function fromFileSystemDirectoryEntry(
  entry: FileSystemDirectoryEntry,
): DroppedDirectoryEntry {
  const reader = entry.createReader();
  return {
    name: entry.name,
    isFile: false,
    isDirectory: true,
    readEntries: () =>
      new Promise<ReadonlyArray<DroppedEntry>>((resolve, reject) => {
        reader.readEntries(
          (batch) => resolve(batch.map(fromFileSystemEntry)),
          (error) => reject(error),
        );
      }),
  };
}

function fromFileSystemEntry(entry: FileSystemEntry): DroppedEntry {
  if (entry.isDirectory) {
    return fromFileSystemDirectoryEntry(entry as FileSystemDirectoryEntry);
  }
  const fileEntry = entry as FileSystemFileEntry;
  const adapted: DroppedFileEntry = {
    name: entry.name,
    isFile: true,
    isDirectory: false,
    file: () =>
      new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, (error) => reject(error));
      }),
  };
  return adapted;
}

/**
 * Splits a drop into plain files and directory entries. Chromium lists a
 * dropped folder in `dataTransfer.files` as a placeholder `File` too (empty on
 * macOS, a few KB on Windows); those are dropped here so they do not surface as
 * unreadable files. Must run synchronously inside the drop event: the
 * `DataTransferItem` list is only readable there.
 */
export function partitionDroppedItems(input: {
  readonly items: ArrayLike<DataTransferItem> | null | undefined;
  readonly files: Iterable<File>;
}): { readonly files: File[]; readonly directories: DroppedDirectoryEntry[] } {
  const directories: DroppedDirectoryEntry[] = [];
  const directoryNames = new Set<string>();
  if (input.items) {
    for (const item of Array.from(input.items)) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        directories.push(fromFileSystemDirectoryEntry(entry as FileSystemDirectoryEntry));
        directoryNames.add(entry.name);
      }
    }
  }
  const files = Array.from(input.files).filter((file) => !directoryNames.has(file.name));
  return { files, directories };
}
