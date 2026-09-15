import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeDirectory = path.resolve(process.argv[2] ?? "");
const runtimeManifest = path.join(runtimeDirectory, "package.json");
const requireFromRuntime = createRequire(runtimeManifest);
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(resource, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  return fetch(resource, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function resolvePackageImportEntry(requireFrom, packageName) {
  const searchPaths = requireFrom.resolve.paths(packageName) ?? [];
  for (const searchPath of searchPaths) {
    const packageDirectory = path.join(searchPath, packageName);
    const manifestPath = path.join(packageDirectory, "package.json");
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const rootExport = manifest.exports?.["."] ?? manifest.exports;
    const target =
      typeof rootExport === "string" ? rootExport : rootExport?.import;
    if (typeof target !== "string" || !target.startsWith("./")) {
      throw new Error(`${packageName} does not define a relative import export.`);
    }

    const entry = path.resolve(packageDirectory, target);
    const relative = path.relative(packageDirectory, entry);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`${packageName} import export escapes its package directory.`);
    }
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
      throw new Error(`${packageName} import export is missing: ${entry}`);
    }
    return entry;
  }
  throw new Error(`Could not find ${packageName} from the packaged runtime.`);
}

async function smokeFileSearch() {
  const entry = resolvePackageImportEntry(requireFromRuntime, "@ff-labs/fff-node");
  const { FileFinder } = await import(pathToFileURL(entry).href);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-fff-smoke-"));
  fs.mkdirSync(path.join(fixture, "src"));
  fs.writeFileSync(
    path.join(fixture, "src", "amazon-tunnel-smoke.ts"),
    "export const amazonTunnelSmoke = true;\n",
  );

  const created = FileFinder.create({
    basePath: fixture,
    disableContentIndexing: true,
    disableWatch: true,
  });
  assert.equal(created.ok, true, created.ok ? undefined : created.error);
  const finder = created.value;
  try {
    const scanned = await finder.waitForScan(10_000);
    assert.equal(scanned.ok, true, scanned.ok ? undefined : scanned.error);
    assert.equal(scanned.value, true, "FFF scan timed out.");
    const result = finder.fileSearch("amazon-tunnel-smoke", { pageSize: 10 });
    assert.equal(result.ok, true, result.ok ? undefined : result.error);
    assert.ok(
      result.value.items.some((item) => item.relativePath === "src/amazon-tunnel-smoke.ts"),
      "FFF did not return the fixture file.",
    );
  } finally {
    finder.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

async function smokePty() {
  const nodePty = requireFromRuntime("node-pty");
  const output = await new Promise((resolve, reject) => {
    const terminal = nodePty.spawn("/bin/sh", ["-lc", "printf t3code-pty-smoke"], {
      cols: 80,
      rows: 24,
      cwd: runtimeDirectory,
      env: { ...process.env, TERM: "xterm-256color" },
    });
    let data = "";
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error("node-pty smoke test timed out."));
    }, 10_000);
    terminal.onData((chunk) => {
      data += chunk;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(new Error(`node-pty smoke process exited with ${exitCode}.`));
        return;
      }
      resolve(data);
    });
  });
  assert.match(output, /t3code-pty-smoke/);
}

function smokeServerBundle() {
  const entry = path.join(runtimeDirectory, "dist", "bin.mjs");
  assert.ok(fs.existsSync(entry), `Server bundle is missing: ${entry}`);
  const result = spawnSync(process.execPath, [entry, "--help"], {
    cwd: runtimeDirectory,
    env: {
      ...process.env,
      T3CODE_INTERNAL_ONLY: "1",
      T3CODE_TELEMETRY_ENABLED: "false",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /T3 Code|Run the T3 Code server/i);
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port === null) {
          reject(new Error("Could not reserve a runtime smoke port."));
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForDescriptor(baseUrl, child) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Runtime smoke server exited with ${child.exitCode}.`);
    }
    try {
      const response = await fetchWithTimeout(
        `${baseUrl}/.well-known/t3/environment`,
        {},
        1_000,
      );
      const descriptor = await response.json();
      assert.equal(response.status, 200);
      assert.equal(typeof descriptor.environmentId, "string");
      assert.equal(typeof descriptor.serverVersion, "string");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Runtime smoke server did not become ready: ${lastError?.message ?? "timeout"}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

function parsePairingToken(output) {
  const pairUrl = output.match(/Pair URL:\s*(\S+)/u)?.[1];
  if (!pairUrl) return null;
  return new URLSearchParams(new URL(pairUrl).hash.slice(1)).get("token");
}

async function openAuthenticatedWebSocket(baseUrl, cookie) {
  const ticketResponse = await fetchWithTimeout(
    `${baseUrl}/api/auth/websocket-ticket`,
    {
      method: "POST",
      headers: { cookie },
    },
  );
  assert.equal(ticketResponse.status, 200);
  const ticket = (await ticketResponse.json()).ticket;
  assert.equal(typeof ticket, "string");
  const socketUrl = new URL(baseUrl);
  socketUrl.protocol = "ws:";
  socketUrl.pathname = "/ws";
  socketUrl.searchParams.set("wsTicket", ticket);

  const socket = new WebSocket(socketUrl);
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Authenticated WebSocket smoke timed out.")),
        10_000,
      );
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Authenticated WebSocket smoke failed."));
      });
    });
  } finally {
    socket.close();
  }
}

async function smokeRunningServer() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-server-smoke-"));
  const home = path.join(fixture, "home");
  const workspace = path.join(fixture, "workspace");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const entry = path.join(runtimeDirectory, "dist", "bin.mjs");
  const env = {
    ...process.env,
    T3CODE_INTERNAL_ONLY: "1",
    T3CODE_TELEMETRY_ENABLED: "false",
  };
  const child = spawn(
    process.execPath,
    [
      entry,
      "start",
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      home,
      "--no-browser",
      workspace,
    ],
    {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();

  try {
    await waitForDescriptor(baseUrl, child);

    const indexResponse = await fetchWithTimeout(`${baseUrl}/`);
    const indexHtml = await indexResponse.text();
    assert.equal(indexResponse.status, 200);
    assert.match(indexHtml, /Content-Security-Policy/u);
    assert.match(
      indexHtml,
      /connect-src 'self' https:\/\/\*\.tunnels\.lab\.aws\.dev wss:\/\/\*\.tunnels\.lab\.aws\.dev/u,
    );
    assert.match(indexHtml, /manifest\.webmanifest/u);

    const assets = [
      ...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/gu),
    ].map((match) => match[1]);
    assert.ok(assets.length > 0, "Built app shell did not reference JS or CSS assets.");
    for (const asset of new Set(assets)) {
      const response = await fetchWithTimeout(`${baseUrl}${asset}`);
      assert.equal(response.status, 200, `Missing built asset: ${asset}`);
    }

    for (const requestPath of [
      "/manifest.webmanifest",
      "/sw.js",
      "/settings/client-storage",
    ]) {
      const response = await fetchWithTimeout(`${baseUrl}${requestPath}`);
      assert.equal(response.status, 200, `Runtime route failed: ${requestPath}`);
    }

    const pairing = spawnSync(
      process.execPath,
      [
        entry,
        "auth",
        "pairing",
        "create",
        "--base-dir",
        home,
        "--base-url",
        baseUrl,
        "--ttl",
        "2m",
        "--label",
        "runtime-smoke",
      ],
      { cwd: workspace, env, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(pairing.status, 0, "Pairing credential smoke command failed.");
    const credential = parsePairingToken(pairing.stdout);
    assert.ok(credential, "Pairing credential smoke command did not return a token.");

    const sessionResponse = await fetchWithTimeout(
      `${baseUrl}/api/auth/browser-session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential }),
      },
    );
    assert.equal(sessionResponse.status, 200);
    const setCookie =
      sessionResponse.headers.getSetCookie?.()[0] ?? sessionResponse.headers.get("set-cookie");
    assert.ok(setCookie, "Browser pairing did not set a session cookie.");
    const cookie = setCookie.split(";", 1)[0];
    await openAuthenticatedWebSocket(baseUrl, cookie);
  } finally {
    await stopChild(child);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

async function main() {
  if (!fs.existsSync(runtimeManifest)) {
    throw new Error(`Runtime package is missing: ${runtimeManifest}`);
  }
  assert.equal(
    fs.readFileSync(path.join(runtimeDirectory, ".t3code-node-version"), "utf8").trim(),
    process.version,
    "Runtime Node version marker does not match the native build interpreter.",
  );
  assert.match(
    fs
      .readFileSync(
        path.join(runtimeDirectory, ".t3code-node-distribution-sha256"),
        "utf8",
      )
      .trim(),
    /^[a-f0-9]{64}$/u,
    "Runtime Node distribution fingerprint is missing or malformed.",
  );

  smokeServerBundle();
  await smokeFileSearch();
  await smokePty();
  await smokeRunningServer();
  console.log(
    "Runtime smoke tests passed: server, assets, pairing, WebSocket, FFF search, and node-pty.",
  );
}

if (pathToFileURL(path.resolve(process.argv[1] || "")).href === import.meta.url) {
  await main();
}
