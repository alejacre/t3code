import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_PACKAGE_VERSIONS = new Map([
  ["@ff-labs/fff-node", "0.9.4"],
  ["@ff-labs/fff-bin-linux-x64-gnu", "0.9.4"],
  ["@ff-labs/fff-bin-linux-arm64-gnu", "0.9.4"],
  ["ffi-rs", "1.3.2"],
  ["@yuuang/ffi-rs-linux-x64-gnu", "1.3.2"],
  ["@yuuang/ffi-rs-linux-arm64-gnu", "1.3.2"],
]);

function napiArchTag(architecture) {
  if (architecture === "x64" || architecture === "arm64") return architecture;
  throw new Error(
    `Amazon runtime packaging supports linux-x64 and linux-arm64, received linux-${architecture}.`,
  );
}

function readPackageManifest(packageDirectory) {
  const manifestPath = path.join(packageDirectory, "package.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function readPackageName(packageDirectory) {
  return readPackageManifest(packageDirectory)?.name;
}

function assertExpectedPackageVersion(packageDirectory, packageName) {
  const expectedVersion = EXPECTED_PACKAGE_VERSIONS.get(packageName);
  const manifest = readPackageManifest(packageDirectory);
  if (manifest?.name !== packageName || manifest.version !== expectedVersion) {
    throw new Error(
      `Expected ${packageName} ${expectedVersion}, found ${manifest?.name ?? "unknown"} ${manifest?.version ?? "unknown"}. Review the pinned native replacement before upgrading.`,
    );
  }
}

function findPackageDirectory(entryPath, packageName) {
  let current = path.dirname(entryPath);
  while (true) {
    if (readPackageName(current) === packageName) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find the ${packageName} package from ${entryPath}.`);
    }
    current = parent;
  }
}

function resolvePackageDirectory(requireFrom, packageName) {
  for (const modulesDirectory of requireFrom.resolve.paths(packageName) ?? []) {
    const candidate = path.join(modulesDirectory, packageName);
    if (readPackageName(candidate) === packageName) {
      return fs.realpathSync(candidate);
    }
  }

  return findPackageDirectory(requireFrom.resolve(packageName), packageName);
}

export function resolveNativeTargets(runtimeDirectory, architecture = process.arch) {
  const arch = napiArchTag(architecture);
  const fffBinaryPackage = `@ff-labs/fff-bin-linux-${arch}-gnu`;
  const ffiBinaryPackage = `@yuuang/ffi-rs-linux-${arch}-gnu`;
  const runtimeManifest = path.join(path.resolve(runtimeDirectory), "package.json");
  const requireFromRuntime = createRequire(runtimeManifest);
  const fffNodeDirectory = resolvePackageDirectory(requireFromRuntime, "@ff-labs/fff-node");
  assertExpectedPackageVersion(fffNodeDirectory, "@ff-labs/fff-node");
  const requireFromFff = createRequire(path.join(fffNodeDirectory, "package.json"));
  const fffBinaryDirectory = resolvePackageDirectory(requireFromFff, fffBinaryPackage);
  assertExpectedPackageVersion(fffBinaryDirectory, fffBinaryPackage);
  const ffiDirectory = resolvePackageDirectory(requireFromFff, "ffi-rs");
  assertExpectedPackageVersion(ffiDirectory, "ffi-rs");
  const requireFromFfi = createRequire(path.join(ffiDirectory, "package.json"));
  const ffiBinaryDirectory = resolvePackageDirectory(requireFromFfi, ffiBinaryPackage);
  assertExpectedPackageVersion(ffiBinaryDirectory, ffiBinaryPackage);

  return {
    ffi: path.join(ffiBinaryDirectory, `ffi-rs.linux-${arch}-gnu.node`),
    fff: path.join(fffBinaryDirectory, "libfff_c.so"),
  };
}

export function installNativeArtifacts(
  runtimeDirectory,
  artifactsDirectory,
  platform = process.platform,
  architecture = process.arch,
) {
  if (platform !== "linux") {
    throw new Error(`Amazon runtime packaging supports linux, received ${platform}.`);
  }
  const arch = napiArchTag(architecture);

  const artifacts = {
    ffi: path.join(path.resolve(artifactsDirectory), `ffi-rs.linux-${arch}-gnu.node`),
    fff: path.join(path.resolve(artifactsDirectory), "libfff_c.so"),
  };
  const targets = resolveNativeTargets(runtimeDirectory, architecture);

  for (const name of Object.keys(artifacts)) {
    const source = artifacts[name];
    const target = targets[name];
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`Native artifact is missing: ${source}`);
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`Native package target is missing: ${target}`);
    }
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
  }

  return targets;
}

function main() {
  const runtimeDirectory = process.argv[2];
  const artifactsDirectory = process.argv[3];
  if (!runtimeDirectory || !artifactsDirectory) {
    throw new Error("Usage: node install-native.mjs <runtime-directory> <artifacts-directory>");
  }
  const targets = installNativeArtifacts(runtimeDirectory, artifactsDirectory);
  console.log(`Installed AL2 ffi-rs artifact at ${targets.ffi}`);
  console.log(`Installed AL2 FFF artifact at ${targets.fff}`);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main();
}
