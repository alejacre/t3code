import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "deploy", "amazon", "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
const packageManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function dockerStage(name) {
  const header = new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, "imu").exec(dockerfile);
  assert.ok(header, `missing Docker stage: ${name}`);
  const bodyStart = header.index + header[0].length;
  const nextStage = /^FROM\s+/gimu;
  nextStage.lastIndex = bodyStart;
  const nextHeader = nextStage.exec(dockerfile);
  return dockerfile.slice(bodyStart, nextHeader?.index ?? dockerfile.length);
}

function dockerInstructions(stage) {
  const instructions = [];
  let current = "";
  for (const rawLine of stage.split("\n")) {
    const line = rawLine.trim();
    if (!current && (!line || line.startsWith("#"))) continue;
    const continues = line.endsWith("\\");
    const part = continues ? line.slice(0, -1).trimEnd() : line;
    current = current ? `${current} ${part}` : part;
    if (!continues) {
      instructions.push(current);
      current = "";
    }
  }
  assert.equal(current, "", "unterminated Docker instruction");
  return instructions;
}

function assertNetworklessRunsAfter(stageName, sourceMarker) {
  const instructions = dockerInstructions(dockerStage(stageName));
  const sourceIndex = instructions.findIndex((instruction) => sourceMarker.test(instruction));
  assert.notEqual(sourceIndex, -1, `${stageName}: missing source marker`);
  const runs = instructions
    .slice(sourceIndex + 1)
    .filter((instruction) => instruction.startsWith("RUN "));
  assert.ok(runs.length > 0, `${stageName}: expected source-aware RUN commands`);
  for (const run of runs) {
    assert.match(run, /^RUN --network=none(?:\s|$)/u, `${stageName}: ${run}`);
  }
}

test("Docker build toolchains and source dependencies are pinned", () => {
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7@sha256:[a-f0-9]{64}$/mu);

  const declaredStages = new Set();
  for (const match of dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+([a-z0-9-]+))?$/gimu)) {
    const [, image, stage] = match;
    if (image === "${T3CODE_RUNTIME_BASE}") {
      assert.match(dockerfile, /^ARG T3CODE_RUNTIME_BASE=runtime-base-al2023$/mu);
    } else if (image !== "scratch" && !declaredStages.has(image)) {
      assert.match(image, /@sha256:[a-f0-9]{64}$/u, image);
    }
    if (stage) declaredStages.add(stage);
  }

  assert.equal(packageManifest.packageManager, "pnpm@11.10.0");
  assert.match(dockerfile, /corepack prepare pnpm@11\.10\.0 --activate/u);
  assert.match(dockerfile, /ARG FFI_RS_COMMIT=[a-f0-9]{40}/u);
  assert.match(dockerfile, /ARG FFF_COMMIT=[a-f0-9]{40}/u);
  assert.match(dockerfile, /snapshot\.debian\.org\/archive\/debian\/\d{8}T\d{6}Z/u);
  assert.match(dockerfile, /^ARG T3CODE_AL_MIRROR_ARCH=x86_64$/mu);
  assert.match(
    dockerfile,
    /cdn\.amazonlinux\.com\/2\/core\/2\.0\/\$\{T3CODE_AL_MIRROR_ARCH\}\/[a-f0-9]{64}\//u,
  );
  assert.match(
    dockerfile,
    /cdn\.amazonlinux\.com\/al2023\/core\/guids\/[a-f0-9]{64}\/\$\{T3CODE_AL_MIRROR_ARCH\}\//u,
  );
  assert.equal([...dockerfile.matchAll(/cargo build [^\n\\]*(?:\\\n[^\n]*)*--locked/gu)].length, 2);
  assert.match(dockerfile, /SHELL \["\/bin\/bash", "-o", "pipefail", "-c"\]/u);
  assert.doesNotMatch(dockerfile, /!\s+objdump\b/u);
  assert.match(
    dockerfile,
    /node \/opt\/t3code\/list-runtime-native\.mjs \/runtime/u,
    "runtime dependency checks must select only loadable native artifacts",
  );
});

test("dependency acquisition precedes the full source copy without running scripts", () => {
  const fetchInstructions = dockerInstructions(dockerStage("dependency-fetch"));
  const fetchInstall = fetchInstructions.find((instruction) =>
    instruction.startsWith("RUN pnpm install "),
  );
  assert.ok(fetchInstall, "dependency-fetch: missing pnpm install");
  assert.match(fetchInstall, /(?:^|\s)--frozen-lockfile(?:\s|$)/u);
  assert.match(fetchInstall, /(?:^|\s)--ignore-scripts(?:\s|$)/u);
  assert.doesNotMatch(fetchInstall, /(?:^|\s)--trust-lockfile(?:\s|$)/u);

  const copiedInputs = fetchInstructions
    .filter((instruction) => instruction.startsWith("COPY "))
    .flatMap((instruction) => instruction.slice("COPY ".length).split(/\s+/u).slice(0, -1));
  assert.ok(copiedInputs.length > 0);
  for (const input of copiedInputs) {
    assert.ok(
      input === "package.json" ||
        input === "pnpm-lock.yaml" ||
        input === "pnpm-workspace.yaml" ||
        input === "patches/" ||
        input.endsWith("/package.json"),
      `dependency-fetch receives non-manifest source: ${input}`,
    );
  }

  const buildInstructions = dockerInstructions(dockerStage("build"));
  const storeCopyIndex = buildInstructions.indexOf(
    "COPY --from=dependency-fetch /pnpm/store /pnpm/store",
  );
  const sourceCopyIndex = buildInstructions.indexOf("COPY . .");
  assert.notEqual(storeCopyIndex, -1);
  assert.notEqual(sourceCopyIndex, -1);
  assert.ok(storeCopyIndex < sourceCopyIndex);
});

test("all source-aware installs and build commands are network-disabled", () => {
  const buildInstructions = dockerInstructions(dockerStage("build"));
  const sourceCopyIndex = buildInstructions.indexOf("COPY . .");
  const sourceInstall = buildInstructions
    .slice(sourceCopyIndex + 1)
    .find((instruction) => instruction.startsWith("RUN --network=none pnpm install "));
  assert.ok(sourceInstall, "build: missing network-disabled pnpm install");
  assert.match(sourceInstall, /(?:^|\s)--frozen-lockfile(?:\s|$)/u);
  assert.match(sourceInstall, /(?:^|\s)--trust-lockfile(?:\s|$)/u);
  assert.match(sourceInstall, /(?:^|\s)--offline(?:\s|$)/u);
  const runtimeDeploy = buildInstructions.find(
    (instruction) =>
      instruction.startsWith("RUN --network=none pnpm ") &&
      instruction.includes("--filter t3 deploy "),
  );
  assert.ok(runtimeDeploy, "build: missing network-disabled runtime deploy");
  assert.match(
    runtimeDeploy,
    /(?:^|\s)--config\.inject-workspace-packages=true(?:\s|$)/u,
  );
  assert.match(runtimeDeploy, /(?:^|\s)--prod(?:\s|$)/u);
  assert.doesNotMatch(runtimeDeploy, /(?:^|\s)--legacy(?:\s|$)/u);
  assert.match(runtimeDeploy, /(?:^|\s)--trust-lockfile(?:\s|$)/u);
  assert.match(runtimeDeploy, /(?:^|\s)--offline(?:\s|$)/u);
  for (const variable of [
    "COREPACK_ENABLE_NETWORK=0",
    "ELECTRON_SKIP_BINARY_DOWNLOAD=1",
    "npm_config_nodedir=/usr/local",
    "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1",
    "PUPPETEER_SKIP_DOWNLOAD=1",
  ]) {
    assert.ok(buildInstructions.includes(`ENV ${variable}`), variable);
  }

  assertNetworklessRunsAfter("build", /^COPY \. \.$/u);
  assertNetworklessRunsAfter("runtime-build", /^COPY --from=build \/runtime \/runtime$/u);
  assertNetworklessRunsAfter("runtime-verify", /^COPY --from=runtime-build \/runtime \/runtime$/u);

  const artifactRuns = dockerInstructions(dockerStage("artifact-build")).filter((instruction) =>
    instruction.startsWith("RUN "),
  );
  assert.ok(artifactRuns.length > 0);
  for (const run of artifactRuns) {
    assert.match(run, /^RUN --network=none(?:\s|$)/u, run);
  }
});

test("runtime artifact metadata is deterministic", () => {
  for (const flag of [
    "ENV SOURCE_DATE_EPOCH=0",
    "--sort=name",
    '--mtime="@${SOURCE_DATE_EPOCH}"',
    "--owner=0",
    "--group=0",
    "--numeric-owner",
  ]) {
    assert.ok(dockerfile.includes(flag), flag);
  }
});

test("runtime native rebuild bypasses package lifecycle scripts and Python", () => {
  const runtimeBuild = dockerInstructions(dockerStage("runtime-build"));
  assert.ok(
    runtimeBuild.includes(
      "COPY --from=build /src/deploy/amazon/build-node-pty.mjs /opt/t3code/build-node-pty.mjs",
    ),
  );
  const nativeRebuild = runtimeBuild.find((instruction) =>
    instruction.startsWith("RUN --network=none node /opt/t3code/build-node-pty.mjs "),
  );
  assert.ok(nativeRebuild, "runtime-build: missing direct node-pty rebuild");
  assert.match(nativeRebuild, /(?:^|\s)\/runtime\/node_modules\/node-pty(?:\s|$)/u);
  assert.match(nativeRebuild, /(?:^|\s)\/opt\/node(?:\s|$)/u);
  assert.doesNotMatch(runtimeBuild.join("\n"), /\bpython3?\b/u);
  assert.doesNotMatch(dockerfile, /\bnode-gyp(?:\.js)?\s+rebuild\b/u);
  assert.doesNotMatch(dockerfile, /\bnpm rebuild node-pty\b/u);
});

test("Docker context excludes local credentials and environment files", () => {
  const patterns = new Set(
    dockerignore
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  for (const required of [
    ".aws",
    ".ssh",
    "**/.aws",
    "**/.ssh",
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    ".netrc",
    ".npmrc",
    "**/.netrc",
    "**/.npmrc",
    "**/*.key",
    "**/*.pem",
    "**/*.sqlite",
  ]) {
    assert.ok(patterns.has(required), required);
  }
});

test("Amazon build cannot bake explicit HTTP or WebSocket origins", () => {
  assert.doesNotMatch(dockerfile, /\bVITE_(?:HTTP|WS)_URL\b/u);
  assert.match(dockerfile, /\bT3CODE_INTERNAL_ONLY=1\b/u);
  assert.match(dockerfile, /\bT3CODE_TELEMETRY_ENABLED=false\b/u);
});
