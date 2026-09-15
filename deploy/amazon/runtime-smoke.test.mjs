import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { resolvePackageImportEntry } from "./runtime-smoke.mjs";

function runtimeFixture(t, packageManifest, entryContents = "export const loaded = true;\n") {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-runtime-smoke-test-"));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const packageDirectory = path.join(
    runtime,
    "node_modules",
    "@ff-labs",
    "fff-node",
  );
  fs.mkdirSync(path.join(packageDirectory, "dist"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    `${JSON.stringify(packageManifest)}\n`,
  );
  fs.writeFileSync(path.join(packageDirectory, "dist", "index.js"), entryContents);
  return {
    packageDirectory,
    requireFromRuntime: createRequire(path.join(runtime, "package.json")),
  };
}

test("resolves and imports an ESM-only package export", async (t) => {
  const fixture = runtimeFixture(t, {
    type: "module",
    exports: {
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
    },
  });

  const entry = resolvePackageImportEntry(
    fixture.requireFromRuntime,
    "@ff-labs/fff-node",
  );
  assert.equal(entry, path.join(fixture.packageDirectory, "dist", "index.js"));
  assert.equal((await import(pathToFileURL(entry).href)).loaded, true);
});

test("rejects package import exports outside the package directory", (t) => {
  const fixture = runtimeFixture(t, {
    exports: { ".": { import: "./../outside.js" } },
  });

  assert.throws(
    () =>
      resolvePackageImportEntry(
        fixture.requireFromRuntime,
        "@ff-labs/fff-node",
      ),
    /escapes its package directory/,
  );
});
