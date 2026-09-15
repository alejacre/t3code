import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNodePty, nodePtyBuildConfiguration } from "./build-node-pty.mjs";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-node-pty-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodePtyPackage = options.pnpmLayout
    ? path.join(root, "node_modules", ".pnpm", "node-pty@1.1.0", "node_modules", "node-pty")
    : path.join(root, "node-pty");
  const nodePty = options.pnpmLayout
    ? path.join(root, "node_modules", "node-pty")
    : nodePtyPackage;
  const nodeAddonApi = options.pnpmLayout
    ? path.join(
        root,
        "node_modules",
        ".pnpm",
        "node-addon-api@7.1.1",
        "node_modules",
        "node-addon-api",
      )
    : path.join(nodePtyPackage, "node_modules", "node-addon-api");
  const nodeRoot = path.join(root, "node");

  writeJson(path.join(nodePtyPackage, "package.json"), {
    name: "node-pty",
    version: options.nodePtyVersion ?? "1.1.0",
    dependencies: { "node-addon-api": "^7.1.0" },
  });
  writeJson(path.join(nodeAddonApi, "package.json"), {
    name: "node-addon-api",
    version: options.nodeAddonApiVersion ?? "7.1.1",
    main: "index.js",
  });
  fs.writeFileSync(path.join(nodeAddonApi, "index.js"), "");
  fs.writeFileSync(path.join(nodeAddonApi, "napi.h"), "");
  fs.mkdirSync(path.join(nodePtyPackage, "src", "unix"), { recursive: true });
  fs.writeFileSync(path.join(nodePtyPackage, "src", "unix", "pty.cc"), "int fixture = 1;\n");
  fs.mkdirSync(path.join(nodeRoot, "include", "node"), { recursive: true });
  fs.writeFileSync(path.join(nodeRoot, "include", "node", "node_api.h"), "");

  if (options.pnpmLayout) {
    fs.symlinkSync(
      "../../node-addon-api@7.1.1/node_modules/node-addon-api",
      path.join(path.dirname(nodePtyPackage), "node-addon-api"),
    );
    fs.symlinkSync(
      ".pnpm/node-pty@1.1.0/node_modules/node-pty",
      nodePty,
    );
  }

  return { nodePty, nodePtyPackage, nodeRoot };
}

test("builds node-pty directly with the pinned release flags", (t) => {
  const fixture = createFixture(t);
  let invocation;
  const output = buildNodePty(fixture.nodePty, fixture.nodeRoot, {
    compiler: "/toolchain/g++",
    spawnSync(command, args, options) {
      invocation = { args, command, options };
      const outputIndex = args.indexOf("-o");
      fs.writeFileSync(args[outputIndex + 1], "native-module");
      return { error: undefined, signal: null, status: 0 };
    },
  });

  assert.equal(invocation.command, "/toolchain/g++");
  assert.equal(invocation.options.cwd, fixture.nodePty);
  for (const flag of [
    "-DNODE_GYP_MODULE_NAME=pty",
    "-DNAPI_CPP_EXCEPTIONS",
    "-fPIC",
    "-O3",
    "-std=gnu++20",
    "-shared",
    "-rdynamic",
    "-Wl,-soname=pty.node",
    "-lutil",
  ]) {
    assert.ok(invocation.args.includes(flag), flag);
  }
  assert.equal(fs.readFileSync(output, "utf8"), "native-module");
  assert.equal(fs.statSync(output).mode & 0o777, 0o755);
});

test("includes -m64 only for the x64 target", (t) => {
  const fixture = createFixture(t);
  const x64Config = nodePtyBuildConfiguration(fixture.nodePty, fixture.nodeRoot, {
    architecture: "x64",
  });
  const arm64Config = nodePtyBuildConfiguration(fixture.nodePty, fixture.nodeRoot, {
    architecture: "arm64",
  });
  assert.ok(x64Config.args.includes("-m64"));
  assert.ok(!arm64Config.args.includes("-m64"));
});

test("fails closed on unsupported architectures", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () =>
      nodePtyBuildConfiguration(fixture.nodePty, fixture.nodeRoot, {
        architecture: "ia32",
      }),
    /supports linux-x64 and linux-arm64/,
  );
});

test("fails closed when node-pty changes", (t) => {
  const fixture = createFixture(t, { nodePtyVersion: "1.2.0" });
  assert.throws(
    () => nodePtyBuildConfiguration(fixture.nodePty, fixture.nodeRoot),
    /Expected node-pty 1\.1\.0, found 1\.2\.0/,
  );
});

test("resolves dependencies from a pnpm deployed package symlink", (t) => {
  const fixture = createFixture(t, { pnpmLayout: true });
  const configuration = nodePtyBuildConfiguration(fixture.nodePty, fixture.nodeRoot);
  assert.equal(configuration.packageDirectory, fixture.nodePtyPackage);
  assert.ok(
    configuration.args.includes(
      `-I${path.join(
        path.dirname(path.dirname(path.dirname(fixture.nodePtyPackage))),
        "node-addon-api@7.1.1",
        "node_modules",
        "node-addon-api",
      )}`,
    ),
  );
});

test("fails closed when node-addon-api changes", (t) => {
  const fixture = createFixture(t, { nodeAddonApiVersion: "8.0.0" });
  assert.throws(
    () => nodePtyBuildConfiguration(fixture.nodePty, fixture.nodeRoot),
    /Expected node-addon-api 7\.1\.1, found 8\.0\.0/,
  );
});

test("preserves an existing artifact when compilation fails", (t) => {
  const fixture = createFixture(t);
  const releaseDirectory = path.join(fixture.nodePty, "build", "Release");
  const output = path.join(releaseDirectory, "pty.node");
  fs.mkdirSync(releaseDirectory, { recursive: true });
  fs.writeFileSync(output, "previous-artifact");

  assert.throws(
    () =>
      buildNodePty(fixture.nodePty, fixture.nodeRoot, {
        spawnSync(_command, args) {
          fs.writeFileSync(args[args.indexOf("-o") + 1], "incomplete");
          return { error: undefined, signal: null, status: 1 };
        },
      }),
    /compiler exited with 1/,
  );
  assert.equal(fs.readFileSync(output, "utf8"), "previous-artifact");
});
