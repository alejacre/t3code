import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireLifecycleLock,
  amazonSshRunnerContents,
  assertCodexBedrockConfiguration,
  assertSetupInstallPolicy,
  assertClaudeToolboxInstall,
  assertStartableTunnelName,
  claudeToolboxStatus,
  codexBedrockLaunchArgs,
  configuredTunnelName,
  ensureAmazonCodexSettings,
  ensureMyCli,
  ensureSafeStateRoot,
  expectedTunnelOrigin,
  fetchEnvironmentDescriptor,
  hostIdentity,
  hostTunnelName,
  isEnvironmentDescriptor,
  isLocalDockerEndpoint,
  isSafeRuntimeArchiveEntry,
  isUnsafeStateRoot,
  myCliCapabilityStatus,
  nodeVersionSupported,
  normalizeAmazonCodexSettings,
  normalizeOwnedTunnelUrl,
  normalizeTunnelUrl,
  openPrivateAppendFile,
  pairingArguments,
  parseTunnelUrl,
  processIdentity,
  processStartTime,
  recordedTunnelName,
  releaseLifecycleLock,
  replaceDirectoryTransactional,
  resolveNativeArchTarget,
  resolveNodeDistributionRoot,
  resolveTunnelLauncher,
  resolveTunnelName,
  runtimeEntry,
  runtimeBuildPlatform,
  runtimeNodeDistributionFingerprintFile,
  runtimeNodeVersionMatches,
  runtimeNodeVersionFile,
  sanitizeRuntimeEnvironment,
  sendRecordedProcessSignal,
  serverArguments,
  serverRuntimeEnvironment,
  sourceFingerprint,
  tunnelArguments,
  tunnelNameSelection,
  tunnelUrlFromList,
} from "./t3code-amazon.mjs";
import { nodeDistributionFingerprint } from "../deploy/amazon/node-distribution-fingerprint.mjs";

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-amazon-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("runtime environment overrides all T3-owned egress configuration", () => {
  const env = sanitizeRuntimeEnvironment({
    PATH: "/bin",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    T3CODE_POSTHOG_HOST: "https://us.i.posthog.com",
    T3CODE_RELAY_URL: "https://relay.t3.codes",
    T3CODE_OTLP_TRACES_URL: "https://example.test/traces",
    T3CODE_TAILSCALE_SERVE: "true",
    T3CODE_TAILSCALE_SERVE_PORT: "443",
    T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
    T3CODE_MOBILE_OTLP_TRACES_URL: "https://example.test/mobile-traces",
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
    EXPO_PUBLIC_OTLP_TRACES_URL: "https://example.test/expo-traces",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.test/otel",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
    VITE_HTTP_URL: "http://localhost:1234",
    VITE_WS_URL: "ws://localhost:1234",
    VITE_DEV_SERVER_URL: "http://localhost:5733",
  });

  assert.equal(env.PATH, "/bin");
  assert.equal(env.T3CODE_INTERNAL_ONLY, "1");
  assert.equal(env.T3CODE_TELEMETRY_ENABLED, "false");
  assert.equal(env.T3CODE_DISABLE_AUTO_UPDATE, "true");
  assert.equal(env.OTEL_SDK_DISABLED, "true");
  assert.equal(env.DO_NOT_TRACK, "1");
  assert.equal(env.DISABLE_TELEMETRY, "1");
  assert.equal(env.DISABLE_ERROR_REPORTING, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.T3CODE_CODEX_USE_BEDROCK_MODEL_IDS, "1");
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(env.T3CODE_POSTHOG_HOST, undefined);
  assert.equal(env.T3CODE_RELAY_URL, undefined);
  assert.equal(env.T3CODE_OTLP_TRACES_URL, undefined);
  assert.equal(env.T3CODE_TAILSCALE_SERVE, undefined);
  assert.equal(env.T3CODE_TAILSCALE_SERVE_PORT, undefined);
  assert.equal(env.T3CODE_CLERK_JWT_TEMPLATE, undefined);
  assert.equal(env.T3CODE_MOBILE_OTLP_TRACES_URL, undefined);
  assert.equal(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY, undefined);
  assert.equal(env.EXPO_PUBLIC_OTLP_TRACES_URL, undefined);
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.equal(env.VITE_HTTP_URL, undefined);
  assert.equal(env.VITE_WS_URL, undefined);
  assert.equal(env.VITE_DEV_SERVER_URL, undefined);
});

test("server runtime appends scoped Codex Bedrock configuration", () => {
  const env = serverRuntimeEnvironment({
    PATH: "/bin",
    T3CODE_CODEX_LAUNCH_ARGS: "--enable user-feature",
    T3CODE_CODEX_APPEND_LAUNCH_ARGS: "--enable deployment-feature",
    T3CODE_AMAZON_CODEX_AWS_PROFILE: "managed-profile",
    T3CODE_AMAZON_CODEX_AWS_REGION: "us-west-2",
  });

  assert.equal(env.T3CODE_CODEX_LAUNCH_ARGS, "--enable user-feature");
  assert.equal(env.T3CODE_CODEX_USE_BEDROCK_MODEL_IDS, "1");
  assert.equal(
    env.T3CODE_CODEX_APPEND_LAUNCH_ARGS,
    [
      "--enable deployment-feature",
      '-c "model_providers.amazon-bedrock.aws.profile=managed-profile"',
      '-c "model_providers.amazon-bedrock.aws.region=us-west-2"',
    ].join(" "),
  );
  assert.equal(env.AWS_PROFILE, undefined);
});

test("Codex Bedrock launch arguments leave the region to Codex by default", () => {
  assert.equal(
    codexBedrockLaunchArgs({}),
    '-c "model_providers.amazon-bedrock.aws.profile=codex-DO-NOT-DELETE"',
  );
});

test("a running tunnel is never renamed in place, including through an up rebuild", () => {
  const running = { recorded: "t3-code-b5381a3ac5", tunnelRunning: true };

  // The refusal `up` relies on before its rebuild stops the tunnel.
  assert.throws(
    () => assertStartableTunnelName({ ...running, requested: "t3-code" }),
    /named t3-code-b5381a3ac5, not t3-code\. Run the stop command first/u,
  );

  // Same name, nothing running, or no marker yet are all startable.
  assert.equal(
    assertStartableTunnelName({ ...running, requested: "t3-code-b5381a3ac5" }),
    undefined,
  );
  assert.equal(
    assertStartableTunnelName({
      recorded: "t3-code",
      requested: "t3-code-x",
      tunnelRunning: false,
    }),
    undefined,
  );
  assert.equal(
    assertStartableTunnelName({ recorded: null, requested: "t3-code", tunnelRunning: true }),
    undefined,
  );
});

test("an unmanaged Claude binary is rejected without being executed", () => {
  const spawned = [];
  const status = claudeToolboxStatus({
    toolboxHome: "/home/dev/.toolbox",
    resolveCommand: () => "/usr/local/bin/claude",
    readVersion: (binary) => {
      spawned.push(binary);
      return "claude 9.9.9";
    },
  });

  assert.deepEqual(status, { binary: "/usr/local/bin/claude", toolbox: false, version: null });
  assert.deepEqual(spawned, [], "doctor must not run a CLI it is about to reject");
  assert.throws(() => assertClaudeToolboxInstall(status), /Toolbox does not manage/u);
});

test("doctor fails on a Claude install Toolbox does not manage", () => {
  let thrown = null;
  try {
    assertClaudeToolboxInstall({ binary: "/usr/local/bin/claude", toolbox: false, version: null });
  } catch (error) {
    thrown = error;
  }
  assert.match(thrown?.message ?? "", /\/usr\/local\/bin\/claude/u);
  assert.match(thrown?.message ?? "", /Toolbox does not manage/u);
  assert.match(thrown?.message ?? "", /docs\.hub\.amazon\.dev\/claude-code\/user-guide/u);

  // A Toolbox install passes, and so does no install at all.
  const toolbox = {
    binary: "/home/dev/.toolbox/bin/claude",
    toolbox: true,
    version: "claude 1.0.0",
  };
  assert.equal(assertClaudeToolboxInstall(toolbox), toolbox);
  const absent = { binary: null, toolbox: false, version: null };
  assert.equal(assertClaudeToolboxInstall(absent), absent);
});

test("Claude is reported as installed only when Toolbox owns the binary", (t) => {
  const toolboxHome = temporaryDirectory(t);
  const toolboxClaude = path.join(toolboxHome, "bin", "claude");
  fs.mkdirSync(path.dirname(toolboxClaude));
  fs.writeFileSync(toolboxClaude, "#!/bin/sh\n", { mode: 0o755 });

  const installed = claudeToolboxStatus({
    toolboxHome,
    resolveCommand: (command) => (command === "claude" ? toolboxClaude : null),
    readVersion: () => "claude 4.5.6 (whatever the CLI prints)",
  });
  assert.equal(installed.binary, toolboxClaude);
  assert.equal(installed.toolbox, true);
  assert.equal(typeof installed.version, "string");
  assert.equal(installed.version, "claude 4.5.6 (whatever the CLI prints)");

  // A binary from anywhere else is installed, but not through Toolbox.
  const elsewhere = path.join(temporaryDirectory(t), "claude");
  fs.writeFileSync(elsewhere, "#!/bin/sh\n", { mode: 0o755 });
  const foreign = claudeToolboxStatus({
    toolboxHome,
    resolveCommand: () => elsewhere,
    readVersion: () => "claude 4.5.6",
  });
  assert.equal(foreign.binary, elsewhere);
  assert.equal(foreign.toolbox, false);

  assert.deepEqual(claudeToolboxStatus({ toolboxHome, resolveCommand: () => null }), {
    binary: null,
    toolbox: false,
    version: null,
  });

  // A CLI that answers with nothing usable reports no version rather than an empty line.
  for (const unusable of ["", "   ", null, undefined]) {
    const status = claudeToolboxStatus({
      toolboxHome,
      resolveCommand: () => toolboxClaude,
      readVersion: () => unusable,
    });
    assert.equal(status.version, null, JSON.stringify(unusable));
  }
});

test("a developer-linked MyCli is preserved when its CRUX command set is complete", () => {
  const help = [
    "list-open-reviews",
    "list-reviews",
    "get-review",
    "get-comments",
    "add-comments",
    "update-comment",
    "delete-comment",
    "publish-review",
    "merge-review",
    "list-merge-options",
    "discard-review",
    "retry-analyzer",
    "update-revision",
  ].join("\n");
  const resolveCommand = (command) =>
    command === "my" ? "/home/dev/workplace/MyCli/bin/my" : command === "cr" ? "/usr/bin/cr" : null;
  const spawnCommand = () => ({ status: 0, stdout: help, stderr: "" });

  assert.deepEqual(
    myCliCapabilityStatus({ resolveCommand, spawnSync: spawnCommand, source: { PATH: "/bin" } }),
    {
      binary: "/home/dev/workplace/MyCli/bin/my",
      crBinary: "/usr/bin/cr",
      ready: true,
      missingCommands: [],
    },
  );
  const calls = [];
  const status = ensureMyCli({
    resolveCommand,
    spawnSync: spawnCommand,
    run: (...args) => {
      calls.push(args);
      return "";
    },
    source: { PATH: "/bin" },
  });
  assert.equal(status.ready, true);
  assert.deepEqual(calls, []);
});

test("Amazon setup requires the authored draft listing command", () => {
  const resolveCommand = (command) =>
    command === "my" ? "/home/dev/.toolbox/bin/my" : command === "cr" ? "/usr/bin/cr" : null;
  const status = myCliCapabilityStatus({
    resolveCommand,
    spawnSync: () => ({
      status: 0,
      stdout: ["list-open-reviews", "list-merge-options", "merge-review", "update-revision"].join(
        "\n",
      ),
      stderr: "",
    }),
    source: { PATH: "/bin" },
  });

  assert.equal(status.ready, false);
  assert.deepEqual(status.missingCommands, ["list-reviews"]);
});

test("setup adds the MyCli registry and installs MyCli when capabilities are missing", () => {
  const calls = [];
  let probe = 0;
  const incomplete = {
    binary: null,
    crBinary: "/usr/bin/cr",
    ready: false,
    missingCommands: ["get-review"],
  };
  const ready = {
    binary: "/home/dev/.toolbox/bin/my",
    crBinary: "/usr/bin/cr",
    ready: true,
    missingCommands: [],
  };
  const status = ensureMyCli({
    resolveCommand: (command) => (command === "toolbox" ? "/usr/bin/toolbox" : null),
    capabilityStatus: () => {
      probe += 1;
      return probe === 1 ? incomplete : ready;
    },
    run: (command, args) => {
      calls.push([command, args]);
      if (args[0] === "registry" && args[1] === "list") return "builder-tools";
      if (args[0] === "list") return "";
      return "";
    },
  });

  assert.deepEqual(status, ready);
  assert.deepEqual(calls, [
    ["/usr/bin/toolbox", ["registry", "list"]],
    [
      "/usr/bin/toolbox",
      ["registry", "add", "s3://buildertoolbox-registry-mycli-us-west-2/tools.json"],
    ],
    ["/usr/bin/toolbox", ["list", "--installed"]],
    ["/usr/bin/toolbox", ["install", "mycli"]],
  ]);
});

test("setup updates an installed MyCli without adding an existing registry", () => {
  const calls = [];
  let probe = 0;
  ensureMyCli({
    resolveCommand: (command) => (command === "toolbox" ? "/usr/bin/toolbox" : null),
    capabilityStatus: () => {
      probe += 1;
      return probe === 1
        ? {
            binary: "/home/dev/.toolbox/bin/my",
            crBinary: "/usr/bin/cr",
            ready: false,
            missingCommands: ["update-revision"],
          }
        : {
            binary: "/home/dev/.toolbox/bin/my",
            crBinary: "/usr/bin/cr",
            ready: true,
            missingCommands: [],
          };
    },
    run: (command, args) => {
      calls.push([command, args]);
      if (args[0] === "registry") {
        return "mycli s3://buildertoolbox-registry-mycli-us-west-2/tools.json";
      }
      if (args[0] === "list") return "mycli stable";
      return "";
    },
  });

  assert.deepEqual(calls, [
    ["/usr/bin/toolbox", ["registry", "list"]],
    ["/usr/bin/toolbox", ["list", "--installed"]],
    ["/usr/bin/toolbox", ["update", "mycli"]],
  ]);
});

test("Amazon settings bootstrap selects the Bedrock Luna model with private permissions", (t) => {
  const root = temporaryDirectory(t);
  const t3Home = path.join(root, "t3-home");
  fs.mkdirSync(t3Home);

  assert.equal(ensureAmazonCodexSettings(t3Home), true);
  const settingsPath = path.join(t3Home, "userdata", "settings.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
    textGenerationModelSelection: {
      instanceId: "codex",
      model: "openai.gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    },
  });
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  assert.equal(ensureAmazonCodexSettings(t3Home), false);
});

test("Amazon settings migration prefixes only known Codex Bedrock model IDs", () => {
  for (const variant of ["luna", "terra", "sol"]) {
    const settings = {
      unrelated: { preserved: true },
      textGenerationModelSelection: {
        instanceId: "codex",
        model: `gpt-5.6-${variant}`,
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    };
    assert.deepEqual(normalizeAmazonCodexSettings(settings), {
      unrelated: { preserved: true },
      textGenerationModelSelection: {
        instanceId: "codex",
        model: `openai.gpt-5.6-${variant}`,
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  }

  const customModel = {
    textGenerationModelSelection: {
      instanceId: "codex",
      model: "custom-internal-model",
    },
  };
  const claudeSelection = {
    textGenerationModelSelection: {
      instanceId: "claudeAgent",
      model: "gpt-5.6-luna",
    },
  };
  assert.equal(normalizeAmazonCodexSettings(customModel), customModel);
  assert.equal(normalizeAmazonCodexSettings(claudeSelection), claudeSelection);
});

test("Amazon settings migration resolves legacy and configured Codex instances", () => {
  assert.equal(
    normalizeAmazonCodexSettings({
      textGenerationModelSelection: {
        provider: "codex",
        model: "gpt-5.6-luna",
      },
    }).textGenerationModelSelection.model,
    "openai.gpt-5.6-luna",
  );
  assert.equal(
    normalizeAmazonCodexSettings({
      providerInstances: {
        work_codex: {
          driver: "codex",
          displayName: "Work Codex",
        },
      },
      textGenerationModelSelection: {
        instanceId: "work_codex",
        model: "gpt-5.6-terra",
      },
    }).textGenerationModelSelection.model,
    "openai.gpt-5.6-terra",
  );
});

test("Amazon settings migration refuses malformed files without replacing them", (t) => {
  const root = temporaryDirectory(t);
  const userdata = path.join(root, "t3-home", "userdata");
  const settingsPath = path.join(userdata, "settings.json");
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(settingsPath, "{ malformed");

  assert.throws(
    () => ensureAmazonCodexSettings(path.join(root, "t3-home")),
    /Refusing to replace invalid Amazon T3 settings/,
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), "{ malformed");
});

test("Codex Bedrock validation finds config and credentials profiles without reading values", (t) => {
  const root = temporaryDirectory(t);
  const configFile = path.join(root, "config");
  const credentialsFile = path.join(root, "credentials");
  fs.writeFileSync(
    configFile,
    [
      "[default]",
      "region = us-west-2",
      "[profile codex-DO-NOT-DELETE]",
      "credential_process = managed-credential-helper",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(credentialsFile, "[another-profile]\naws_access_key_id = secret\n");

  assert.deepEqual(
    assertCodexBedrockConfiguration(
      {},
      {
        configFile,
        credentialsFile,
        resolveCodexCommand: () => "/toolbox/bin/codex",
      },
    ),
    {
      profile: "codex-DO-NOT-DELETE",
      region: null,
      codexBinary: "/toolbox/bin/codex",
    },
  );
  assert.throws(
    () =>
      assertCodexBedrockConfiguration(
        { T3CODE_AMAZON_CODEX_AWS_PROFILE: "missing" },
        {
          configFile,
          credentialsFile,
          resolveCodexCommand: () => "/toolbox/bin/codex",
        },
      ),
    /profile "missing" is not configured/,
  );
});

test("server launch is fixed to loopback and does not use the credential-printing serve command", () => {
  const args = serverArguments("/runtime/bin.mjs", "/state", "/workspace");
  assert.deepEqual(args, [
    "/runtime/bin.mjs",
    "start",
    "--mode",
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    "3773",
    "--base-dir",
    "/state/t3-home",
    "--no-browser",
    "/workspace",
  ]);
  assert.equal(args.includes("serve"), false);
});

test("Amazon SSH runner preserves internal policy and rewrites generic serve startup", () => {
  const runner = amazonSshRunnerContents({
    nodeBinary: "/managed/node/bin/node",
    entryPath: "/state/runtime/dist/bin.mjs",
    workspace: "/home/developer/workplace",
    source: {
      T3CODE_AMAZON_CODEX_AWS_PROFILE: "managed-codex",
      T3CODE_AMAZON_CODEX_AWS_REGION: "us-west-2",
      T3CODE_POSTHOG_HOST: "https://telemetry.example.test",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
    },
  });

  assert.match(runner, /^#!\/bin\/sh\nset -eu\n/u);
  assert.match(runner, /NODE_BINARY='\/managed\/node\/bin\/node'/u);
  assert.match(runner, /RUNTIME_ENTRY='\/state\/runtime\/dist\/bin\.mjs'/u);
  assert.match(runner, /WORKSPACE='\/home\/developer\/workplace'/u);
  assert.match(runner, /unset T3CODE_POSTHOG_HOST/u);
  assert.match(runner, /OTEL_\[A-Za-z0-9_\]\*/u);
  assert.match(runner, /export T3CODE_INTERNAL_ONLY='1'/u);
  assert.match(runner, /export T3CODE_TELEMETRY_ENABLED='false'/u);
  assert.match(runner, /export T3CODE_CODEX_USE_BEDROCK_MODEL_IDS='1'/u);
  assert.match(runner, /model_providers\.amazon-bedrock\.aws\.profile=managed-codex/u);
  assert.match(runner, /model_providers\.amazon-bedrock\.aws\.region=us-west-2/u);
  assert.match(runner, /if \[ "\$\{1:-\}" = "serve" \]; then/u);
  assert.match(runner, /set -- start --mode web --no-browser "\$@" "\$WORKSPACE"/u);
  assert.match(runner, /exec "\$NODE_BINARY" "\$RUNTIME_ENTRY" "\$@"/u);
});

test("runtime entry is direct and independent of a package-manager install layout", () => {
  assert.equal(runtimeEntry("/state/runtime"), "/state/runtime/dist/bin.mjs");
  assert.equal(runtimeNodeVersionFile("/state/runtime"), "/state/runtime/.t3code-node-version");
  assert.equal(
    runtimeNodeDistributionFingerprintFile("/state/runtime"),
    "/state/runtime/.t3code-node-distribution-sha256",
  );
});

test("runtime Node markers detect toolchain drift before startup", (t) => {
  const root = temporaryDirectory(t);
  const runtime = path.join(root, "runtime");
  const distribution = path.join(root, "node-distribution");
  const node = path.join(distribution, "bin", "node");
  fs.mkdirSync(runtime);
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.mkdirSync(path.join(distribution, "include", "node"), { recursive: true });
  fs.mkdirSync(path.join(distribution, "lib", "node_modules", "npm"), {
    recursive: true,
  });
  fs.writeFileSync(node, "#!/bin/sh\nprintf 'v24.14.0\\n'\n", { mode: 0o700 });
  fs.writeFileSync(path.join(distribution, "include", "node", "node.h"), "header");
  fs.writeFileSync(path.join(distribution, "lib", "node_modules", "npm", "package.json"), "{}");
  fs.writeFileSync(runtimeNodeVersionFile(runtime), "v24.14.0\n");
  fs.writeFileSync(
    runtimeNodeDistributionFingerprintFile(runtime),
    `${nodeDistributionFingerprint(distribution)}\n`,
  );

  assert.equal(runtimeNodeVersionMatches(runtime, node), true);
  fs.writeFileSync(runtimeNodeVersionFile(runtime), "v24.13.1\n");
  assert.equal(runtimeNodeVersionMatches(runtime, node), false);
  fs.writeFileSync(runtimeNodeVersionFile(runtime), "v24.14.0\n");
  fs.writeFileSync(path.join(distribution, "include", "node", "node.h"), "changed");
  assert.equal(runtimeNodeVersionMatches(runtime, node), false);
});

test("runtime Node support follows the repository's Node 24 engine", () => {
  assert.equal(nodeVersionSupported([24, 13, 0]), false);
  assert.equal(nodeVersionSupported([24, 13, 1]), true);
  assert.equal(nodeVersionSupported([24, 14, 0]), true);
  assert.equal(nodeVersionSupported([25, 0, 0]), false);
});

test("runtime build platform follows the selected Node glibc", () => {
  assert.deepEqual(runtimeBuildPlatform("2.26"), {
    base: "runtime-base-al2",
    glibc: "2.26",
    label: "AL2",
  });
  assert.deepEqual(runtimeBuildPlatform("2.34"), {
    base: "runtime-base-al2023",
    glibc: "2.34",
    label: "AL2023",
  });
  assert.throws(() => runtimeBuildPlatform("2.35"), /Unsupported Node glibc runtime/);
});

test("native arch target follows the host CPU architecture", () => {
  assert.deepEqual(resolveNativeArchTarget("x64"), {
    dockerPlatform: "linux/amd64",
    napiArch: "x64",
    mirrorArch: "x86_64",
  });
  assert.deepEqual(resolveNativeArchTarget("arm64"), {
    dockerPlatform: "linux/arm64",
    napiArch: "arm64",
    mirrorArch: "aarch64",
  });
  assert.throws(() => resolveNativeArchTarget("ia32"), /Unsupported host architecture/);
});

test("health checks accept only an environment descriptor shape", () => {
  assert.equal(
    isEnvironmentDescriptor({
      environmentId: "environment-1",
      label: "Amazon desktop",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      capabilities: {},
    }),
    true,
  );
  for (const value of [
    null,
    {},
    { environmentId: "environment-1" },
    {
      environmentId: "environment-1",
      label: "Amazon desktop",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "",
      capabilities: {},
    },
  ]) {
    assert.equal(isEnvironmentDescriptor(value), false);
  }
});

test("health checks require a valid environment descriptor response", async (t) => {
  const http = await import("node:http");
  const descriptor = {
    environmentId: "environment-1",
    label: "Amazon desktop",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: {},
  };
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === "/healthy" ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(
      request.url === "/healthy"
        ? JSON.stringify(descriptor)
        : JSON.stringify({ status: "starting" }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();

  assert.deepEqual(
    await fetchEnvironmentDescriptor({
      host: "127.0.0.1",
      port: address.port,
      path: "/healthy",
    }),
    descriptor,
  );
  await assert.rejects(
    fetchEnvironmentDescriptor({
      host: "127.0.0.1",
      port: address.port,
      path: "/starting",
    }),
    /HTTP 503/,
  );
});

test("runtime installation refuses live processes unless up requested a stop-at-swap", () => {
  assert.doesNotThrow(() =>
    assertSetupInstallPolicy({
      serverRunning: true,
      tunnelRunning: true,
      stopBeforeInstall: true,
    }),
  );
  assert.throws(
    () =>
      assertSetupInstallPolicy({
        serverRunning: true,
        tunnelRunning: false,
        stopBeforeInstall: false,
      }),
    /Refusing to replace the runtime/,
  );
});

test("tunnel launch remains owner-only and does not rewrite origins", () => {
  const args = tunnelArguments("t3-code");
  assert.deepEqual(args, ["create", "3773", "--name", "t3-code"]);
  assert.deepEqual(tunnelArguments("t3-code-0123456789"), [
    "create",
    "3773",
    "--name",
    "t3-code-0123456789",
  ]);
  assert.equal(args.includes("--allow"), false);
  assert.equal(args.includes("--rewrite-localhost"), false);
  assert.equal(args.includes("--https"), false);
});

test("host identity prefers a persistent machine id over the hostname", (t) => {
  const root = temporaryDirectory(t);
  const machineId = path.join(root, "machine-id");
  fs.writeFileSync(machineId, "8f14e45fceea167a5a36dedd4bea2543\n");

  assert.equal(
    hostIdentity({ identityFiles: [machineId], hostname: "host-a.example.test" }),
    "machine-id:8f14e45fceea167a5a36dedd4bea2543",
  );
  assert.equal(
    hostIdentity({
      identityFiles: [path.join(root, "missing"), machineId],
      hostname: "host-a.example.test",
    }),
    "machine-id:8f14e45fceea167a5a36dedd4bea2543",
  );
  assert.equal(
    hostIdentity({ identityFiles: [], hostname: "  Host-A.Example.Test  " }),
    "hostname:host-a.example.test",
  );
  assert.throws(
    () => hostIdentity({ identityFiles: [], hostname: "localhost" }),
    /T3CODE_AMAZON_TUNNEL_NAME/u,
  );

  // systemd's first-boot placeholder and a cloned id are not unique identities, so
  // they fall through to the hostname instead of collapsing hosts onto one name.
  for (const unusable of ["uninitialized", "ec20a19e", "EC20A19E252140FB1A4805FC5EB69E74", ""]) {
    assert.equal(
      hostIdentity({
        identityFiles: [machineId],
        readFile: () => unusable,
        hostname: "host-a.example.test",
      }),
      "hostname:host-a.example.test",
      unusable,
    );
  }
  assert.throws(() => hostIdentity({ identityFiles: [], hostname: "" }), /no stable machine id/u);
});

test("start and up keep the shared tunnel name and its unchanged URL", () => {
  const hostA = { identityFiles: [], hostname: "dev-dsk-builder-1a-aaaaaaaa.example.test" };

  for (const options of [{}, { unique: false }]) {
    assert.equal(resolveTunnelName({ ...hostA, ...options, source: {} }), "t3-code");
  }
  assert.equal(
    expectedTunnelOrigin({ username: "jorgebta", tunnelName: "t3-code" }),
    "https://jorgebta-t3-code.w.tunnels.lab.aws.dev",
  );
});

test("the unique commands derive one unchanging name per host", () => {
  const hostA = { identityFiles: [], hostname: "dev-dsk-builder-1a-aaaaaaaa.example.test" };
  const hostB = { identityFiles: [], hostname: "dev-dsk-builder-1a-bbbbbbbb.example.test" };
  const nameA = resolveTunnelName({ ...hostA, source: {}, unique: true });
  const nameB = resolveTunnelName({ ...hostB, source: {}, unique: true });

  assert.match(nameA, /^t3-code-[0-9a-f]{10}$/u);
  assert.notEqual(nameA, "t3-code");
  assert.equal(hostTunnelName(hostA), nameA);
  assert.equal(resolveTunnelName({ ...hostA, source: {}, unique: true }), nameA);
  assert.equal(
    resolveTunnelName({
      identityFiles: [],
      hostname: hostA.hostname.toUpperCase(),
      source: {},
      unique: true,
    }),
    nameA,
  );
  assert.notEqual(nameA, nameB);
  assert.equal(
    expectedTunnelOrigin({ username: "jorgebta", tunnelName: nameA }),
    `https://jorgebta-${nameA}.w.tunnels.lab.aws.dev`,
  );
});

test("a pinned tunnel name overrides both the shared and the unique name", () => {
  const hostA = { identityFiles: [], hostname: "dev-dsk-builder-1a-aaaaaaaa.example.test" };

  assert.equal(configuredTunnelName({}), null);
  assert.equal(configuredTunnelName({ T3CODE_AMAZON_TUNNEL_NAME: "  " }), null);
  for (const unique of [false, true]) {
    assert.equal(
      resolveTunnelName({
        ...hostA,
        unique,
        source: { T3CODE_AMAZON_TUNNEL_NAME: " t3-code-laptop " },
      }),
      "t3-code-laptop",
    );
  }
  for (const invalid of ["T3-Code", "-t3-code", "t3-code-", "t3_code", "a".repeat(33), "t3 code"]) {
    assert.throws(
      () => resolveTunnelName({ ...hostA, source: { T3CODE_AMAZON_TUNNEL_NAME: invalid } }),
      /T3CODE_AMAZON_TUNNEL_NAME must be/u,
      invalid,
    );
  }
});

test("later commands address the tunnel name recorded by the last start", (t) => {
  const root = temporaryDirectory(t);
  const locations = { tunnelName: path.join(root, "tunnel-name") };

  assert.equal(recordedTunnelName(locations), null);
  assert.deepEqual(tunnelNameSelection({ source: {}, locations }), {
    name: "t3-code",
    source: "shared name used by start and up",
  });

  fs.writeFileSync(locations.tunnelName, "t3-code-0123456789\n");
  assert.equal(recordedTunnelName(locations), "t3-code-0123456789");
  assert.deepEqual(tunnelNameSelection({ source: {}, locations }), {
    name: "t3-code-0123456789",
    source: "recorded by the last start",
  });
  assert.deepEqual(
    tunnelNameSelection({ source: { T3CODE_AMAZON_TUNNEL_NAME: "t3-code-laptop" }, locations }),
    { name: "t3-code-laptop", source: "pinned by T3CODE_AMAZON_TUNNEL_NAME" },
  );

  fs.writeFileSync(locations.tunnelName, "not a tunnel name\n");
  assert.equal(recordedTunnelName(locations), null);
  assert.equal(tunnelNameSelection({ source: {}, locations }).name, "t3-code");
});

test("the launcher documents both the shared and the unique startup commands", () => {
  const help = spawnSync(process.execPath, [path.join(import.meta.dirname, "t3code-amazon.mjs")], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  for (const command of ["start", "start-unique", "up", "up-unique", "restart"]) {
    assert.match(help.stdout, new RegExp(`^  ${command} +\\S`, "mu"), command);
  }
});

test("Toolbox tunnel launch bypasses the PID-changing dispatcher", (t) => {
  const root = temporaryDirectory(t);
  const wrapper = path.join(root, "bin", "tunnel");
  const dispatcher = path.join(root, "tools", "toolbox", "1.0.0", "toolbox-exec");
  const launcher = path.join(root, "tools", "tunnels", "0.6.7", "bin", "tunnel");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(wrapper, "");
  fs.writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal(
    resolveTunnelLauncher(wrapper, {
      toolboxHome: root,
      realpath: (candidate) => (candidate === wrapper ? dispatcher : candidate),
      readVersion: () => "0.6.7",
    }),
    launcher,
  );
  assert.equal(
    resolveTunnelLauncher(launcher, {
      realpath: (candidate) => candidate,
      readVersion: () => {
        throw new Error("direct launchers do not need Toolbox resolution");
      },
    }),
    launcher,
  );
});

test("pairing defaults to a five-minute credential emitted only by pair", () => {
  const args = pairingArguments(
    "/runtime/bin.mjs",
    "/state",
    "https://jorgebta-t3-code.tunnels.lab.aws.dev",
  );
  assert.deepEqual(args, [
    "/runtime/bin.mjs",
    "auth",
    "pairing",
    "create",
    "--base-dir",
    "/state/t3-home",
    "--base-url",
    "https://jorgebta-t3-code.tunnels.lab.aws.dev",
    "--ttl",
    "5m",
    "--label",
    "Amazon internal tunnel",
  ]);
});

test("tunnel URL parser accepts only HTTPS Amazon tunnel hosts and normalizes origins", () => {
  const text =
    "\u001b[32mReady: https://jorgebta-t3-code.w.tunnels.lab.aws.dev/path?x=1).\u001b[0m";
  assert.equal(parseTunnelUrl(text), "https://jorgebta-t3-code.w.tunnels.lab.aws.dev");
  assert.equal(
    normalizeTunnelUrl("https://jorgebta-t3-code.tunnels.lab.aws.dev:443/path"),
    "https://jorgebta-t3-code.tunnels.lab.aws.dev",
  );
  assert.equal(
    normalizeTunnelUrl("https://jorgebta-t3-code.v.tunnels.lab.aws.dev/path"),
    "https://jorgebta-t3-code.v.tunnels.lab.aws.dev",
  );

  for (const value of [
    "http://jorgebta-t3-code.tunnels.lab.aws.dev",
    "https://tunnels.lab.aws.dev",
    "https://nested.jorgebta-t3-code.tunnels.lab.aws.dev",
    "https://jorgebta-t3-code.other.tunnels.lab.aws.dev",
    "https://jorgebta-t3-code.tunnels.lab.aws.dev.evil.test",
    "https://user@jorgebta-t3-code.tunnels.lab.aws.dev",
    "https://jorgebta-t3-code.tunnels.lab.aws.dev:8443",
    "https://example.test/jorgebta-t3-code.tunnels.lab.aws.dev",
  ]) {
    assert.equal(normalizeTunnelUrl(value), null, value);
  }
  assert.equal(parseTunnelUrl("https://example.test then not ready"), null);
});

test("tunnel URL recovery accepts only the current owner's exact tunnel origin", () => {
  const options = { username: "jorgebta", tunnelName: "t3-code" };
  const expected = "https://jorgebta-t3-code.w.tunnels.lab.aws.dev";
  assert.equal(expectedTunnelOrigin(options), expected);
  assert.equal(normalizeOwnedTunnelUrl(`${expected}/path`, options), expected);
  assert.equal(
    normalizeOwnedTunnelUrl("https://jorgebta-t3-code.tunnels.lab.aws.dev/path", options),
    "https://jorgebta-t3-code.tunnels.lab.aws.dev",
  );
  assert.equal(normalizeOwnedTunnelUrl("https://someone-else.tunnels.lab.aws.dev", options), null);
  assert.equal(
    parseTunnelUrl(
      ["unrelated https://someone-else.tunnels.lab.aws.dev", `ready ${expected}/`].join("\n"),
      { expectedOrigin: expected },
    ),
    expected,
  );
});

test("tunnel list discovery requires one exact owner name, port, and PID association", () => {
  const valid = {
    tunnelName: "jorgebta-t3-code",
    alias: "w",
    url: "https://jorgebta-t3-code.w.tunnels.lab.aws.dev/path",
    allowed: ["jorgebta"],
    meta: { localPort: 3773, pid: 1234 },
  };
  const options = {
    username: "jorgebta",
    tunnelName: "t3-code",
    port: 3773,
    pid: 1234,
  };
  assert.equal(
    tunnelUrlFromList({ tunnels: [valid], hasMore: false }, options),
    "https://jorgebta-t3-code.w.tunnels.lab.aws.dev",
  );
  assert.equal(
    tunnelUrlFromList(
      {
        tunnels: [
          {
            ...valid,
            alias: "v",
            url: "https://jorgebta-t3-code.v.tunnels.lab.aws.dev/path",
          },
        ],
      },
      options,
    ),
    "https://jorgebta-t3-code.v.tunnels.lab.aws.dev",
  );
  assert.equal(
    tunnelUrlFromList(
      {
        tunnels: [
          { ...valid, tunnelName: "jorgebta-other" },
          { ...valid, meta: { localPort: 3774, pid: 1234 } },
          { ...valid, meta: { localPort: 3773, pid: 9999 } },
        ],
      },
      options,
    ),
    null,
  );
  assert.equal(
    tunnelUrlFromList(
      {
        tunnels: [{ ...valid, allowed: [] }],
      },
      options,
    ),
    null,
  );
  assert.equal(
    tunnelUrlFromList(
      {
        tunnels: [{ ...valid, allowed: ["jorgebta", "someone-else"] }],
      },
      options,
    ),
    null,
  );
  assert.equal(tunnelUrlFromList({ tunnels: [valid, valid] }, options), null);
  assert.equal(
    tunnelUrlFromList(
      {
        tunnels: [
          {
            ...valid,
            url: "https://someone-else.tunnels.lab.aws.dev",
          },
        ],
      },
      options,
    ),
    null,
  );
  assert.equal(
    tunnelUrlFromList(
      {
        tunnels: [
          {
            ...valid,
            alias: "other",
            url: "https://jorgebta-t3-code.tunnels.lab.aws.dev",
          },
        ],
      },
      options,
    ),
    null,
  );
});

test("state roots require an owned sentinel and reject non-empty adoption", (t) => {
  const parent = temporaryDirectory(t);
  const state = path.join(parent, "state");
  const locations = ensureSafeStateRoot(state);
  assert.equal(fs.statSync(locations.sentinel).mode & 0o777, 0o600);
  assert.equal(ensureSafeStateRoot(state).root, state);

  const foreign = path.join(parent, "foreign");
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "keep"), "important");
  assert.throws(() => ensureSafeStateRoot(foreign), /non-empty state directory without/);

  const target = path.join(parent, "target");
  const linked = path.join(parent, "linked");
  fs.mkdirSync(target);
  fs.symlinkSync(target, linked);
  assert.throws(() => ensureSafeStateRoot(linked), /symlinked component/);
});

test("state roots cannot overlap the repository or live T3 userdata", () => {
  assert.equal(isUnsafeStateRoot(path.join(process.cwd(), ".amazon-state")), true);
  assert.equal(
    isUnsafeStateRoot(
      path.join(fs.realpathSync.native(os.homedir()), ".t3", "userdata", "amazon-state"),
    ),
    true,
  );
  assert.equal(
    isUnsafeStateRoot(path.join(os.homedir(), ".local", "state", "t3code-amazon-test")),
    false,
  );
});

test("lifecycle lock rejects a live owner and recovers a stale owner", (t) => {
  const root = path.join(temporaryDirectory(t), "state");
  const first = acquireLifecycleLock(root);
  assert.throws(() => acquireLifecycleLock(root), /lifecycle command is running/);
  releaseLifecycleLock(first);

  const locations = ensureSafeStateRoot(root);
  fs.mkdirSync(locations.lock);
  fs.writeFileSync(
    path.join(locations.lock, "owner.json"),
    `${JSON.stringify({ pid: process.pid, startTime: "stale" })}\n`,
  );
  const recovered = acquireLifecycleLock(root);
  assert.equal(recovered.startTime, processStartTime(process.pid));
  releaseLifecycleLock(recovered);
});

test("log files are private regular files and symlinks are rejected", (t) => {
  const root = temporaryDirectory(t);
  const target = path.join(root, "target");
  const linked = path.join(root, "linked.log");
  fs.writeFileSync(target, "do not append");
  fs.symlinkSync(target, linked);
  assert.throws(() => openPrivateAppendFile(linked), /symlinked path/);

  const log = path.join(root, "server.log");
  fs.writeFileSync(log, "existing\n", { mode: 0o666 });
  const fileDescriptor = openPrivateAppendFile(log);
  fs.writeSync(fileDescriptor, "next\n");
  fs.closeSync(fileDescriptor);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(log, "utf8"), "existing\nnext\n");
});

test("transactional directory replacement restores the old runtime on swap failure", (t) => {
  const root = temporaryDirectory(t);
  const target = path.join(root, "runtime");
  const stage = path.join(root, "runtime.next");
  fs.mkdirSync(target);
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(target, "version"), "old");
  fs.writeFileSync(path.join(stage, "version"), "new");

  let calls = 0;
  assert.throws(
    () =>
      replaceDirectoryTransactional(stage, target, {
        rename(from, to) {
          calls += 1;
          if (calls === 2) throw new Error("injected swap failure");
          fs.renameSync(from, to);
        },
      }),
    /injected swap failure/,
  );
  assert.equal(fs.readFileSync(path.join(target, "version"), "utf8"), "old");
});

test("source fingerprint changes for deployment inputs but ignores unrelated files", (t) => {
  const repo = temporaryDirectory(t);
  fs.mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
  fs.mkdirSync(path.join(repo, "apps", "mobile"), { recursive: true });
  fs.mkdirSync(path.join(repo, "infra", "relay"), { recursive: true });
  fs.writeFileSync(path.join(repo, "apps", "web", "entry.ts"), "one");
  fs.writeFileSync(path.join(repo, "apps", "mobile", "package.json"), "{}");
  fs.writeFileSync(path.join(repo, "infra", "relay", "package.json"), "{}");
  fs.writeFileSync(path.join(repo, "notes.txt"), "ignored");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);

  const initial = sourceFingerprint(repo);
  fs.writeFileSync(path.join(repo, "notes.txt"), "changed");
  assert.equal(sourceFingerprint(repo), initial);
  fs.chmodSync(path.join(repo, "apps", "web", "entry.ts"), 0o755);
  const executable = sourceFingerprint(repo);
  assert.notEqual(executable, initial);
  fs.writeFileSync(path.join(repo, "apps", "web", "entry.ts"), "two");
  const sourceChanged = sourceFingerprint(repo);
  assert.notEqual(sourceChanged, executable);
  fs.writeFileSync(path.join(repo, "apps", "mobile", "package.json"), '{"private":true}');
  const mobileManifestChanged = sourceFingerprint(repo);
  assert.notEqual(mobileManifestChanged, sourceChanged);
  fs.writeFileSync(path.join(repo, "infra", "relay", "package.json"), '{"private":true}');
  assert.notEqual(sourceFingerprint(repo), mobileManifestChanged);
});

test("source fingerprint represents tracked deletions instead of failing", (t) => {
  const repo = temporaryDirectory(t);
  const entry = path.join(repo, "apps", "web", "entry.ts");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "one");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["add", "apps/web/entry.ts"], { cwd: repo }).status, 0);
  const initial = sourceFingerprint(repo);
  fs.rmSync(entry);
  assert.notEqual(sourceFingerprint(repo), initial);
});

test("Docker endpoint validation permits local Unix sockets only", () => {
  assert.equal(isLocalDockerEndpoint("unix:///var/run/docker.sock"), true);
  assert.equal(isLocalDockerEndpoint("/var/run/docker.sock"), true);
  assert.equal(isLocalDockerEndpoint("tcp://127.0.0.1:2375"), false);
  assert.equal(isLocalDockerEndpoint("ssh://builder.internal"), false);
  assert.equal(isLocalDockerEndpoint(""), false);
});

test("Node distribution discovery requires the binary, headers, and bundled npm", (t) => {
  const root = path.join(temporaryDirectory(t), "node");
  const node = path.join(root, "bin", "node");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "include", "node"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib", "node_modules", "npm"), { recursive: true });
  fs.writeFileSync(node, "");
  fs.writeFileSync(path.join(root, "include", "node", "node.h"), "");
  fs.writeFileSync(path.join(root, "lib", "node_modules", "npm", "package.json"), "{}");

  assert.equal(resolveNodeDistributionRoot(node), root);
  fs.rmSync(path.join(root, "include", "node", "node.h"));
  assert.throws(() => resolveNodeDistributionRoot(node), /self-contained distribution/);
});

test("recorded process signaling tolerates exit races but not permission errors", () => {
  const record = { pid: 1234, startTime: "5678" };
  const calls = [];
  assert.equal(
    sendRecordedProcessSignal(record, "SIGTERM", {
      getStartTime: () => "5678",
      kill(pid, signal) {
        calls.push([pid, signal]);
      },
    }),
    true,
  );
  assert.deepEqual(calls, [[1234, "SIGTERM"]]);
  assert.equal(
    sendRecordedProcessSignal(record, "SIGTERM", {
      getStartTime: () => "reused",
      kill() {
        throw new Error("must not signal a reused PID");
      },
    }),
    false,
  );
  assert.equal(
    sendRecordedProcessSignal(record, "SIGKILL", {
      getStartTime: () => "5678",
      kill() {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    }),
    false,
  );
  assert.throws(
    () =>
      sendRecordedProcessSignal(record, "SIGTERM", {
        getStartTime: () => "5678",
        kill() {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
      }),
    /denied/,
  );
});

test("recorded process signaling rejects executable or argv replacement", () => {
  const record = {
    pid: 1234,
    startTime: "5678",
    executable: "/runtime/node",
    argv: ["/runtime/node", "/runtime/bin.mjs"],
  };
  let signaled = false;
  assert.equal(
    sendRecordedProcessSignal(record, "SIGTERM", {
      getStartTime: () => "5678",
      getIdentity: () => ({
        executable: "/runtime/other",
        argv: record.argv,
      }),
      kill: () => {
        signaled = true;
      },
    }),
    false,
  );
  assert.equal(signaled, false);
  assert.equal(
    sendRecordedProcessSignal(record, "SIGTERM", {
      getStartTime: () => "5678",
      getIdentity: () => ({
        executable: record.executable,
        argv: [record.executable, "/runtime/other.mjs"],
      }),
      kill: () => {
        signaled = true;
      },
    }),
    false,
  );
  assert.equal(signaled, false);
});

test("process identity captures the current executable and argv", () => {
  const identity = processIdentity(process.pid);
  assert.ok(identity);
  assert.equal(identity.executable, fs.realpathSync.native(process.execPath));
  assert.equal(identity.argv[0], process.execPath);
});

test("runtime archive entries cannot escape the transactional staging directory", () => {
  for (const entry of [".", "./", "./dist/bin.mjs", "node_modules/pkg/index.js", "package.json"]) {
    assert.equal(isSafeRuntimeArchiveEntry(entry), true, entry);
  }
  for (const entry of [
    "",
    "/etc/passwd",
    "../escape",
    "dist/../../escape",
    "dist/..",
    "bad\0entry",
  ]) {
    assert.equal(isSafeRuntimeArchiveEntry(entry), false, entry);
  }
});
