#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const lifecycleScript = path.join(repositoryRoot, "scripts/t3code-amazon.mjs");
const defaultChromium = path.join(
  process.env.HOME ?? "",
  ".cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
);
const chromiumExecutable = process.env.T3CODE_AMAZON_CHROMIUM || defaultChromium;
const origin = new URL(process.env.T3CODE_AMAZON_BROWSER_ORIGIN || "http://127.0.0.1:3773");
const projectPath = process.env.T3CODE_AMAZON_BROWSER_PROJECT || repositoryRoot;
const requireFromDesktop = createRequire(
  path.join(repositoryRoot, "apps/desktop/package.json"),
);
const { chromium } = requireFromDesktop("playwright-core");

function step(message) {
  process.stdout.write(`[browser-smoke] ${message}\n`);
}

function issuePairingUrl() {
  let output;
  try {
    output = execFileSync(process.execPath, [lifecycleScript, "pair"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch {
    throw new Error("Could not issue a one-time browser pairing credential.");
  }
  const rawUrl = output.match(/https:\/\/\S+/u)?.[0];
  if (!rawUrl) {
    throw new Error("The pairing command did not return a browser URL.");
  }
  const publicPairingUrl = new URL(rawUrl);
  return new URL(
    `${publicPairingUrl.pathname}${publicPairingUrl.search}${publicPairingUrl.hash}`,
    origin,
  );
}

function monitorPage(page, evidence) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") {
      evidence.requestOrigins.add(url.origin);
    }
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    if (failure?.errorText === "net::ERR_ABORTED") return;
    if (
      failure?.errorText === "net::ERR_INTERNET_DISCONNECTED" &&
      new URL(request.url()).origin === origin.origin
    ) {
      return;
    }
    evidence.requestFailures.push(`${request.method()} ${new URL(request.url()).origin}: ${failure?.errorText ?? "failed"}`);
  });
  page.on("pageerror", (error) => {
    evidence.pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.includes("Failed to load resource") && text.includes("favicon")) return;
    if (
      text.includes("The Content Security Policy directive 'frame-ancestors' is ignored") &&
      text.includes("<meta>")
    ) {
      return;
    }
    if (
      evidence.offline &&
      (text.includes("ERR_INTERNET_DISCONNECTED") ||
        text.includes("Primary environment request failed during fetch-session-state"))
    ) {
      return;
    }
    evidence.consoleErrors.push(text);
  });
}

async function waitForApplication(page) {
  await page.waitForFunction(() => !window.location.hash.includes("token="), null, {
    timeout: 30_000,
  });
  await page.waitForLoadState("networkidle");
  await page.locator("body").waitFor({ state: "visible" });
}

async function assertNoDocumentOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(
    dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `${label} layout overflows horizontally (${dimensions.scrollWidth}px > ${dimensions.clientWidth}px).`,
  );
}

async function ensureProjectAndDraft(page) {
  await page.goto(origin.href, { waitUntil: "domcontentloaded" });
  await waitForApplication(page);

  const composer = page.locator('form[data-chat-composer-form="true"]');
  await composer.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  if (await composer.isVisible().catch(() => false)) {
    return;
  }

  const addProject = page.getByRole("button", { name: "Add project", exact: true });
  if (await addProject.isVisible().catch(() => false)) {
    await addProject.click();
    await page.getByText("Local folder", { exact: true }).waitFor();
    await page.getByText("Local folder", { exact: true }).click();
    const commandInput = page.locator('[aria-label="Command palette"] input').first();
    await commandInput.waitFor();
    await commandInput.fill(projectPath);
    await commandInput.press("Enter");
  }

  await composer.waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

async function verifyAttachments(page) {
  const inputs = page.locator('form[data-chat-composer-form="true"] input[type="file"]');
  assert.equal(await inputs.count(), 2, "Expected separate image and camera attachment inputs.");
  const fixture = path.join(repositoryRoot, "apps/web/public/pwa-icon-192.png");

  await inputs.nth(0).setInputFiles(fixture);
  await page.getByRole("button", { name: "Preview pwa-icon-192.png" }).waitFor();
  await page.getByRole("button", { name: "Remove pwa-icon-192.png" }).click();

  await inputs.nth(1).setInputFiles(fixture);
  await page.getByRole("button", { name: "Preview pwa-icon-192.png" }).waitFor();
  await page.getByRole("button", { name: "Remove pwa-icon-192.png" }).click();
}

async function verifyClientStorage(page) {
  await page.goto(new URL("/settings/client-storage", origin).href, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Agent notifications", level: 3 }).waitFor();
  const enable = page.getByRole("button", { name: "Enable", exact: true });
  if (await enable.isVisible().catch(() => false)) {
    await enable.click();
  }
  await page.getByRole("button", { name: "Disable", exact: true }).waitFor();
  await page
    .getByText(
      /Best-effort closed-app checks|Reconnect fallback only|Open-app delivery only/u,
      { exact: true },
    )
    .waitFor();

  const awareness = await page.evaluate(async () => {
    const response = await fetch("/api/internal/agent-awareness", {
      cache: "no-store",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return {
      body: await response.json(),
      status: response.status,
    };
  });
  assert.equal(awareness.status, 200);
  assert.equal(awareness.body.version, 1);
  assert.ok(Array.isArray(awareness.body.items));
  for (const item of awareness.body.items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ["eventKey", "kind", "threadKey", "url"],
      "Agent awareness exposed more than minimal event metadata.",
    );
    assert.ok(
      new URL(item.url, origin).origin === origin.origin,
      "Agent awareness returned a cross-origin link.",
    );
  }

  await page.getByRole("button", { name: "Refresh browser cache usage" }).click();
  await page.getByText(/cached data|cached record|Inspecting cached data/u).first().waitFor();
}

async function verifyQrScanner(page) {
  await page.goto(new URL("/settings/connections", origin).href, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("This environment", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add environment" }).click();
  await page.getByRole("heading", { name: "Add Environment" }).waitFor();
  await page.getByRole("button", { name: "Scan QR code" }).click();
  await page.getByRole("heading", { name: "Scan pairing QR code" }).waitFor();
  await page.getByText("Point the camera at a T3 Code pairing QR code.").waitFor({
    timeout: 30_000,
  });
  await page.getByText("Frames are decoded on this device by the browser and are never uploaded.").waitFor();
  await page.getByRole("button", { name: "Use manual entry" }).click();
}

async function verifyArchivedControls(page) {
  await page.goto(new URL("/settings/archived", origin).href, {
    waitUntil: "domcontentloaded",
  });
  const search = page.getByRole("searchbox", { name: "Search archived threads" });
  await search.waitFor();
  await search.fill("no-match-smoke-test");
  await search.fill("");
  await page.getByRole("combobox", { name: "Archived thread environment" }).waitFor();
  await page.getByRole("combobox", { name: "Sort by archived date" }).waitFor();
}

async function verifyProviderDiscovery(page) {
  await page.goto(new URL("/settings/providers", origin).href, {
    waitUntil: "domcontentloaded",
  });
  const refresh = page.getByRole("button", { name: "Refresh provider status" });
  await refresh.waitFor();
  await refresh.click();

  const instanceIds = ["codex", "claudeAgent"];
  await page.waitForFunction(
    (ids) =>
      ids.every((id) => {
        const card = document.querySelector(`[data-provider-instance-id="${id}"]`);
        return (
          card?.getAttribute("data-provider-installed") === "true" &&
          Number(card.getAttribute("data-provider-model-count")) > 0
        );
      }),
    instanceIds,
    { timeout: 45_000 },
  );

  const providers = await page.evaluate((ids) => {
    return ids.map((id) => {
      const card = document.querySelector(`[data-provider-instance-id="${id}"]`);
      return {
        id,
        installed: card?.getAttribute("data-provider-installed"),
        modelCount: Number(card?.getAttribute("data-provider-model-count")),
      };
    });
  }, instanceIds);
  for (const provider of providers) {
    assert.equal(provider.installed, "true", `${provider.id} was not detected as installed.`);
    assert.ok(provider.modelCount > 0, `${provider.id} did not expose any models.`);
  }
}

async function verifyPwa(page, navigationResponse) {
  const csp = navigationResponse?.headers()["content-security-policy"] ?? "";
  assert.match(csp, /default-src 'self'/u);
  assert.doesNotMatch(csp, /t3\.codes|clerk|posthog|sentry/u);

  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest");
    return response.json();
  });
  assert.equal(manifest.name, "T3 Code for Amazon");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.share_target.action, "/share-target");

  const serviceWorker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (worker && worker.state !== "activated") {
      await new Promise((resolve) => {
        worker.addEventListener(
          "statechange",
          () => {
            if (worker.state === "activated") resolve(undefined);
          },
          { once: true },
        );
      });
    }
    return {
      active: worker?.state ?? null,
      scope: registration.scope,
      indexedDb: "indexedDB" in globalThis,
      secureContext: globalThis.isSecureContext,
    };
  });
  assert.equal(serviceWorker.active, "activated");
  assert.equal(serviceWorker.scope, `${origin.origin}/`);
  assert.equal(serviceWorker.indexedDb, true);
  assert.equal(serviceWorker.secureContext, true);
}

async function verifyOfflineShell(page, evidence) {
  evidence.offline = true;
  await page.context().setOffline(true);
  try {
    const response = await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(
      response?.fromServiceWorker(),
      true,
      "Offline navigation should be served by the service worker.",
    );
    await page.locator("body").waitFor({ state: "visible" });
    assert.notEqual(await page.title(), "");
  } finally {
    await page.context().setOffline(false);
    evidence.offline = false;
  }
  await page.reload({ waitUntil: "networkidle" });
}

async function verifyTouchTerminal(page) {
  await ensureProjectAndDraft(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  const toggle = page.getByRole("button", { name: "Toggle terminal drawer" });
  await toggle.waitFor({ state: "visible" });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  const toolbar = page.getByRole("toolbar", { name: "Terminal accessory keys" });
  await toolbar.waitFor({ state: "visible", timeout: 30_000 });
  await toolbar.getByRole("button", { name: "Control modifier" }).click();
  await toolbar.getByRole("button", { name: "Control modifier" }).click();
  await toolbar.getByRole("button", { name: "Alt modifier" }).click();
  await toolbar.getByRole("button", { name: "Dash" }).click();
  await toolbar.getByRole("button", { name: "Escape" }).click();
  await toolbar.getByRole("button", { name: "Tab" }).click();
  for (const name of ["Tilde", "Pipe", "Slash"]) {
    await toolbar.getByRole("button", { name }).click();
  }
}

async function run() {
  assert.ok(fs.existsSync(chromiumExecutable), `Chromium was not found at ${chromiumExecutable}.`);
  const pairingUrl = issuePairingUrl();
  const evidence = {
    requestOrigins: new Set(),
    requestFailures: [],
    pageErrors: [],
    consoleErrors: [],
    offline: false,
  };

  const browser = await chromium.launch({
    executablePath: chromiumExecutable,
    headless: true,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });

  try {
    const touchContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      serviceWorkers: "allow",
    });
    await touchContext.grantPermissions(["camera", "notifications"], {
      origin: origin.origin,
    });
    await touchContext.addInitScript(() => {
      Reflect.deleteProperty(globalThis, "BarcodeDetector");
    });
    const page = await touchContext.newPage();
    monitorPage(page, evidence);

    step("pairing an isolated browser session");
    const navigationResponse = await page.goto(pairingUrl.href, {
      waitUntil: "domcontentloaded",
    });
    await waitForApplication(page);
    assert.equal(new URL(page.url()).hash, "", "Pairing token remained in browser history.");
    assert.ok(
      (await touchContext.cookies(origin.origin)).some((cookie) => cookie.httpOnly),
      "Pairing did not establish an HttpOnly browser session.",
    );

    step("checking PWA install and offline shell behavior");
    await verifyPwa(page, navigationResponse);
    await verifyOfflineShell(page, evidence);

    step("checking phone project, image, and camera flows");
    await ensureProjectAndDraft(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Attach images" }).first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Take a photo" }).first().waitFor({ state: "visible" });
    await verifyAttachments(page);
    await assertNoDocumentOverflow(page, "phone");

    step("checking tablet and touch-terminal behavior");
    await page.setViewportSize({ width: 820, height: 1180 });
    await assertNoDocumentOverflow(page, "tablet");
    await verifyTouchTerminal(page);

    step("checking internal client storage, notifications, and QR scanner");
    await verifyClientStorage(page);
    await verifyQrScanner(page);
    await verifyArchivedControls(page);

    step("checking Toolbox provider and model discovery");
    await verifyProviderDiscovery(page);

    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: await touchContext.storageState(),
      serviceWorkers: "allow",
    });
    const desktopPage = await desktopContext.newPage();
    monitorPage(desktopPage, evidence);
    await desktopPage.goto(origin.href, { waitUntil: "networkidle" });
    await ensureProjectAndDraft(desktopPage);
    await assertNoDocumentOverflow(desktopPage, "desktop");
    await desktopContext.close();
    await touchContext.close();

    const allowedOrigins = new Set([origin.origin]);
    const unexpectedOrigins = [...evidence.requestOrigins].filter(
      (requestOrigin) => !allowedOrigins.has(requestOrigin),
    );
    assert.deepEqual(unexpectedOrigins, [], `Unexpected browser request origins: ${unexpectedOrigins.join(", ")}`);
    assert.deepEqual(evidence.requestFailures, [], `Browser request failures: ${evidence.requestFailures.join("; ")}`);
    assert.deepEqual(evidence.pageErrors, [], `Browser page errors: ${evidence.pageErrors.join("; ")}`);
    assert.deepEqual(evidence.consoleErrors, [], `Browser console errors: ${evidence.consoleErrors.join("; ")}`);
    step(`passed; browser requests stayed on ${origin.origin}`);
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(`[browser-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
