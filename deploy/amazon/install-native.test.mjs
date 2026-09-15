import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installNativeArtifacts, resolveNativeTargets } from "./install-native.mjs";

function writePackage(directory, manifest, files = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), contents);
  }
}

function createFixture(t, options = {}) {
  const arch = options.arch ?? "x64";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-native-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  const artifacts = path.join(root, "artifacts");
  const fffNode = path.join(runtime, "node_modules", "@ff-labs", "fff-node");
  const fffBinaryPackage = `fff-bin-linux-${arch}-gnu`;
  const ffiBinaryPackage = `ffi-rs-linux-${arch}-gnu`;
  const fffBinary = path.join(fffNode, "node_modules", "@ff-labs", fffBinaryPackage);
  const ffi = path.join(fffNode, "node_modules", "ffi-rs");
  const ffiBinary = path.join(ffi, "node_modules", "@yuuang", ffiBinaryPackage);

  writePackage(runtime, { name: "t3", dependencies: { "@ff-labs/fff-node": "0.9.4" } });
  writePackage(
    fffNode,
    {
      name: "@ff-labs/fff-node",
      version: options.fffNodeVersion ?? "0.9.4",
      type: "module",
      exports: options.fffExports ?? { ".": "./index.js" },
      dependencies: { "ffi-rs": "1.3.2" },
      optionalDependencies: { [`@ff-labs/${fffBinaryPackage}`]: "0.9.4" },
    },
    { "index.js": "export {};\n" },
  );
  writePackage(
    fffBinary,
    {
      name: `@ff-labs/${fffBinaryPackage}`,
      version: options.fffBinaryVersion ?? "0.9.4",
    },
    { "libfff_c.so": "old-fff" },
  );
  writePackage(
    ffi,
    { name: "ffi-rs", version: options.ffiVersion ?? "1.3.2", main: "index.js" },
    { "index.js": "" },
  );
  writePackage(
    ffiBinary,
    {
      name: `@yuuang/${ffiBinaryPackage}`,
      version: options.ffiBinaryVersion ?? "1.3.2",
    },
    { [`ffi-rs.linux-${arch}-gnu.node`]: "old-ffi" },
  );
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, `ffi-rs.linux-${arch}-gnu.node`), "al2-ffi");
  fs.writeFileSync(path.join(artifacts, "libfff_c.so"), "al2-fff");
  return { artifacts, runtime };
}

test("resolves transitive pnpm-style native package targets", (t) => {
  const fixture = createFixture(t);
  const targets = resolveNativeTargets(fixture.runtime, "x64");
  assert.match(targets.ffi, /@yuuang[/\\]ffi-rs-linux-x64-gnu/);
  assert.match(targets.fff, /@ff-labs[/\\]fff-bin-linux-x64-gnu/);
});

test("resolves package roots that have no CommonJS export", (t) => {
  const fixture = createFixture(t, {
    fffExports: { ".": { import: "./index.js" } },
  });
  const targets = resolveNativeTargets(fixture.runtime, "x64");
  assert.match(targets.fff, /@ff-labs[/\\]fff-bin-linux-x64-gnu/);
});

test("installs the AL2 native artifacts over registry prebuilds", (t) => {
  const fixture = createFixture(t);
  const targets = installNativeArtifacts(fixture.runtime, fixture.artifacts, "linux", "x64");
  assert.equal(fs.readFileSync(targets.ffi, "utf8"), "al2-ffi");
  assert.equal(fs.readFileSync(targets.fff, "utf8"), "al2-fff");
  assert.equal(fs.statSync(targets.ffi).mode & 0o777, 0o755);
  assert.equal(fs.statSync(targets.fff).mode & 0o777, 0o755);
});

test("installs the arm64 native artifacts over registry prebuilds", (t) => {
  const fixture = createFixture(t, { arch: "arm64" });
  const targets = installNativeArtifacts(fixture.runtime, fixture.artifacts, "linux", "arm64");
  assert.match(targets.ffi, /@yuuang[/\\]ffi-rs-linux-arm64-gnu/);
  assert.match(targets.fff, /@ff-labs[/\\]fff-bin-linux-arm64-gnu/);
  assert.equal(fs.readFileSync(targets.ffi, "utf8"), "al2-ffi");
  assert.equal(fs.readFileSync(targets.fff, "utf8"), "al2-fff");
});

test("fails closed on unsupported runtime platforms", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () => installNativeArtifacts(fixture.runtime, fixture.artifacts, "darwin", "arm64"),
    /supports linux/,
  );
});

test("fails closed on unsupported runtime architectures", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () => installNativeArtifacts(fixture.runtime, fixture.artifacts, "linux", "ia32"),
    /supports linux-x64 and linux-arm64/,
  );
});

for (const [option, packageName] of [
  ["fffNodeVersion", "@ff-labs/fff-node"],
  ["fffBinaryVersion", "@ff-labs/fff-bin-linux-x64-gnu"],
  ["ffiVersion", "ffi-rs"],
  ["ffiBinaryVersion", "@yuuang/ffi-rs-linux-x64-gnu"],
]) {
  test(`fails closed when ${packageName} changes`, (t) => {
    const fixture = createFixture(t, { [option]: "99.0.0" });
    assert.throws(
      () => resolveNativeTargets(fixture.runtime, "x64"),
      new RegExp(`Expected ${packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`),
    );
  });
}
