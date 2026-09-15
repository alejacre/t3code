import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXPECTED_NODE_PTY_VERSION = "1.1.0";
const EXPECTED_NODE_ADDON_API_VERSION = "7.1.1";

function readManifest(manifestPath, expectedName) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${expectedName} manifest at ${manifestPath}.`, {
      cause: error,
    });
  }
  if (manifest.name !== expectedName) {
    throw new Error(`Expected ${expectedName} at ${manifestPath}, found ${manifest.name ?? "unknown"}.`);
  }
  return manifest;
}

function assertFile(filePath, description) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${description} is missing: ${filePath}`);
  }
}

export function nodePtyBuildConfiguration(
  nodePtyDirectory,
  nodeDistributionRoot,
  options = {},
) {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (platform !== "linux" || !["x64", "arm64"].includes(architecture)) {
    throw new Error(
      `Amazon node-pty packaging supports linux-x64 and linux-arm64, received ${platform}-${architecture}.`,
    );
  }

  const packageDirectory = fs.realpathSync(path.resolve(nodePtyDirectory));
  const nodeRoot = path.resolve(nodeDistributionRoot);
  const nodePtyManifestPath = path.join(packageDirectory, "package.json");
  const nodePtyManifest = readManifest(nodePtyManifestPath, "node-pty");
  if (nodePtyManifest.version !== EXPECTED_NODE_PTY_VERSION) {
    throw new Error(
      `Expected node-pty ${EXPECTED_NODE_PTY_VERSION}, found ${nodePtyManifest.version ?? "unknown"}. Review the direct native build before upgrading.`,
    );
  }

  const requireFromNodePty = createRequire(nodePtyManifestPath);
  const nodeAddonApiManifestPath = requireFromNodePty.resolve("node-addon-api/package.json");
  const nodeAddonApiManifest = readManifest(nodeAddonApiManifestPath, "node-addon-api");
  if (nodeAddonApiManifest.version !== EXPECTED_NODE_ADDON_API_VERSION) {
    throw new Error(
      `Expected node-addon-api ${EXPECTED_NODE_ADDON_API_VERSION}, found ${nodeAddonApiManifest.version ?? "unknown"}. Review the direct native build before upgrading.`,
    );
  }

  const source = path.join(packageDirectory, "src", "unix", "pty.cc");
  const nodeInclude = path.join(nodeRoot, "include", "node");
  const nodeAddonApiInclude = path.dirname(nodeAddonApiManifestPath);
  assertFile(source, "node-pty source");
  assertFile(path.join(nodeInclude, "node_api.h"), "Node-API header");
  assertFile(path.join(nodeAddonApiInclude, "napi.h"), "node-addon-api header");

  const outputDirectory = path.join(packageDirectory, "build", "Release");
  const output = path.join(outputDirectory, "pty.node");
  const temporaryOutput = path.join(outputDirectory, `.pty.node.tmp-${process.pid}`);
  const compiler = options.compiler ?? process.env.CXX ?? "g++";
  const args = [
    "-DNODE_GYP_MODULE_NAME=pty",
    "-DUSING_UV_SHARED=1",
    "-DUSING_V8_SHARED=1",
    "-DV8_DEPRECATION_WARNINGS=1",
    "-D_GLIBCXX_USE_CXX11_ABI=1",
    "-D_FILE_OFFSET_BITS=64",
    "-D_LARGEFILE_SOURCE",
    "-D__STDC_FORMAT_MACROS",
    "-DOPENSSL_NO_PINSHARED",
    "-DOPENSSL_THREADS",
    "-DNAPI_CPP_EXCEPTIONS",
    "-DBUILDING_NODE_EXTENSION",
    `-I${nodeInclude}`,
    `-I${nodeAddonApiInclude}`,
    "-fPIC",
    "-pthread",
    "-Wall",
    "-Wextra",
    "-Wno-unused-parameter",
    "-O3",
    "-D_FORTIFY_SOURCE=2",
    ...(architecture === "x64" ? ["-m64"] : []),
    "-fno-omit-frame-pointer",
    "-fno-rtti",
    "-fno-strict-aliasing",
    "-std=gnu++20",
    "-shared",
    "-rdynamic",
    "-Wl,-soname=pty.node",
    source,
    "-o",
    temporaryOutput,
    "-lutil",
  ];

  return {
    args,
    compiler,
    output,
    outputDirectory,
    packageDirectory,
    temporaryOutput,
  };
}

export function buildNodePty(nodePtyDirectory, nodeDistributionRoot, options = {}) {
  const configuration = nodePtyBuildConfiguration(
    nodePtyDirectory,
    nodeDistributionRoot,
    options,
  );
  const runCompiler = options.spawnSync ?? spawnSync;
  fs.mkdirSync(configuration.outputDirectory, { recursive: true });
  fs.rmSync(configuration.temporaryOutput, { force: true });

  try {
    const result = runCompiler(configuration.compiler, configuration.args, {
      cwd: configuration.packageDirectory,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `node-pty compiler exited with ${result.status ?? `signal ${result.signal ?? "unknown"}`}.`,
      );
    }
    assertFile(configuration.temporaryOutput, "Compiled node-pty artifact");
    if (fs.statSync(configuration.temporaryOutput).size === 0) {
      throw new Error(`Compiled node-pty artifact is empty: ${configuration.temporaryOutput}`);
    }
    fs.chmodSync(configuration.temporaryOutput, 0o755);
    fs.renameSync(configuration.temporaryOutput, configuration.output);
    return configuration.output;
  } finally {
    fs.rmSync(configuration.temporaryOutput, { force: true });
  }
}

function main() {
  const nodePtyDirectory = process.argv[2];
  const nodeDistributionRoot = process.argv[3];
  if (!nodePtyDirectory || !nodeDistributionRoot) {
    throw new Error(
      "Usage: node build-node-pty.mjs <node-pty-directory> <node-distribution-root>",
    );
  }
  const output = buildNodePty(nodePtyDirectory, nodeDistributionRoot);
  console.log(`Built node-pty artifact at ${output}`);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main();
}
