#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeDistributionFingerprint } from "../deploy/amazon/node-distribution-fingerprint.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PORT = 3773;
const HOST = "127.0.0.1";
const TUNNEL_NAME = "t3-code";
const TUNNEL_NAME_ENV = "T3CODE_AMAZON_TUNNEL_NAME";
const TUNNEL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const HOST_IDENTITY_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
const ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";
const RUNTIME_NODE_VERSION_FILE = ".t3code-node-version";
const RUNTIME_NODE_DISTRIBUTION_FINGERPRINT_FILE = ".t3code-node-distribution-sha256";
const SSH_RUNNER_FILE = "ssh-runner";
const HOME_DIR = fs.realpathSync.native(os.homedir());
const DEFAULT_STATE_DIR = path.join(HOME_DIR, ".local", "state", "t3code-amazon");
const LIVE_T3_USERDATA_DIR = path.join(HOME_DIR, ".t3", "userdata");
const STATE_SENTINEL = ".t3code-amazon-state";
const STATE_SENTINEL_VERSION = 1;
const MAX_CAPTURE_BUFFER = 64 * 1024 * 1024;
const DEFAULT_CODEX_AWS_PROFILE = "codex-DO-NOT-DELETE";
const CODEX_AWS_PROFILE_ENV = "T3CODE_AMAZON_CODEX_AWS_PROFILE";
const CODEX_AWS_REGION_ENV = "T3CODE_AMAZON_CODEX_AWS_REGION";
const CODEX_APPEND_LAUNCH_ARGS_ENV = "T3CODE_CODEX_APPEND_LAUNCH_ARGS";
const CODEX_USE_BEDROCK_MODEL_IDS_ENV = "T3CODE_CODEX_USE_BEDROCK_MODEL_IDS";
const CLAUDE_COMMAND = "claude";
const CLAUDE_INSTALL_DOCS = "https://docs.hub.amazon.dev/claude-code/user-guide/getting-started/";
const CLAUDE_VERSION_TIMEOUT_MS = 5_000;
const MYCLI_REGISTRY = "s3://buildertoolbox-registry-mycli-us-west-2/tools.json";
const MYCLI_REQUIRED_CR_COMMANDS = [
  "list-open-reviews",
  "list-reviews",
  "list-merge-options",
  "merge-review",
  "update-revision",
];
const MYCLI_PROBE_TIMEOUT_MS = 15_000;
const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const HELP_COMMANDS = new Set(["help", "--help", "-h"]);
const AMAZON_CODEX_TEXT_GENERATION_MODEL = "openai.gpt-5.6-luna";
const AMAZON_CODEX_MODEL_ALIASES = new Map(
  ["luna", "terra", "sol"].map((variant) => [`gpt-5.6-${variant}`, `openai.gpt-5.6-${variant}`]),
);
const MUTATING_COMMANDS = new Set([
  "setup",
  "start",
  "start-unique",
  "up",
  "up-unique",
  "pair",
  "stop",
  "restart",
]);
const FINGERPRINT_PATHS = [
  ".dockerignore",
  "apps/desktop/package.json",
  "apps/marketing/package.json",
  "apps/mobile/package.json",
  "apps/server/",
  "apps/web/",
  "deploy/amazon/",
  "infra/relay/package.json",
  "oxlint-plugin-t3code/",
  "package.json",
  "packages/",
  "patches/",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/",
  "tsconfig.base.json",
  "vite.config.ts",
];
const FORBIDDEN_RUNTIME_ENV = [
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "T3CODE_POSTHOG_KEY",
  "T3CODE_POSTHOG_HOST",
  "T3CODE_OTLP_TRACES_URL",
  "T3CODE_OTLP_METRICS_URL",
  "T3CODE_TAILSCALE_SERVE",
  "T3CODE_TAILSCALE_SERVE_PORT",
  "T3CODE_RELAY_URL",
  "T3CODE_HOSTED_APP_URL",
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_MOBILE_OTLP_TRACES_URL",
  "T3CODE_MOBILE_OTLP_TRACES_DATASET",
  "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_JWT_TEMPLATE",
  "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
  "VITE_T3CODE_RELAY_URL",
  "VITE_HOSTED_APP_URL",
  "VITE_RELAY_OTLP_TRACES_URL",
  "VITE_RELAY_OTLP_TRACES_DATASET",
  "VITE_RELAY_OTLP_TRACES_TOKEN",
  "VITE_HTTP_URL",
  "VITE_WS_URL",
  "VITE_DEV_SERVER_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
  "EXPO_PUBLIC_OTLP_TRACES_URL",
  "EXPO_PUBLIC_OTLP_TRACES_DATASET",
  "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
];
const SSH_RUNNER_ENV_NAMES = [
  "T3CODE_INTERNAL_ONLY",
  "T3CODE_TELEMETRY_ENABLED",
  "T3CODE_DISABLE_AUTO_UPDATE",
  "OTEL_SDK_DISABLED",
  "DO_NOT_TRACK",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "NO_UPDATE_NOTIFIER",
  "NPM_CONFIG_UPDATE_NOTIFIER",
  CODEX_APPEND_LAUNCH_ARGS_ENV,
  CODEX_USE_BEDROCK_MODEL_IDS_ENV,
];

function assertSingleLineConfigValue(name, value) {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value of at most 256 characters.`);
  }
  return value;
}

export function resolveCodexBedrockConfiguration(source = process.env) {
  const profile = assertSingleLineConfigValue(
    CODEX_AWS_PROFILE_ENV,
    (source[CODEX_AWS_PROFILE_ENV] || DEFAULT_CODEX_AWS_PROFILE).trim(),
  );
  const configuredRegion = source[CODEX_AWS_REGION_ENV]?.trim();
  const region = configuredRegion
    ? assertSingleLineConfigValue(CODEX_AWS_REGION_ENV, configuredRegion)
    : null;
  if (region !== null && !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d+$/u.test(region)) {
    throw new Error(`${CODEX_AWS_REGION_ENV} is not a valid AWS region.`);
  }
  return { profile, region };
}

export function codexBedrockLaunchArgs(source = process.env) {
  const { profile, region } = resolveCodexBedrockConfiguration(source);
  return [
    "-c",
    JSON.stringify(`model_providers.amazon-bedrock.aws.profile=${profile}`),
    ...(region
      ? ["-c", JSON.stringify(`model_providers.amazon-bedrock.aws.region=${region}`)]
      : []),
  ].join(" ");
}

function iniSectionNames(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const contents = fs.readFileSync(filePath, "utf8");
  return Array.from(contents.matchAll(/^\s*\[([^\]\r\n]+)\]\s*(?:[#;].*)?$/gmu), (match) =>
    match[1].trim(),
  );
}

export function isAwsProfileConfigured(profile, options = {}) {
  const source = options.source ?? process.env;
  const home = source.HOME ? path.resolve(source.HOME) : HOME_DIR;
  const configFile = path.resolve(
    options.configFile ?? source.AWS_CONFIG_FILE ?? path.join(home, ".aws", "config"),
  );
  const credentialsFile = path.resolve(
    options.credentialsFile ??
      source.AWS_SHARED_CREDENTIALS_FILE ??
      path.join(home, ".aws", "credentials"),
  );
  const configSections = new Set(
    iniSectionNames(configFile).map((section) =>
      section.startsWith("profile ") ? section.slice("profile ".length).trim() : section,
    ),
  );
  const credentialSections = new Set(iniSectionNames(credentialsFile));
  return configSections.has(profile) || credentialSections.has(profile);
}

export function assertCodexBedrockConfiguration(source = process.env, options = {}) {
  const configuration = resolveCodexBedrockConfiguration(source);
  if (!isAwsProfileConfigured(configuration.profile, { ...options, source })) {
    throw new Error(
      `Codex AWS profile "${configuration.profile}" is not configured. Set ${CODEX_AWS_PROFILE_ENV} only when your managed profile uses another name.`,
    );
  }
  const codexBinary = (options.resolveCodexCommand ?? resolveCommand)("codex");
  if (!codexBinary) {
    throw new Error("Codex CLI was not found on PATH.");
  }
  return { ...configuration, codexBinary: path.resolve(codexBinary) };
}

/**
 * Codex is optional in T3 Custom: Kiro CLI and Claude Code are first-class harnesses on the
 * Cloud Desktop. Returns null instead of throwing when Codex or its Bedrock profile is absent.
 */
export function optionalCodexBedrockConfiguration(source = process.env, options = {}) {
  try {
    return assertCodexBedrockConfiguration(source, options);
  } catch {
    return null;
  }
}

const KIRO_COMMAND = "kiro-cli";

export function kiroCliStatus(options = {}) {
  const resolve = options.resolveCommand ?? resolveCommand;
  const binary = resolve(KIRO_COMMAND);
  return { binary: binary ? path.resolve(binary) : null };
}

export function sanitizeRuntimeEnvironment(source = process.env) {
  const env = { ...source };
  for (const name of FORBIDDEN_RUNTIME_ENV) {
    delete env[name];
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith("OTEL_")) delete env[name];
  }
  env.T3CODE_INTERNAL_ONLY = "1";
  env.T3CODE_TELEMETRY_ENABLED = "false";
  env.T3CODE_DISABLE_AUTO_UPDATE = "true";
  env.OTEL_SDK_DISABLED = "true";
  env.DO_NOT_TRACK = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.NO_UPDATE_NOTIFIER = "1";
  env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  env[CODEX_USE_BEDROCK_MODEL_IDS_ENV] = "1";
  return env;
}

export function serverRuntimeEnvironment(source = process.env, options = {}) {
  const env = sanitizeRuntimeEnvironment(source);
  // An explicit managed profile is an opt-in; otherwise Codex must be installed and configured.
  const codexConfigured =
    options.codexConfigured ??
    (Boolean(source[CODEX_AWS_PROFILE_ENV]?.trim()) ||
      optionalCodexBedrockConfiguration(source, options) !== null);
  if (codexConfigured) {
    const existing = env[CODEX_APPEND_LAUNCH_ARGS_ENV]?.trim();
    env[CODEX_APPEND_LAUNCH_ARGS_ENV] = [existing, codexBedrockLaunchArgs(source)]
      .filter(Boolean)
      .join(" ");
  }
  return env;
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function amazonSshRunnerContents(input) {
  const env = serverRuntimeEnvironment(input.source ?? process.env);
  const unsetLines = FORBIDDEN_RUNTIME_ENV.map((name) => `unset ${name}`).join("\n");
  const exportLines = SSH_RUNNER_ENV_NAMES.map(
    (name) => `export ${name}=${shellSingleQuote(env[name] ?? "")}`,
  ).join("\n");
  return `#!/bin/sh
set -eu
NODE_BINARY=${shellSingleQuote(path.resolve(input.nodeBinary))}
RUNTIME_ENTRY=${shellSingleQuote(path.resolve(input.entryPath))}
WORKSPACE=${shellSingleQuote(path.resolve(input.workspace))}

${unsetLines}
for T3CODE_ENV_NAME in $(env | sed -n 's/^\\(OTEL_[A-Za-z0-9_]*\\)=.*/\\1/p'); do
  unset "$T3CODE_ENV_NAME"
done
${exportLines}

if [ ! -x "$NODE_BINARY" ]; then
  printf 'Amazon T3 managed Node is missing or not executable: %s\\n' "$NODE_BINARY" >&2
  exit 1
fi
if [ ! -f "$RUNTIME_ENTRY" ]; then
  printf 'Amazon T3 runtime is missing: %s. Run the deployment setup command first.\\n' "$RUNTIME_ENTRY" >&2
  exit 1
fi
if [ "\${1:-}" = "serve" ]; then
  shift
  set -- start --mode web --no-browser "$@" "$WORKSPACE"
fi
exec "$NODE_BINARY" "$RUNTIME_ENTRY" "$@"
`;
}

function installAmazonSshRunner(locations, nodeBinary) {
  const entry = runtimeEntry(locations.runtime);
  assertOwnedNotSymlink(entry, "file");
  writePrivateFile(
    locations.sshRunner,
    amazonSshRunnerContents({
      nodeBinary,
      entryPath: entry,
      workspace: workspaceDir(),
    }),
    { mode: 0o700 },
  );
  fs.chmodSync(locations.sshRunner, 0o700);
}

export function serverArguments(entryPath, stateDir, workspace) {
  return [
    entryPath,
    "start",
    "--mode",
    "web",
    "--host",
    HOST,
    "--port",
    String(PORT),
    "--base-dir",
    path.join(stateDir, "t3-home"),
    "--no-browser",
    workspace,
  ];
}

export function hostIdentity(options = {}) {
  const readFile = options.readFile ?? ((file) => fs.readFileSync(file, "utf8"));
  for (const file of options.identityFiles ?? HOST_IDENTITY_FILES) {
    let value = null;
    try {
      value = readFile(file).trim();
    } catch {
      // A host without this identity file falls through to the next source.
    }
    // systemd writes "uninitialized" during first boot and factory resets, and a
    // cloned image carries its source host's id. Neither is unique, so only a
    // well-formed id counts and anything else falls through.
    if (value && MACHINE_ID_PATTERN.test(value)) return `machine-id:${value}`;
  }
  const hostname = (options.hostname ?? os.hostname()).trim().toLowerCase();
  if (!hostname || hostname === "localhost") {
    throw new Error(
      `This host exposes no stable machine id or hostname. Set ${TUNNEL_NAME_ENV} to a fixed tunnel name.`,
    );
  }
  return `hostname:${hostname}`;
}

export function hostTunnelName(options = {}) {
  // The unique commands must not let two hosts of one user claim the same
  // tunnel, so the suffix is derived from a host identity that survives reboots and
  // rebuilds. `start` and `up` keep the shared name so their URL never changes.
  const digest = crypto
    .createHash("sha256")
    .update(`${TUNNEL_NAME}\0${hostIdentity(options)}`)
    .digest("hex")
    .slice(0, 10);
  return `${TUNNEL_NAME}-${digest}`;
}

export function configuredTunnelName(source = process.env) {
  const configured = source[TUNNEL_NAME_ENV]?.trim();
  if (!configured) return null;
  if (!TUNNEL_NAME_PATTERN.test(configured)) {
    throw new Error(
      `${TUNNEL_NAME_ENV} must be 1 to 32 lowercase alphanumeric or hyphen characters that start and end alphanumerically.`,
    );
  }
  return configured;
}

export function resolveTunnelName(options = {}) {
  const configured = configuredTunnelName(options.source ?? process.env);
  if (configured) return configured;
  return options.unique === true ? hostTunnelName(options) : TUNNEL_NAME;
}

export function recordedTunnelName(locations = pathsForState()) {
  try {
    assertOwnedNotSymlink(locations.tunnelName, "file");
    const recorded = fs.readFileSync(locations.tunnelName, "utf8").trim();
    return TUNNEL_NAME_PATTERN.test(recorded) ? recorded : null;
  } catch {
    return null;
  }
}

// Read-only commands must address whichever tunnel the last start created, so an
// explicit selection wins, then a pinned name, then the recorded name.
let selectedTunnelName = null;

export function tunnelNameSelection(options = {}) {
  const configured = configuredTunnelName(options.source ?? process.env);
  if (configured) return { name: configured, source: `pinned by ${TUNNEL_NAME_ENV}` };
  const recorded = options.recordedName ?? recordedTunnelName(options.locations);
  if (recorded) return { name: recorded, source: "recorded by the last start" };
  return { name: TUNNEL_NAME, source: "shared name used by start and up" };
}

export function activeTunnelName() {
  return selectedTunnelName ?? tunnelNameSelection().name;
}

// A running tunnel is never renamed in place, so every command that could start or
// replace one asks this first. `up` must ask before its rebuild stops the tunnel,
// which would otherwise erase the evidence of the mismatch.
export function assertStartableTunnelName(input) {
  if (!input.tunnelRunning || !input.recorded || input.recorded === input.requested) return;
  throw new Error(
    `The running Amazon tunnel is named ${input.recorded}, not ${input.requested}. Run the stop command first, then start it again under the name you want.`,
  );
}

function selectTunnelName(unique) {
  selectedTunnelName = unique === undefined ? activeTunnelName() : resolveTunnelName({ unique });
  return selectedTunnelName;
}

export function tunnelArguments(tunnelName = activeTunnelName()) {
  return ["create", String(PORT), "--name", tunnelName];
}

export function pairingArguments(entryPath, stateDir, publicUrl, ttl = "5m") {
  return [
    entryPath,
    "auth",
    "pairing",
    "create",
    "--base-dir",
    path.join(stateDir, "t3-home"),
    "--base-url",
    publicUrl,
    "--ttl",
    ttl,
    "--label",
    "Amazon internal tunnel",
  ];
}

export function parseTunnelUrl(text, options = {}) {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
  const matches = plain.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  for (const match of matches) {
    const normalized = normalizeTunnelUrl(match.replace(/[),.;]+$/, ""));
    if (
      normalized &&
      (options.expectedOrigin === undefined || normalized === options.expectedOrigin)
    ) {
      return normalized;
    }
  }
  return null;
}

export function normalizeTunnelUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.port && url.port !== "443") return null;
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9])?\.tunnels\.lab\.aws\.dev$/i.test(
        url.hostname,
      )
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function expectedTunnelOrigin(options = {}) {
  const username = options.username ?? os.userInfo().username;
  const tunnelName = options.tunnelName ?? activeTunnelName();
  const alias = options.alias === undefined ? "w" : options.alias;
  if (alias !== null && !/^[a-z0-9]$/i.test(alias)) {
    throw new Error(`Unsupported Amazon tunnel alias: ${alias}`);
  }
  const origin = normalizeTunnelUrl(
    `https://${username}-${tunnelName}${alias ? `.${alias}` : ""}.tunnels.lab.aws.dev`,
  );
  if (!origin) {
    throw new Error(
      `The current username and tunnel name do not form a valid Amazon tunnel host: ${username}-${tunnelName}`,
    );
  }
  return origin;
}

export function normalizeOwnedTunnelUrl(value, options = {}) {
  const normalized = normalizeTunnelUrl(value);
  if (!normalized) return null;
  const hostname = new URL(normalized).hostname;
  const ownerHostname = new URL(expectedTunnelOrigin({ ...options, alias: null })).hostname;
  if (hostname === ownerHostname) return normalized;
  const tunnelSuffix = ".tunnels.lab.aws.dev";
  if (!ownerHostname.endsWith(tunnelSuffix) || !hostname.endsWith(tunnelSuffix)) {
    return null;
  }
  const ownerName = ownerHostname.slice(0, -tunnelSuffix.length);
  const alias = hostname.slice(ownerName.length, -tunnelSuffix.length);
  return hostname.startsWith(ownerName) && /^\.[a-z0-9]$/i.test(alias) ? normalized : null;
}

export function tunnelUrlFromList(payload, options = {}) {
  const tunnelName = options.tunnelName ?? activeTunnelName();
  const port = options.port ?? PORT;
  const username = options.username ?? os.userInfo().username;
  const expectedName = `${username}-${tunnelName}`;
  const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
  const matches = tunnels.filter((tunnel) => {
    const localPort = Number(tunnel?.meta?.localPort);
    const pidMatches = options.pid === undefined || Number(tunnel?.meta?.pid) === options.pid;
    const allowed = Array.isArray(tunnel?.allowed) ? tunnel.allowed : [];
    const ownerOnly = allowed.length === 1 && allowed[0] === username;
    return tunnel?.tunnelName === expectedName && localPort === port && pidMatches && ownerOnly;
  });
  if (matches.length !== 1) return null;
  const [match] = matches;
  const alias = [undefined, null, ""].includes(match.alias) ? null : match.alias;
  if (alias !== null && (typeof alias !== "string" || !/^[a-z0-9]$/i.test(alias))) {
    return null;
  }
  const normalized = normalizeOwnedTunnelUrl(match.url, { tunnelName, username });
  if (normalized !== expectedTunnelOrigin({ tunnelName, username, alias })) {
    return null;
  }
  return normalized;
}

function stateDir() {
  return path.resolve(process.env.T3CODE_AMAZON_STATE_DIR || DEFAULT_STATE_DIR);
}

function workspaceDir() {
  return path.resolve(process.env.T3CODE_AMAZON_WORKSPACE || REPO_ROOT);
}

function pathsForState(root = stateDir()) {
  return {
    root,
    artifacts: path.join(root, "artifacts"),
    runtime: path.join(root, "runtime"),
    t3Home: path.join(root, "t3-home"),
    logs: path.join(root, "logs"),
    serverLog: path.join(root, "logs", "server.log"),
    tunnelLog: path.join(root, "logs", "tunnel.log"),
    serverProcess: path.join(root, "server-process.json"),
    tunnelProcess: path.join(root, "tunnel-process.json"),
    tunnelName: path.join(root, "tunnel-name"),
    publicUrl: path.join(root, "public-url"),
    fingerprint: path.join(root, "source-fingerprint"),
    sshRunner: path.join(root, SSH_RUNNER_FILE),
    sentinel: path.join(root, STATE_SENTINEL),
    lock: path.join(root, "lifecycle.lock"),
  };
}

function assertOwnedNotSymlink(targetPath, expectedType) {
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked path: ${targetPath}`);
  if (stat.uid !== process.getuid()) {
    throw new Error(`Refusing path not owned by uid ${process.getuid()}: ${targetPath}`);
  }
  if (expectedType === "directory" && !stat.isDirectory()) {
    throw new Error(`Expected a directory: ${targetPath}`);
  }
  if (expectedType === "file" && !stat.isFile()) {
    throw new Error(`Expected a regular file: ${targetPath}`);
  }
  return stat;
}

function ensurePrivateDirectory(directory) {
  if (fs.existsSync(directory)) {
    assertOwnedNotSymlink(directory, "directory");
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertOwnedNotSymlink(directory, "directory");
  }
  fs.chmodSync(directory, 0o700);
}

function writePrivateFile(filePath, contents, options = {}) {
  if (fs.existsSync(filePath)) assertOwnedNotSymlink(filePath, "file");
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const mode = options.mode ?? 0o600;
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      mode,
    );
    fs.writeFileSync(fileDescriptor, contents);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedProviderIsCodex(settings, selection) {
  const instanceId = selection.instanceId ?? selection.provider;
  if (instanceId === "codex") return true;
  const instance = isPlainObject(settings.providerInstances)
    ? settings.providerInstances[instanceId]
    : undefined;
  return isPlainObject(instance) && instance.driver === "codex";
}

export function normalizeAmazonCodexSettings(settings) {
  if (!isPlainObject(settings)) {
    throw new Error("Amazon T3 settings must contain a JSON object.");
  }

  const selection = settings.textGenerationModelSelection;
  if (selection === undefined) {
    return {
      ...settings,
      textGenerationModelSelection: {
        instanceId: "codex",
        model: AMAZON_CODEX_TEXT_GENERATION_MODEL,
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    };
  }
  if (!isPlainObject(selection)) {
    throw new Error("Amazon T3 textGenerationModelSelection must be a JSON object.");
  }
  if (!selectedProviderIsCodex(settings, selection)) return settings;

  const model = typeof selection.model === "string" ? selection.model.trim() : "";
  const normalizedModel = AMAZON_CODEX_MODEL_ALIASES.get(model);
  if (!normalizedModel) return settings;
  return {
    ...settings,
    textGenerationModelSelection: {
      ...selection,
      model: normalizedModel,
    },
  };
}

export function ensureAmazonCodexSettings(t3Home) {
  const userdata = path.join(t3Home, "userdata");
  const settingsPath = path.join(userdata, "settings.json");
  ensurePrivateDirectory(userdata);

  let settings = {};
  let existingContents = null;
  if (fs.existsSync(settingsPath)) {
    assertOwnedNotSymlink(settingsPath, "file");
    existingContents = fs.readFileSync(settingsPath, "utf8");
    try {
      settings = JSON.parse(existingContents);
    } catch (error) {
      throw new Error(
        `Refusing to replace invalid Amazon T3 settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const normalized = normalizeAmazonCodexSettings(settings);
  if (normalized === settings) return false;
  writePrivateFile(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return true;
}

function realpathOrSelf(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function isInsideDirectory(directory, target) {
  const relative = path.relative(realpathOrSelf(directory), realpathOrSelf(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// An absent CLI is reported and tolerated. One outside Toolbox is not: it would run
// unmanaged provider code against this deployment.
export function assertClaudeToolboxInstall(status) {
  if (status.binary !== null && !status.toolbox) {
    throw new Error(
      `Claude Code is installed at ${status.binary}, which Toolbox does not manage. See ${CLAUDE_INSTALL_DOCS}`,
    );
  }
  return status;
}

export function claudeToolboxStatus(options = {}) {
  const resolve = options.resolveCommand ?? resolveCommand;
  const readVersion = options.readVersion ?? readClaudeVersion;
  const toolboxHome =
    options.toolboxHome ?? process.env.BUILDER_TOOLBOX_HOME ?? path.join(os.homedir(), ".toolbox");
  const resolved = resolve(CLAUDE_COMMAND);
  if (!resolved) return { binary: null, toolbox: false, version: null };
  const binary = path.resolve(resolved);
  // Ownership decides whether to run it at all: a CLI this deployment rejects for
  // being unmanaged must not be executed on the way to rejecting it.
  if (!isInsideDirectory(toolboxHome, binary)) return { binary, toolbox: false, version: null };
  const reported = readVersion(binary);
  return {
    binary,
    toolbox: true,
    version: typeof reported === "string" && reported.trim() ? reported.trim() : null,
  };
}

/**
 * Verifies the exact MyCli commands used by the CRUX adapter.
 * A developer-linked MyCli is accepted when it exposes the same command contract.
 */
export function myCliCapabilityStatus(options = {}) {
  const resolve = options.resolveCommand ?? resolveCommand;
  const spawnCommand = options.spawnSync ?? spawnSync;
  const binary = resolve("my");
  const crBinary = resolve("cr");
  if (!binary) {
    return {
      binary: null,
      crBinary,
      ready: false,
      missingCommands: [...MYCLI_REQUIRED_CR_COMMANDS],
    };
  }
  const result = spawnCommand(binary, ["cr", "--help"], {
    encoding: "utf8",
    env: sanitizeRuntimeEnvironment(options.source ?? process.env),
    timeout: MYCLI_PROBE_TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const missingCommands =
    result.status !== 0
      ? [...MYCLI_REQUIRED_CR_COMMANDS]
      : MYCLI_REQUIRED_CR_COMMANDS.filter(
          (command) => !new RegExp(`(^|\\s)${command}(\\s|$)`, "mu").test(output),
        );
  return {
    binary: path.resolve(binary),
    crBinary: crBinary ? path.resolve(crBinary) : null,
    ready: missingCommands.length === 0 && crBinary !== null,
    missingCommands,
  };
}

/** Installs or repairs MyCli through Builder Toolbox when the current command set is incomplete. */
export function ensureMyCli(options = {}) {
  const resolve = options.resolveCommand ?? resolveCommand;
  const execute =
    options.run ??
    ((command, args, runOptions = {}) =>
      run(command, args, {
        ...runOptions,
        env: runOptions.env ?? sanitizeRuntimeEnvironment(process.env),
      }));
  const capabilityStatus = options.capabilityStatus ?? myCliCapabilityStatus;
  const current = capabilityStatus({
    resolveCommand: resolve,
    ...(options.spawnSync === undefined ? {} : { spawnSync: options.spawnSync }),
    source: options.source ?? process.env,
  });
  if (current.ready) return current;

  const toolbox = resolve("toolbox");
  if (!toolbox) {
    throw new Error(
      `MyCli is missing required CRUX commands and Builder Toolbox was not found. Required commands: ${current.missingCommands.join(", ")}.`,
    );
  }
  const registries = execute(toolbox, ["registry", "list"], { capture: true });
  if (!registries.includes(MYCLI_REGISTRY)) {
    execute(toolbox, ["registry", "add", MYCLI_REGISTRY]);
  }
  const installed = execute(toolbox, ["list", "--installed"], { capture: true });
  if (/(^|\s)mycli(?:\s|$)/imu.test(installed)) {
    execute(toolbox, ["update", "mycli"]);
  } else {
    execute(toolbox, ["install", "mycli"]);
  }

  const repaired = capabilityStatus({
    resolveCommand: resolve,
    ...(options.spawnSync === undefined ? {} : { spawnSync: options.spawnSync }),
    source: options.source ?? process.env,
  });
  if (!repaired.ready) {
    const missing = [
      ...(repaired.crBinary === null ? ["cr CLI"] : []),
      ...repaired.missingCommands,
    ];
    throw new Error(`CRUX setup is incomplete after installing MyCli: ${missing.join(", ")}.`);
  }
  return repaired;
}

function readClaudeVersion(binary) {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    env: sanitizeRuntimeEnvironment(process.env),
    timeout: CLAUDE_VERSION_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim().split("\n")[0];
}

function pathsOverlap(first, second) {
  const firstRelative = path.relative(first, second);
  const secondRelative = path.relative(second, first);
  const isContained = (relative) =>
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return isContained(firstRelative) || isContained(secondRelative);
}

export function isUnsafeStateRoot(root, options = {}) {
  const resolved = path.resolve(root);
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const liveT3Userdata = path.resolve(options.liveT3Userdata ?? LIVE_T3_USERDATA_DIR);
  if ([path.parse(resolved).root, os.homedir(), HOME_DIR].includes(resolved)) {
    return true;
  }
  return pathsOverlap(resolved, repoRoot) || pathsOverlap(resolved, liveT3Userdata);
}

function assertNoSymlinkComponents(targetPath) {
  const parsed = path.parse(targetPath);
  let current = parsed.root;
  for (const component of targetPath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing path with symlinked component: ${current}`);
    }
  }
}

export function ensureSafeStateRoot(root) {
  const resolved = path.resolve(root);
  if (isUnsafeStateRoot(resolved)) {
    throw new Error(`Refusing unsafe state directory: ${resolved}`);
  }

  assertNoSymlinkComponents(resolved);
  const existed = fs.existsSync(resolved);
  ensurePrivateDirectory(resolved);
  const locations = pathsForState(resolved);
  if (fs.existsSync(locations.sentinel)) {
    assertOwnedNotSymlink(locations.sentinel, "file");
    let sentinel;
    try {
      sentinel = JSON.parse(fs.readFileSync(locations.sentinel, "utf8"));
    } catch {
      throw new Error(`Invalid state sentinel: ${locations.sentinel}`);
    }
    if (
      sentinel?.version !== STATE_SENTINEL_VERSION ||
      sentinel?.uid !== process.getuid() ||
      sentinel?.root !== resolved
    ) {
      throw new Error(`State sentinel does not match this directory: ${locations.sentinel}`);
    }
    return locations;
  }

  const entries = fs.readdirSync(resolved);
  if (existed && entries.length > 0) {
    throw new Error(`Refusing non-empty state directory without ${STATE_SENTINEL}: ${resolved}`);
  }
  const sentinel = {
    version: STATE_SENTINEL_VERSION,
    uid: process.getuid(),
    root: resolved,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(locations.sentinel, `${JSON.stringify(sentinel, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") return ensureSafeStateRoot(resolved);
    throw error;
  }
  return locations;
}

function assertStateChild(root, targetPath) {
  const relative = path.relative(root, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing path outside state directory: ${targetPath}`);
  }
}

function safeRemove(root, targetPath, options = {}) {
  assertStateChild(root, targetPath);
  if (!fs.existsSync(targetPath)) return;
  assertOwnedNotSymlink(targetPath, options.recursive ? "directory" : "file");
  fs.rmSync(targetPath, { recursive: options.recursive ?? false, force: true });
}

function commandExists(command) {
  return (
    spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], {
      encoding: "utf8",
    }).status === 0
  );
}

function resolveCommand(command) {
  const result = spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function nodeVersion(nodeBinary) {
  const result = spawnSync(nodeBinary, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const match = result.stdout.trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function nodeVersionSupported(version) {
  if (!version) return false;
  const [major, minor, patch] = version;
  return major === 24 && (minor > 13 || (minor === 13 && patch >= 1));
}

export function runtimeBuildPlatform(glibcVersion) {
  if (glibcVersion === "2.26") {
    return { base: "runtime-base-al2", glibc: glibcVersion, label: "AL2" };
  }
  if (glibcVersion === "2.34") {
    return { base: "runtime-base-al2023", glibc: glibcVersion, label: "AL2023" };
  }
  throw new Error(`Unsupported Node glibc runtime: ${glibcVersion || "unknown"}.`);
}

export function resolveNativeArchTarget(hostArch = process.arch) {
  if (hostArch === "x64") {
    return { dockerPlatform: "linux/amd64", napiArch: "x64", mirrorArch: "x86_64" };
  }
  if (hostArch === "arm64") {
    return { dockerPlatform: "linux/arm64", napiArch: "arm64", mirrorArch: "aarch64" };
  }
  throw new Error(`Unsupported host architecture for the Amazon runtime build: ${hostArch}.`);
}

function nodeRuntimeBuildPlatform(nodeBinary) {
  const result = spawnSync(
    nodeBinary,
    ["-p", "process.report.getReport().header.glibcVersionRuntime"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not determine the glibc runtime used by ${nodeBinary}.`);
  }
  return runtimeBuildPlatform(result.stdout.trim());
}

function findNodeBinary() {
  const candidates = [];
  if (process.env.T3CODE_NODE_BIN) candidates.push(process.env.T3CODE_NODE_BIN);

  const tunnelNodePath = path.join(os.homedir(), ".cache", "tunnel", "node-path");
  if (fs.existsSync(tunnelNodePath)) {
    candidates.push(fs.readFileSync(tunnelNodePath, "utf8").trim());
  }

  candidates.push(process.execPath);
  const pathNode = resolveCommand("node");
  if (pathNode) candidates.push(pathNode);

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (fs.existsSync(candidate) && nodeVersionSupported(nodeVersion(candidate))) {
      return path.resolve(candidate);
    }
  }

  throw new Error(
    "Node >=24.13 was not found. Install the Amazon Tunnels CLI or set T3CODE_NODE_BIN.",
  );
}

export function resolveNodeDistributionRoot(nodeBinary, explicitRoot) {
  const resolvedNode = fs.realpathSync(nodeBinary);
  const candidates = explicitRoot
    ? [path.resolve(explicitRoot)]
    : [path.dirname(path.dirname(resolvedNode))];

  for (const candidate of candidates) {
    const root = fs.realpathSync(candidate);
    if ([path.parse(root).root, "/usr", "/usr/local"].includes(root)) {
      continue;
    }
    const expectedNode = path.join(root, "bin", "node");
    const requiredFiles = [
      expectedNode,
      path.join(root, "include", "node", "node.h"),
      path.join(root, "lib", "node_modules", "npm", "package.json"),
    ];
    if (
      requiredFiles.every((filePath) => fs.existsSync(filePath)) &&
      fs.realpathSync(expectedNode) === resolvedNode
    ) {
      return root;
    }
  }

  throw new Error(
    "Node must come from a self-contained distribution with bin, include/node, and lib/node_modules/npm. Install the Amazon Tunnels CLI or set T3CODE_NODE_ROOT.",
  );
}

function findTunnelBinary() {
  const candidates = [
    process.env.T3CODE_TUNNEL_BIN,
    resolveCommand("tunnel"),
    path.join(os.homedir(), ".toolbox", "bin", "tunnel"),
  ];
  const match = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!match) {
    throw new Error("Amazon tunnel CLI was not found. Set T3CODE_TUNNEL_BIN.");
  }
  return resolveTunnelLauncher(path.resolve(match));
}

function readTunnelVersion(binary) {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    env: sanitizeRuntimeEnvironment(process.env),
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().match(/^tunnel (\d+\.\d+\.\d+)$/u)?.[1] ?? null;
}

export function resolveTunnelLauncher(candidate, options = {}) {
  const realpath = options.realpath ?? fs.realpathSync.native;
  const readVersion = options.readVersion ?? readTunnelVersion;
  const resolved = realpath(candidate);
  if (path.basename(resolved) !== "toolbox-exec") return path.resolve(candidate);

  const version = readVersion(candidate);
  if (!version) {
    throw new Error(`Could not determine the Toolbox tunnel version from ${candidate}.`);
  }
  const toolboxHome =
    options.toolboxHome ?? process.env.BUILDER_TOOLBOX_HOME ?? path.join(os.homedir(), ".toolbox");
  const launcher = path.resolve(toolboxHome, "tools", "tunnels", version, "bin", "tunnel");
  let stat;
  try {
    stat = fs.statSync(launcher);
  } catch {
    throw new Error(`Could not find the Toolbox tunnel launcher: ${launcher}`);
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`Toolbox tunnel launcher is not executable: ${launcher}`);
  }
  if (readVersion(launcher) !== version) {
    throw new Error(`Toolbox tunnel launcher version does not match ${version}: ${launcher}`);
  }
  return launcher;
}

export function runtimeEntry(runtimeDir) {
  return path.join(runtimeDir, "dist", "bin.mjs");
}

export function runtimeNodeVersionFile(runtimeDir) {
  return path.join(runtimeDir, RUNTIME_NODE_VERSION_FILE);
}

export function runtimeNodeDistributionFingerprintFile(runtimeDir) {
  return path.join(runtimeDir, RUNTIME_NODE_DISTRIBUTION_FINGERPRINT_FILE);
}

function runtimeNodeToolchainStatus(runtimeDir, nodeBinary) {
  const versionMarker = runtimeNodeVersionFile(runtimeDir);
  const fingerprintMarker = runtimeNodeDistributionFingerprintFile(runtimeDir);
  assertOwnedNotSymlink(versionMarker, "file");
  assertOwnedNotSymlink(fingerprintMarker, "file");
  const expectedVersion = fs.readFileSync(versionMarker, "utf8").trim();
  const expectedFingerprint = fs.readFileSync(fingerprintMarker, "utf8").trim();
  const version = nodeVersion(nodeBinary);
  const actualVersion = `v${version?.join(".") ?? "unknown"}`;
  const nodeRoot = resolveNodeDistributionRoot(nodeBinary, process.env.T3CODE_NODE_ROOT);
  const actualFingerprint = nodeDistributionFingerprint(nodeRoot);
  return {
    actualFingerprint,
    actualVersion,
    expectedFingerprint,
    expectedVersion,
    matches:
      nodeVersionSupported(version) &&
      actualVersion === expectedVersion &&
      actualFingerprint === expectedFingerprint,
  };
}

export function runtimeNodeVersionMatches(runtimeDir, nodeBinary) {
  try {
    return runtimeNodeToolchainStatus(runtimeDir, nodeBinary).matches;
  } catch {
    return false;
  }
}

function assertRuntimeNodeVersion(runtimeDir, nodeBinary) {
  const status = runtimeNodeToolchainStatus(runtimeDir, nodeBinary);
  if (!status.matches) {
    throw new Error(
      `Runtime requires Node ${status.expectedVersion} toolchain ${status.expectedFingerprint}, but startup resolved ${status.actualVersion} toolchain ${status.actualFingerprint}. Re-run setup with the current Amazon Tunnels Node distribution.`,
    );
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: options.capture ? (options.maxBuffer ?? MAX_CAPTURE_BUFFER) : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} exited with status ${result.status}.${detail}`);
  }
  return result.stdout ?? "";
}

export function isSafeRuntimeArchiveEntry(entry) {
  const normalizedInput = entry.replaceAll("\\", "/");
  if (!normalizedInput || normalizedInput.includes("\0") || normalizedInput.startsWith("/")) {
    return false;
  }
  const normalized = path.posix.normalize(normalizedInput);
  if (normalized === ".") {
    return /^\.(?:\/+)?$/u.test(normalizedInput);
  }
  return normalized !== ".." && !normalized.startsWith("../");
}

function extractRuntimeArchive(archivePath, targetDirectory) {
  const entries = run("tar", ["-tzf", archivePath], { capture: true }).split("\n").filter(Boolean);
  const hasPayload = entries.some(
    (entry) => path.posix.normalize(entry.replaceAll("\\", "/")) !== ".",
  );
  if (
    entries.length === 0 ||
    !hasPayload ||
    entries.some((entry) => !isSafeRuntimeArchiveEntry(entry))
  ) {
    throw new Error("The built runtime archive contains an unsafe or empty file list.");
  }
  run("tar", [
    "--extract",
    "--gzip",
    "--file",
    archivePath,
    "--directory",
    targetDirectory,
    "--warning=no-timestamp",
    "--no-same-owner",
    "--no-same-permissions",
  ]);
}

export function processStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return null;
    return (
      stat
        .slice(closeParen + 1)
        .trim()
        .split(/\s+/)[19] ?? null
    );
  } catch {
    return null;
  }
}

export function processIdentity(pid) {
  try {
    const executable = fs.realpathSync.native(`/proc/${pid}/exe`);
    const argv = fs
      .readFileSync(`/proc/${pid}/cmdline`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return argv.length > 0 ? { executable, argv } : null;
  } catch {
    return null;
  }
}

export function sourceFingerprint(repoRoot = REPO_ROOT) {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ls-files exited with status ${result.status}.`);
  }

  const included = result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((relative) =>
      FINGERPRINT_PATHS.some((candidate) =>
        candidate.endsWith("/") ? relative.startsWith(candidate) : relative === candidate,
      ),
    )
    .sort();
  const hash = crypto.createHash("sha256");
  for (const relative of included) {
    const absolute = path.join(repoRoot, relative);
    hash.update(relative);
    hash.update("\0");
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      hash.update("missing");
      hash.update("\0");
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    hash.update(`mode:${String(stat.mode & 0o7777)}`);
    hash.update("\0");
    hash.update(
      stat.isSymbolicLink() ? `link:${fs.readlinkSync(absolute)}` : fs.readFileSync(absolute),
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function isLocalDockerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") return false;
  const normalized = endpoint.trim().replace(/^"(.*)"$/, "$1");
  try {
    const url = new URL(normalized);
    return url.protocol === "unix:" && path.isAbsolute(url.pathname);
  } catch {
    return path.isAbsolute(normalized);
  }
}

function assertLocalDockerDaemon(env) {
  if (env.T3CODE_AMAZON_ALLOW_REMOTE_DOCKER === "1") return;
  if (env.DOCKER_HOST && !isLocalDockerEndpoint(env.DOCKER_HOST)) {
    throw new Error(
      "Remote DOCKER_HOST is disabled. Use a local Unix socket or explicitly set T3CODE_AMAZON_ALLOW_REMOTE_DOCKER=1.",
    );
  }
  const result = spawnSync(
    "docker",
    ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
    { cwd: REPO_ROOT, env, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !isLocalDockerEndpoint(result.stdout)) {
    throw new Error(
      "The active Docker context is not a verified local Unix socket. Remote Docker daemons are disabled by default.",
    );
  }
}

export function acquireLifecycleLock(root) {
  const locations = ensureSafeStateRoot(root);
  const currentStartTime = processStartTime(process.pid);
  if (!currentStartTime) throw new Error("Could not read this process start time.");
  const owner = {
    pid: process.pid,
    startTime: currentStartTime,
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidatePath = `${locations.lock}.candidate-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    fs.mkdirSync(candidatePath, { mode: 0o700 });
    try {
      writePrivateFile(path.join(candidatePath, "owner.json"), `${JSON.stringify(owner)}\n`);
      fs.renameSync(candidatePath, locations.lock);
      return { path: locations.lock, ...owner };
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) {
        throw error;
      }
    } finally {
      safeRemove(locations.root, candidatePath, { recursive: true });
    }

    assertOwnedNotSymlink(locations.lock, "directory");
    const existingOwner = readProcessRecord(path.join(locations.lock, "owner.json"));
    if (
      existingOwner &&
      Number.isInteger(existingOwner.pid) &&
      typeof existingOwner.startTime === "string" &&
      processStartTime(existingOwner.pid) === existingOwner.startTime
    ) {
      throw new Error(`Another lifecycle command is running with PID ${existingOwner.pid}.`);
    }

    const stalePath = `${locations.lock}.stale-${process.pid}-${attempt}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.renameSync(locations.lock, stalePath);
      safeRemove(locations.root, stalePath, { recursive: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Could not acquire the lifecycle lock.");
}

export function releaseLifecycleLock(lock) {
  if (!lock || !fs.existsSync(lock.path)) return;
  assertOwnedNotSymlink(lock.path, "directory");
  const owner = readProcessRecord(path.join(lock.path, "owner.json"));
  if (owner?.pid !== lock.pid || owner?.startTime !== lock.startTime) {
    throw new Error(`Lifecycle lock ownership changed: ${lock.path}`);
  }
  fs.rmSync(lock.path, { recursive: true, force: true });
}

function readProcessRecord(filePath) {
  try {
    assertOwnedNotSymlink(filePath, "file");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function recordedProcessMatches(record) {
  if (
    !record ||
    !Number.isInteger(record.pid) ||
    typeof record.startTime !== "string" ||
    processStartTime(record.pid) !== record.startTime
  ) {
    return false;
  }
  if (record.executable === undefined && record.argv === undefined) {
    return true;
  }
  if (typeof record.executable !== "string" || !Array.isArray(record.argv)) {
    return false;
  }
  const identity = processIdentity(record.pid);
  return (
    identity !== null &&
    identity.executable === record.executable &&
    identity.argv.length === record.argv.length &&
    identity.argv.every((argument, index) => argument === record.argv[index])
  );
}

function isRecordedProcessRunning(filePath) {
  return recordedProcessMatches(readProcessRecord(filePath));
}

function sealRecordedProcessIdentity(filePath) {
  const record = readProcessRecord(filePath);
  if (!recordedProcessMatches(record)) {
    throw new Error(`Recorded process is no longer running: ${filePath}`);
  }
  const identity = processIdentity(record.pid);
  if (!identity) {
    throw new Error(`Could not capture process identity for PID ${record.pid}.`);
  }
  writePrivateFile(filePath, `${JSON.stringify({ ...record, ...identity }, null, 2)}\n`);
}

function recordProcess(filePath, child, command, args) {
  const startTime = processStartTime(child.pid);
  if (!startTime) {
    throw new Error(`${command} exited before its process record could be captured.`);
  }
  writePrivateFile(
    filePath,
    `${JSON.stringify(
      {
        pid: child.pid,
        startTime,
        command,
        args,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

export function openPrivateAppendFile(filePath) {
  if (fs.existsSync(filePath)) assertOwnedNotSymlink(filePath, "file");
  const fileDescriptor = fs.openSync(
    filePath,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fs.fstatSync(fileDescriptor);
    if (!stat.isFile() || stat.uid !== process.getuid()) {
      throw new Error(`Refusing unsafe log file: ${filePath}`);
    }
    fs.fchmodSync(fileDescriptor, 0o600);
    return fileDescriptor;
  } catch (error) {
    fs.closeSync(fileDescriptor);
    throw error;
  }
}

function truncatePrivateFile(filePath) {
  const fileDescriptor = openPrivateAppendFile(filePath);
  try {
    fs.ftruncateSync(fileDescriptor, 0);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function spawnBackground(command, args, { cwd, env, logPath, processPath }) {
  const logFd = openPrivateAppendFile(logPath);
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.once("error", () => {
      // Startup failures are reported by process-record capture or health checks.
    });
    recordProcess(processPath, child, command, args);
    child.unref();
    return child;
  } catch (error) {
    if (Number.isInteger(child?.pid)) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // The captured child already exited.
      }
    }
    fs.rmSync(processPath, { force: true });
    throw error;
  } finally {
    fs.closeSync(logFd);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isEnvironmentDescriptor(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.environmentId === "string" &&
    value.environmentId.trim() !== "" &&
    typeof value.label === "string" &&
    value.label.trim() !== "" &&
    typeof value.serverVersion === "string" &&
    value.serverVersion.trim() !== "" &&
    typeof value.platform === "object" &&
    value.platform !== null &&
    typeof value.platform.os === "string" &&
    typeof value.platform.arch === "string" &&
    typeof value.capabilities === "object" &&
    value.capabilities !== null
  );
}

export function fetchEnvironmentDescriptor(options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: options.host ?? HOST,
        port: options.port ?? PORT,
        path: options.path ?? ENVIRONMENT_DESCRIPTOR_PATH,
        timeout: options.timeoutMs ?? 1_000,
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 64 * 1024) {
            request.destroy(new Error("environment descriptor exceeded 64 KiB"));
          }
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          try {
            const descriptor = JSON.parse(body);
            isEnvironmentDescriptor(descriptor)
              ? resolve(descriptor)
              : reject(new Error("invalid environment descriptor"));
          } catch {
            reject(new Error("invalid environment descriptor JSON"));
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("request timed out")));
  });
}

async function waitForHttp(processPath) {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!isRecordedProcessRunning(processPath)) {
      throw new Error("The recorded T3 server exited during its health check.");
    }
    try {
      await fetchEnvironmentDescriptor();
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(`T3 server did not become healthy: ${lastError?.message ?? "timeout"}`);
}

async function assertPortAvailable() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) =>
      reject(new Error(`Port ${PORT} is unavailable: ${error.message}`)),
    );
    server.listen(PORT, HOST, () => server.close(resolve));
  });
}

function discoverTunnelUrlFromList(tunnelBinary, env, pid) {
  const result = spawnSync(tunnelBinary, ["list", "--json"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  try {
    return tunnelUrlFromList(JSON.parse(result.stdout), { pid });
  } catch {
    return null;
  }
}

async function waitForTunnelUrl(tunnelBinary, tunnelLog, env, processPath) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!isRecordedProcessRunning(processPath)) {
      throw new Error(`Amazon tunnel exited during startup. Read ${tunnelLog}.`);
    }
    const record = readProcessRecord(processPath);
    const fromList = discoverTunnelUrlFromList(tunnelBinary, env, record?.pid);
    if (fromList) return fromList;
    await delay(1_000);
  }
  throw new Error(
    `Amazon tunnel was not listed with its exact name (${activeTunnelName()}), port, and recorded PID within 60 seconds. Read ${tunnelLog}.`,
  );
}

async function stopRecordedProcess(filePath, label) {
  const record = readProcessRecord(filePath);
  if (!recordedProcessMatches(record)) {
    fs.rmSync(filePath, { force: true });
    return false;
  }

  sendRecordedProcessSignal(record, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processStartTime(record.pid) === record.startTime) {
    await delay(100);
  }
  if (processStartTime(record.pid) === record.startTime) {
    sendRecordedProcessSignal(record, "SIGKILL");
  }
  fs.rmSync(filePath, { force: true });
  console.log(`${label} stopped.`);
  return true;
}

export function sendRecordedProcessSignal(record, signal, options = {}) {
  const getStartTime = options.getStartTime ?? processStartTime;
  const getIdentity = options.getIdentity ?? processIdentity;
  const kill = options.kill ?? process.kill;
  if (getStartTime(record.pid) !== record.startTime) return false;
  if (record.executable !== undefined || record.argv !== undefined) {
    const identity = getIdentity(record.pid);
    if (
      !identity ||
      identity.executable !== record.executable ||
      !Array.isArray(record.argv) ||
      identity.argv.length !== record.argv.length ||
      !identity.argv.every((argument, index) => argument === record.argv[index])
    ) {
      return false;
    }
  }
  try {
    kill(record.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function recoverRuntimeBackup(locations) {
  if (fs.existsSync(locations.runtime)) return;
  const prefix = `${path.basename(locations.runtime)}.previous-`;
  const backups = fs
    .readdirSync(locations.root)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();
  if (backups.length === 0) return;
  const backup = path.join(locations.root, backups[0]);
  assertOwnedNotSymlink(backup, "directory");
  fs.renameSync(backup, locations.runtime);
}

export function replaceDirectoryTransactional(stage, target, options = {}) {
  const root = path.dirname(target);
  const rename = options.rename ?? fs.renameSync;
  assertStateChild(root, stage);
  assertStateChild(root, target);
  assertOwnedNotSymlink(stage, "directory");
  const backup = `${target}.previous-${process.pid}`;
  safeRemove(root, backup, { recursive: true });
  let movedTarget = false;
  try {
    if (fs.existsSync(target)) {
      assertOwnedNotSymlink(target, "directory");
      rename(target, backup);
      movedTarget = true;
    }
    rename(stage, target);
  } catch (error) {
    if (movedTarget && !fs.existsSync(target) && fs.existsSync(backup)) {
      rename(backup, target);
    }
    throw error;
  }
  safeRemove(root, backup, { recursive: true });
}

export function assertSetupInstallPolicy(input) {
  if ((input.serverRunning || input.tunnelRunning) && !input.stopBeforeInstall) {
    throw new Error(
      "Refusing to replace the runtime while T3 Code is running. Use the up command for a build-then-restart deployment.",
    );
  }
}

async function setup(options = {}) {
  const locations = ensureSafeStateRoot(stateDir());
  ensurePrivateDirectory(locations.logs);
  ensurePrivateDirectory(locations.t3Home);
  recoverRuntimeBackup(locations);
  const codexConfiguration = optionalCodexBedrockConfiguration();
  const serverWasRunning = isRecordedProcessRunning(locations.serverProcess);
  const tunnelWasRunning = isRecordedProcessRunning(locations.tunnelProcess);
  assertSetupInstallPolicy({
    serverRunning: serverWasRunning,
    tunnelRunning: tunnelWasRunning,
    stopBeforeInstall: options.stopBeforeInstall === true,
  });
  const myCli = myCliCapabilityStatus();
  console.log(
    myCli.ready
      ? `CRUX integration ready: ${myCli.binary}`
      : "CRUX integration not configured (MyCli missing); source-control features stay optional.",
  );
  if (codexConfiguration !== null) {
    ensureAmazonCodexSettings(locations.t3Home);
  }

  if (!commandExists("docker") || !commandExists("git") || !commandExists("tar")) {
    throw new Error("Docker, Git, and tar are required for the reproducible runtime build.");
  }
  assertLocalDockerDaemon(process.env);

  const nodeBinary = findNodeBinary();
  const nodeRoot = resolveNodeDistributionRoot(nodeBinary, process.env.T3CODE_NODE_ROOT);
  const runtimePlatform = nodeRuntimeBuildPlatform(nodeBinary);
  const archTarget = resolveNativeArchTarget();
  const fingerprint = sourceFingerprint();
  const buildOutput = `${locations.artifacts}.next-${process.pid}`;
  const runtimeStage = `${locations.runtime}.next-${process.pid}`;
  safeRemove(locations.root, buildOutput, { recursive: true });
  safeRemove(locations.root, runtimeStage, { recursive: true });

  try {
    console.log(
      `Building and smoke-testing the internal-only ${runtimePlatform.label} (${archTarget.napiArch}) runtime in Docker...`,
    );
    run(
      "docker",
      [
        "build",
        "--progress=plain",
        "--platform",
        archTarget.dockerPlatform,
        "--build-arg",
        `T3CODE_RUNTIME_BASE=${runtimePlatform.base}`,
        "--build-arg",
        `T3CODE_RUNTIME_GLIBC=${runtimePlatform.glibc}`,
        "--build-arg",
        `T3CODE_NAPI_ARCH=${archTarget.napiArch}`,
        "--build-arg",
        `T3CODE_AL_MIRROR_ARCH=${archTarget.mirrorArch}`,
        "--build-context",
        `t3code-node=${nodeRoot}`,
        "--file",
        path.join(REPO_ROOT, "deploy", "amazon", "Dockerfile"),
        "--output",
        `type=local,dest=${buildOutput}`,
        REPO_ROOT,
      ],
      {
        env: {
          ...sanitizeRuntimeEnvironment(process.env),
          DOCKER_BUILDKIT: "1",
        },
      },
    );

    const archiveName = "t3code-amazon-runtime.tar.gz";
    const artifacts = fs.readdirSync(buildOutput);
    if (artifacts.length !== 1 || artifacts[0] !== archiveName) {
      throw new Error(`Expected only ${archiveName}, found: ${artifacts.join(", ") || "nothing"}.`);
    }

    ensurePrivateDirectory(runtimeStage);
    console.log("Extracting the lockfile-pinned runtime...");
    extractRuntimeArchive(path.join(buildOutput, archiveName), runtimeStage);

    const entry = runtimeEntry(runtimeStage);
    if (!fs.existsSync(entry)) {
      throw new Error(`Built runtime entry is missing: ${entry}`);
    }
    assertOwnedNotSymlink(entry, "file");
    assertRuntimeNodeVersion(runtimeStage, nodeBinary);

    if (sourceFingerprint() !== fingerprint) {
      throw new Error(
        "Repository sources changed during setup; refusing to install a stale build.",
      );
    }

    if (serverWasRunning || tunnelWasRunning) {
      await stop();
    }
    replaceDirectoryTransactional(runtimeStage, locations.runtime);
    replaceDirectoryTransactional(buildOutput, locations.artifacts);
    writePrivateFile(locations.fingerprint, `${fingerprint}\n`);
    installAmazonSshRunner(locations, nodeBinary);
    console.log(`Runtime installed at ${locations.runtime}`);
  } finally {
    for (const temporaryDirectory of [runtimeStage, buildOutput]) {
      try {
        safeRemove(locations.root, temporaryDirectory, { recursive: true });
      } catch (error) {
        console.warn(`Could not clean setup staging directory ${temporaryDirectory}:`, error);
      }
    }
  }
}

async function start(options = {}) {
  const locations = ensureSafeStateRoot(stateDir());
  // `unique` is undefined for restart, which keeps the recorded tunnel name.
  const tunnelName = selectTunnelName(options.unique);
  ensurePrivateDirectory(locations.logs);
  ensurePrivateDirectory(locations.t3Home);
  recoverRuntimeBackup(locations);
  const codexConfiguration = optionalCodexBedrockConfiguration();

  const nodeBinary = findNodeBinary();
  const tunnelBinary = findTunnelBinary();
  const entry = runtimeEntry(locations.runtime);
  if (!fs.existsSync(entry)) {
    throw new Error("Runtime is not installed. Run the setup command first.");
  }
  assertOwnedNotSymlink(entry, "file");
  assertRuntimeNodeVersion(locations.runtime, nodeBinary);
  installAmazonSshRunner(locations, nodeBinary);
  if (codexConfiguration !== null) {
    ensureAmazonCodexSettings(locations.t3Home);
  }

  const env = serverRuntimeEnvironment(process.env, {
    codexConfigured: codexConfiguration !== null,
  });
  const workspace = workspaceDir();
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }

  let serverStarted = false;
  let tunnelStarted = false;
  try {
    if (!isRecordedProcessRunning(locations.serverProcess)) {
      await assertPortAvailable();
      fs.rmSync(locations.serverProcess, { force: true });
      spawnBackground(nodeBinary, serverArguments(entry, locations.root, workspace), {
        cwd: workspace,
        env,
        logPath: locations.serverLog,
        processPath: locations.serverProcess,
      });
      serverStarted = true;
    }
    await waitForHttp(locations.serverProcess);
    sealRecordedProcessIdentity(locations.serverProcess);

    if (!isRecordedProcessRunning(locations.tunnelProcess)) {
      fs.rmSync(locations.tunnelProcess, { force: true });
      fs.rmSync(locations.publicUrl, { force: true });
      truncatePrivateFile(locations.tunnelLog);
      spawnBackground(tunnelBinary, tunnelArguments(tunnelName), {
        cwd: REPO_ROOT,
        env,
        logPath: locations.tunnelLog,
        processPath: locations.tunnelProcess,
      });
      tunnelStarted = true;
      const publicUrl = await waitForTunnelUrl(
        tunnelBinary,
        locations.tunnelLog,
        env,
        locations.tunnelProcess,
      );
      writePrivateFile(locations.publicUrl, `${publicUrl}\n`);
      // Recorded only once the tunnel answered, so a failed start leaves the
      // previous name in place for restart rather than a name that never existed.
      writePrivateFile(locations.tunnelName, `${tunnelName}\n`);
      sealRecordedProcessIdentity(locations.tunnelProcess);
    } else {
      assertStartableTunnelName({
        recorded: recordedTunnelName(locations),
        requested: tunnelName,
        tunnelRunning: true,
      });
      const record = readProcessRecord(locations.tunnelProcess);
      const publicUrl = discoverTunnelUrlFromList(tunnelBinary, env, record?.pid);
      if (!publicUrl) {
        throw new Error(
          `The running Amazon tunnel URL could not be rediscovered by exact name (${tunnelName}), port, and PID. Run the stop command if it was created under a different name.`,
        );
      }
      writePrivateFile(locations.publicUrl, `${publicUrl}\n`);
      // The listing verified this name against the recorded PID, port, and owner-only
      // ACL, so record it for the read-only commands even if the marker was lost.
      writePrivateFile(locations.tunnelName, `${tunnelName}\n`);
      sealRecordedProcessIdentity(locations.tunnelProcess);
    }
  } catch (error) {
    if (tunnelStarted) {
      await stopRecordedProcess(locations.tunnelProcess, "Amazon tunnel");
    }
    if (serverStarted) {
      await stopRecordedProcess(locations.serverProcess, "T3 server");
    }
    throw error;
  }

  console.log(`T3 server: http://${HOST}:${PORT}`);
  console.log(`Amazon tunnel: ${readPublicUrl(locations)}`);
  console.log("Run the pair command to print a one-time browser URL.");
}

async function up(options = {}) {
  const locations = ensureSafeStateRoot(stateDir());
  // Before setup can stop the running tunnel and hide the mismatch from start.
  assertStartableTunnelName({
    recorded: recordedTunnelName(locations),
    requested: resolveTunnelName({ unique: options.unique }),
    tunnelRunning: isRecordedProcessRunning(locations.tunnelProcess),
  });
  const installedFingerprint = fs.existsSync(locations.fingerprint)
    ? fs.readFileSync(locations.fingerprint, "utf8").trim()
    : null;
  const nodeBinary = findNodeBinary();
  if (
    !fs.existsSync(runtimeEntry(locations.runtime)) ||
    !runtimeNodeVersionMatches(locations.runtime, nodeBinary) ||
    installedFingerprint !== sourceFingerprint()
  ) {
    await setup({ stopBeforeInstall: true });
  }
  await start(options);
}

function recordedPublicUrl(locations = pathsForState()) {
  try {
    return readPublicUrl(locations);
  } catch {
    return null;
  }
}

function readPublicUrl(locations = pathsForState()) {
  if (!fs.existsSync(locations.publicUrl)) {
    throw new Error("No public URL is recorded. Run the start command first.");
  }
  assertOwnedNotSymlink(locations.publicUrl, "file");
  const publicUrl = normalizeOwnedTunnelUrl(fs.readFileSync(locations.publicUrl, "utf8").trim());
  if (!publicUrl) {
    throw new Error("The recorded public URL is not this user's owner-only Amazon tunnel origin.");
  }
  return publicUrl;
}

async function status() {
  const locations = pathsForState();
  const serverRunning = isRecordedProcessRunning(locations.serverProcess);
  const tunnelRunning = isRecordedProcessRunning(locations.tunnelProcess);
  let serverReady = false;
  let publicUrl = null;

  if (serverRunning) {
    try {
      await fetchEnvironmentDescriptor();
      serverReady = true;
    } catch {
      // Status distinguishes a live process from an application ready to serve.
    }
  }
  if (tunnelRunning) {
    const record = readProcessRecord(locations.tunnelProcess);
    try {
      publicUrl = discoverTunnelUrlFromList(
        findTunnelBinary(),
        sanitizeRuntimeEnvironment(process.env),
        record?.pid,
      );
    } catch {
      // A live PID without an authoritative tunnel listing is not ready.
    }
  }

  console.log(
    `server: ${serverReady ? "ready" : serverRunning ? "running (not ready)" : "stopped"}`,
  );
  console.log(`tunnel: ${publicUrl ? "ready" : tunnelRunning ? "running (not ready)" : "stopped"}`);
  if (publicUrl) console.log(`url: ${publicUrl}`);
  if (!serverReady || !publicUrl) process.exitCode = 1;
}

async function pair() {
  const locations = pathsForState();
  if (!isRecordedProcessRunning(locations.serverProcess)) {
    throw new Error("T3 server is not running.");
  }
  if (!isRecordedProcessRunning(locations.tunnelProcess)) {
    throw new Error("Amazon tunnel is not running.");
  }
  try {
    await fetchEnvironmentDescriptor();
  } catch (error) {
    throw new Error(
      `T3 server is not ready: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tunnelBinary = findTunnelBinary();
  const tunnelRecord = readProcessRecord(locations.tunnelProcess);
  const publicUrl = discoverTunnelUrlFromList(
    tunnelBinary,
    sanitizeRuntimeEnvironment(process.env),
    tunnelRecord?.pid,
  );
  if (!publicUrl) {
    throw new Error(
      "Amazon tunnel is not ready with the exact owner-only ACL, name, port, and recorded process.",
    );
  }
  const nodeBinary = findNodeBinary();
  const entry = runtimeEntry(locations.runtime);
  assertRuntimeNodeVersion(locations.runtime, nodeBinary);
  const ttl = process.env.T3CODE_AMAZON_PAIR_TTL || "5m";
  run(nodeBinary, pairingArguments(entry, locations.root, publicUrl, ttl), {
    cwd: workspaceDir(),
    env: sanitizeRuntimeEnvironment(process.env),
  });
}

function logs() {
  const locations = pathsForState();
  for (const [label, logPath] of [
    ["server", locations.serverLog],
    ["tunnel", locations.tunnelLog],
  ]) {
    console.log(`\n== ${label} ==`);
    if (fs.existsSync(logPath)) {
      assertOwnedNotSymlink(logPath, "file");
      const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n");
      console.log(lines.slice(-100).join("\n"));
    } else {
      console.log("(no log)");
    }
  }
}

async function stop() {
  const locations = pathsForState();
  const tunnelStopped = await stopRecordedProcess(locations.tunnelProcess, "Amazon tunnel");
  const serverStopped = await stopRecordedProcess(locations.serverProcess, "T3 server");
  fs.rmSync(locations.publicUrl, { force: true });
  if (!tunnelStopped && !serverStopped) console.log("Nothing is running.");
}

function doctor() {
  for (const command of ["docker", "git", "tar"]) {
    if (!commandExists(command)) {
      throw new Error(`Required command was not found: ${command}`);
    }
  }
  assertLocalDockerDaemon(process.env);
  const nodeBinary = findNodeBinary();
  const codexConfiguration = optionalCodexBedrockConfiguration();
  const nodeRoot = resolveNodeDistributionRoot(nodeBinary, process.env.T3CODE_NODE_ROOT);
  const tunnelBinary = findTunnelBinary();
  const nodeVersionText = run(nodeBinary, ["--version"], { capture: true }).trim();
  const tunnelVersion = run(tunnelBinary, ["--version"], {
    capture: true,
    env: sanitizeRuntimeEnvironment(process.env),
  }).trim();
  const tunnelList = run(tunnelBinary, ["list", "--json"], {
    capture: true,
    env: sanitizeRuntimeEnvironment(process.env),
  });
  try {
    const parsed = JSON.parse(tunnelList);
    if (!Array.isArray(parsed?.tunnels)) {
      throw new Error("missing tunnels array");
    }
  } catch (error) {
    throw new Error(
      `Amazon tunnel authentication check returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const dockerVersion = run("docker", ["version", "--format", "{{.Server.Version}}"], {
    capture: true,
  }).trim();
  const locations = pathsForState();
  const selection = tunnelNameSelection({ locations });
  // `stop` keeps the marker so `restart` can honour it, so the recorded name outlives
  // the tunnel and has to say when it is describing something that is not running.
  const nameNote =
    recordedTunnelName(locations) === selection.name &&
    !isRecordedProcessRunning(locations.tunnelProcess)
      ? ", not currently running"
      : "";
  // The shard label is assigned when the tunnel is created, so the computed host is
  // not reachable on its own. Report the recorded URL when there is one.
  const recordedUrl = recordedPublicUrl(locations);
  const tunnelHost = new URL(expectedTunnelOrigin({ tunnelName: selection.name, alias: null }))
    .hostname;
  let uniqueName;
  try {
    uniqueName = hostTunnelName();
  } catch (error) {
    uniqueName = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const claude = claudeToolboxStatus();
  const kiro = kiroCliStatus();
  const myCli = myCliCapabilityStatus();
  console.log("========== T3 Details ==========");
  console.log(`repository: ${REPO_ROOT}`);
  console.log(`state: ${stateDir()}`);
  console.log(`workspace: ${workspaceDir()}`);
  console.log("========== Dependency Details ==========");
  console.log(`node: ${nodeBinary} (${nodeVersionText})`);
  console.log(`node distribution: ${nodeRoot}`);
  console.log(`docker: ${dockerVersion} (local Unix socket)`);
  console.log("========== Tunnel Details ==========");
  console.log(`tunnel: ${tunnelBinary} (${tunnelVersion})`);
  console.log(`current tunnel name: ${selection.name} (${selection.source}${nameNote})`);
  console.log(
    recordedUrl === null
      ? `tunnel host: ${tunnelHost.replace(".tunnels.", ".<shard>.tunnels.")}`
      : `tunnel url: ${recordedUrl}`,
  );
  console.log(`unique tunnel name: ${uniqueName} (used by start-unique and up-unique)`);
  console.log("tunnel authentication: ready");
  console.log("========== Provider Details ==========");
  if (codexConfiguration === null) {
    console.log("codex: not configured (optional)");
  } else {
    console.log(`codex: ${codexConfiguration.codexBinary}`);
    console.log(
      `codex Bedrock: profile ${codexConfiguration.profile}, region ${codexConfiguration.region ?? "from Codex config"}`,
    );
  }
  console.log(kiro.binary === null ? "kiro: not installed" : `kiro: ${kiro.binary}`);
  if (claude.binary === null) {
    console.log("claude: not installed");
  } else {
    const source = claude.toolbox ? "Toolbox install" : "not installed through Toolbox";
    console.log(`claude: ${claude.binary} (${source})`);
    console.log(`claude version: ${claude.version ?? "not reported"}`);
  }
  if (claude.binary !== null && !claude.toolbox) {
    console.log(`claude warning: not managed by Toolbox. See ${CLAUDE_INSTALL_DOCS}`);
  }
  console.log(
    myCli.ready
      ? `mycli: ${myCli.binary} (CRUX command set ready)`
      : `mycli: not ready (${[
          ...(myCli.crBinary === null ? ["cr CLI"] : []),
          ...myCli.missingCommands,
        ].join(", ")})`,
  );
  if (codexConfiguration === null && kiro.binary === null && claude.binary === null) {
    throw new Error("No coding harness found. Install kiro-cli, Claude Code, or Codex.");
  }
}

function usage() {
  console.log(`Usage: node scripts/t3code-amazon.mjs <command>

Commands:
  setup         Build and install an AL2/AL2023-compatible internal-only runtime
  start         Start the loopback server and owner-only Amazon tunnel
  start-unique  Start with a tunnel name unique to this host
  up            Run setup when needed, then start
  up-unique     Run setup when needed, then start-unique
  status        Report server, tunnel, and public URL state
  url           Print the non-secret public tunnel origin
  pair          Print a one-time pairing URL (never persisted to logs)
  logs          Print the last 100 server and tunnel log lines
  stop          Stop only the recorded server and tunnel processes
  restart       Stop and start under the recorded tunnel name
  doctor        Print resolved prerequisites and paths
`);
}

async function main() {
  const command = process.argv[2];
  // Validated here so a malformed value reports itself once, instead of throwing
  // from a default argument deep inside a command that reports "not ready".
  if (command !== undefined && !HELP_COMMANDS.has(command)) configuredTunnelName();
  const lock = MUTATING_COMMANDS.has(command) ? acquireLifecycleLock(stateDir()) : null;
  try {
    switch (command) {
      case "setup":
        await setup();
        break;
      case "start":
        await start({ unique: false });
        break;
      case "start-unique":
        await start({ unique: true });
        break;
      case "up":
        await up({ unique: false });
        break;
      case "up-unique":
        await up({ unique: true });
        break;
      case "status":
        await status();
        break;
      case "url":
        console.log(readPublicUrl());
        break;
      case "pair":
        await pair();
        break;
      case "logs":
        logs();
        break;
      case "stop":
        await stop();
        break;
      case "restart":
        await stop();
        await start();
        break;
      case "doctor":
        doctor();
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        usage();
        break;
      default:
        usage();
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    releaseLifecycleLock(lock);
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
