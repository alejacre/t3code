import { describe, expect, it } from "@effect/vitest";

import {
  createCruxDiffFileShell,
  cruxDiffChangeType,
  parseCruxDiffFile,
  showCruxDiffStats,
} from "./pullRequestCruxDiff.logic";

const modified = {
  packageName: "Service",
  sourcePath: "src/app.ts",
  destinationPath: "src/app.ts",
  sourceBlobId: "old",
  destinationBlobId: "new",
  status: "M",
};

describe("CRUX blob-backed diff models", () => {
  it("creates a collapsed shell without invented hunks", () => {
    const shell = createCruxDiffFileShell(modified, false);
    expect(shell).toMatchObject({
      name: "src/app.ts",
      type: "change",
      hunks: [],
      isPartial: true,
      prevObjectId: "old",
      newObjectId: "new",
    });
    expect(showCruxDiffStats(shell)).toBe(false);
  });

  it("qualifies duplicate paths by package in multi-package reviews", () => {
    expect(createCruxDiffFileShell(modified, true).name).toBe("Service/src/app.ts");
  });

  it("maps added, deleted, and rename statuses", () => {
    expect(cruxDiffChangeType({ ...modified, status: "A", sourceBlobId: "" })).toBe("new");
    expect(cruxDiffChangeType({ ...modified, status: "D", destinationBlobId: "" })).toBe("deleted");
    expect(
      cruxDiffChangeType({
        ...modified,
        status: "R100",
        sourcePath: "src/old.ts",
        destinationPath: "src/new.ts",
        destinationBlobId: "old",
      }),
    ).toBe("rename-pure");
  });

  it("parses exact old and new blobs into a full diff", () => {
    const parsed = parseCruxDiffFile(
      modified,
      { oldContents: "const value = 1;\n", newContents: "const value = 2;\n" },
      false,
    );
    expect(parsed.isPartial).toBe(false);
    expect(parsed.hunks).toHaveLength(1);
    expect(showCruxDiffStats(parsed)).toBe(true);
    expect(parsed.deletionLines).toContain("const value = 1;\n");
    expect(parsed.additionLines).toContain("const value = 2;\n");
  });

  it("parses a missing old blob as an added file", () => {
    const parsed = parseCruxDiffFile(
      { ...modified, status: "A", sourceBlobId: "" },
      { oldContents: "", newContents: "new file\n" },
      false,
    );
    expect(parsed.type).toBe("new");
    expect(parsed.prevObjectId).toBeUndefined();
  });

  it("parses deleted, copied, empty, and pure-rename files", () => {
    const deleted = parseCruxDiffFile(
      { ...modified, status: "D", destinationBlobId: "" },
      { oldContents: "old file\n", newContents: "" },
      false,
    );
    expect(deleted.type).toBe("deleted");

    const copied = parseCruxDiffFile(
      {
        ...modified,
        status: "C100",
        sourcePath: "src/source.ts",
        destinationPath: "src/copy.ts",
        destinationBlobId: "old",
      },
      { oldContents: "source\n", newContents: "source\n" },
      false,
    );
    expect(copied.type).toBe("new");

    const empty = parseCruxDiffFile(
      { ...modified, status: "A", sourceBlobId: "", destinationBlobId: "empty" },
      { oldContents: "", newContents: "" },
      false,
    );
    expect(empty.type).toBe("new");
    expect(empty.hunks).toEqual([]);

    const renamed = parseCruxDiffFile(
      {
        ...modified,
        status: "R100",
        sourcePath: "src/old.ts",
        destinationPath: "src/new.ts",
        destinationBlobId: "old",
      },
      { oldContents: "same\n", newContents: "same\n" },
      false,
    );
    expect(renamed.type).toBe("rename-pure");
    expect(renamed.prevName).toBe("src/old.ts");
  });
});
