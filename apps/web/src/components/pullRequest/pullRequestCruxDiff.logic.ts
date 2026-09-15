import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffFile, PullRequestDiffFileContentsResult } from "@t3tools/contracts";

/** Stable identity shared by the collapsed shell and its loaded full-file diff. */
export function cruxDiffFileKey(file: PullRequestDiffFile): string {
  return JSON.stringify([
    "crux",
    file.packageName,
    file.sourcePath,
    file.destinationPath,
    file.sourceBlobId,
    file.destinationBlobId,
  ]);
}

/** Unopened CRUX shells have no line counts, so their headers must not report a false zero. */
export function showCruxDiffStats(fileDiff: FileDiffMetadata): boolean {
  return fileDiff.isPartial !== true;
}

export function cruxDiffChangeType(file: PullRequestDiffFile): FileDiffMetadata["type"] {
  const status = file.status.toUpperCase();
  if (status === "A") return "new";
  if (status === "D") return "deleted";
  if (status.startsWith("C")) return "new";
  if (file.sourcePath !== file.destinationPath || status.startsWith("R")) {
    return file.sourceBlobId !== "" && file.sourceBlobId === file.destinationBlobId
      ? "rename-pure"
      : "rename-changed";
  }
  return "change";
}

function displayPath(file: PullRequestDiffFile, qualifyPackage: boolean, side: "old" | "new") {
  const path = side === "old" ? file.sourcePath : file.destinationPath;
  return qualifyPackage ? `${file.packageName}/${path}` : path;
}

/**
 * Builds a header-only model. It stays collapsed until the host blobs load, so no invented hunk
 * or line number can be shown or used as a comment anchor.
 */
export function createCruxDiffFileShell(
  file: PullRequestDiffFile,
  qualifyPackage: boolean,
): FileDiffMetadata {
  const oldName = displayPath(file, qualifyPackage, "old");
  const newName = displayPath(file, qualifyPackage, "new");
  const type = cruxDiffChangeType(file);
  return {
    name: type === "deleted" ? oldName : newName,
    ...(oldName === newName ? {} : { prevName: oldName }),
    ...(file.sourceBlobId === "" ? {} : { prevObjectId: file.sourceBlobId }),
    ...(file.destinationBlobId === "" ? {} : { newObjectId: file.destinationBlobId }),
    type,
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    cacheKey: cruxDiffFileKey(file),
  };
}

/** Parses the exact GitFarm blobs into the full model consumed by the existing diff viewer. */
export function parseCruxDiffFile(
  file: PullRequestDiffFile,
  contents: PullRequestDiffFileContentsResult,
  qualifyPackage: boolean,
): FileDiffMetadata {
  const type = cruxDiffChangeType(file);
  const oldName = displayPath(file, qualifyPackage, "old");
  const newName = displayPath(file, qualifyPackage, "new");
  const oldFile =
    type === "new"
      ? null
      : {
          name: oldName,
          contents: contents.oldContents,
          cacheKey: `${cruxDiffFileKey(file)}:old`,
        };
  const newFile =
    type === "deleted"
      ? null
      : {
          name: newName,
          contents: contents.newContents,
          cacheKey: `${cruxDiffFileKey(file)}:new`,
        };
  const parsed = parseDiffFromFile(oldFile, newFile, { context: 3 }, true);
  const {
    prevName: _parsedPrevName,
    prevObjectId: _parsedPrevObjectId,
    newObjectId: _parsedNewObjectId,
    ...rest
  } = parsed;
  return {
    ...rest,
    name: type === "deleted" ? oldName : newName,
    ...(oldName === newName ? {} : { prevName: oldName }),
    ...(file.sourceBlobId === "" ? {} : { prevObjectId: file.sourceBlobId }),
    ...(file.destinationBlobId === "" ? {} : { newObjectId: file.destinationBlobId }),
    type,
    cacheKey: cruxDiffFileKey(file),
  };
}
