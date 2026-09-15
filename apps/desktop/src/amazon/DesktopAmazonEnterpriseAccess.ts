// @effect-diagnostics nodeBuiltinImport:off - Electron native messaging requires framed Node child-process stdio.
// @effect-diagnostics globalTimers:off - The child-process bridge owns a bounded imperative timeout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type * as Electron from "electron";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const AEA_EXTENSION_ID = "bkbighdlgofgdhcjnhocalbkiehhpdei";
const AEA_EXTENSION_COMPATIBILITY_VERSION = "2.0.6";
const AEA_NATIVE_HOST_PATH = "/usr/local/amazon/bin/acme_amazon_enterprise_access";
const AEA_NATIVE_HOST_TIMEOUT_MS = 20_000;
const AEA_NATIVE_HOST_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const AEA_POSTURE_COOKIE_NAME = "amazon_enterprise_access";
const AEA_PRESENCE_COOKIE_NAME = "aea_plugin_present";
const AEA_PRESENCE_COOKIE_EXPIRY_SECONDS = 14 * 24 * 60 * 60;
const DEFAULT_COOKIE_EXPIRY_SECONDS = 15 * 60;
const DEFAULT_COOKIE_REFRESH_INTERVAL_SECONDS = 60;
const DEFAULT_CONFIG_REFRESH_INTERVAL_SECONDS = 60 * 60;

const DEFAULT_AUTH_DOMAINS = [
  "https://auth-integ.midway.aws.a2z.com",
  "https://auth.midway.aws.a2z.com",
  "https://midway-auth-integ.us-east-1.amazon.com",
  "https://midway-auth-integ.aka.amazon.com",
  "https://midway-auth.amazon.com",
  "https://midway-auth-itar.amazon.com",
  "https://federate-dev.corp.amazon.com",
  "https://federate.amazon.com",
  "https://idp.federate.amazon.com",
  "https://federate-int.corp.amazon.com",
  "https://idp-integ.federate.amazon.com",
  "https://idp-us-west-2.federate.amazon.com",
  "https://idp-us-east-1.federate.amazon.com",
  "https://idp-eu-west-1.federate.amazon.com",
  "https://idp-integ-us-west-2.federate.amazon.com",
  "https://idp-integ-us-east-1.federate.amazon.com",
  "https://idp-integ-eu-west-1.federate.amazon.com",
  "https://idp-us-west-2.federate-dev.corp.amazon.com",
  "https://idp-us-east-1.federate-dev.corp.amazon.com",
  "https://idp-eu-west-1.federate-dev.corp.amazon.com",
  "https://idp-integ-us-west-2.federate-dev.corp.amazon.com",
  "https://idp-integ-us-east-1.federate-dev.corp.amazon.com",
  "https://idp-integ-eu-west-1.federate-dev.corp.amazon.com",
  "https://auth.midway.amazon.dev",
  "https://auth.midway.aws.dev",
  "https://auth-integ.midway.amazon.dev",
  "https://auth-integ.midway.aws.dev",
] as const;

const AeaConfigurationResponse = Schema.Struct({
  ResultCode: Schema.Number,
  auth_domain: Schema.optionalKey(Schema.Array(Schema.String)),
  auth_domains: Schema.optionalKey(Schema.Array(Schema.String)),
  chrome_extension_id: Schema.optionalKey(Schema.String),
  config_refresh_interval: Schema.optionalKey(Schema.Number),
  cookie_expiry: Schema.optionalKey(Schema.Number),
  cookie_refresh_interval: Schema.optionalKey(Schema.Number),
});

const AeaPingResponse = Schema.Struct({
  ResultCode: Schema.Number,
  ACMEVersion: Schema.optionalKey(Schema.String),
  AEAVersion: Schema.optionalKey(Schema.String),
  DeviceInfo: Schema.optionalKey(Schema.String),
  DeviceStack: Schema.optionalKey(Schema.String),
});

const AeaPostureResponse = Schema.Struct({
  ResultCode: Schema.Number,
  Jwt: Schema.String,
});

const AeaExtensionManifest = Schema.Struct({
  version: Schema.String,
});

const AeaJwtClaims = Schema.Struct({
  exp: Schema.Number,
});

const decodeConfigurationResponse = Schema.decodeEffect(
  Schema.fromJsonString(AeaConfigurationResponse),
);
const decodePingResponse = Schema.decodeEffect(Schema.fromJsonString(AeaPingResponse));
const decodePostureResponse = Schema.decodeEffect(Schema.fromJsonString(AeaPostureResponse));
const decodeExtensionManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(AeaExtensionManifest),
);
const decodeJwtClaims = Schema.decodeUnknownSync(Schema.fromJsonString(AeaJwtClaims));

interface AmazonEnterpriseAccessConfiguration {
  readonly authDomains: ReadonlyArray<string>;
  readonly configRefreshIntervalSeconds: number;
  readonly cookieExpirySeconds: number;
  readonly cookieRefreshIntervalSeconds: number;
}

interface AmazonEnterpriseAccessPing {
  readonly acmeVersion: string;
  readonly aeaVersion: string;
  readonly deviceInfo: string;
  readonly deviceStack: string;
}

interface AmazonEnterpriseAccessCredential {
  readonly expirationDate: number;
  readonly jwt: string;
}

export interface DesktopAmazonEnterpriseAccessRuntime {
  readonly homeDirectory: string;
  readonly amazonEnabled: boolean;
  readonly platform: NodeJS.Platform;
}

export interface DesktopAmazonEnterpriseAccessDependencies {
  readonly requestNativeHost: (command: string) => Promise<string>;
  readonly resolveExtensionVersion: (
    homeDirectory: string,
    extensionId: string,
  ) => Promise<string | null>;
}

export class DesktopAmazonEnterpriseAccess extends Context.Service<
  DesktopAmazonEnterpriseAccess,
  {
    readonly configureBrowserSession: (browserSession: Electron.Session) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/amazon/DesktopAmazonEnterpriseAccess") {}

class AmazonEnterpriseAccessRequestError extends Schema.TaggedError<AmazonEnterpriseAccessRequestError>()(
  "AmazonEnterpriseAccessRequestError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["invalid-response", "request-failed"]),
  },
) {}

function clampInterval(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.round(value));
}

function normalizeAuthDomains(domains: ReadonlyArray<string>): ReadonlyArray<string> {
  const normalized = new Set<string>();
  for (const rawDomain of domains) {
    try {
      const url = new URL(rawDomain);
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hostname === ""
      ) {
        continue;
      }
      normalized.add(url.origin);
    } catch {
      // Ignore malformed managed configuration entries.
    }
  }
  return [...normalized];
}

function normalizeConfiguration(
  response: typeof AeaConfigurationResponse.Type,
): AmazonEnterpriseAccessConfiguration {
  const configuredDomains = response.auth_domain ?? response.auth_domains ?? [];
  const authDomains = normalizeAuthDomains(configuredDomains);
  return {
    authDomains: authDomains.length > 0 ? authDomains : [...DEFAULT_AUTH_DOMAINS],
    configRefreshIntervalSeconds: clampInterval(
      response.config_refresh_interval,
      DEFAULT_CONFIG_REFRESH_INTERVAL_SECONDS,
      5 * 60,
    ),
    cookieExpirySeconds: clampInterval(response.cookie_expiry, DEFAULT_COOKIE_EXPIRY_SECONDS, 60),
    cookieRefreshIntervalSeconds: clampInterval(
      response.cookie_refresh_interval,
      DEFAULT_COOKIE_REFRESH_INTERVAL_SECONDS,
      30,
    ),
  };
}

function decodeCredential(
  response: typeof AeaPostureResponse.Type,
  fallbackExpirySeconds: number,
  nowSeconds: number,
): AmazonEnterpriseAccessCredential | null {
  const jwt = response.Jwt.trim();
  if (response.ResultCode !== 0 || jwt === "") return null;

  let expirationDate = nowSeconds + fallbackExpirySeconds;
  try {
    const payload = jwt.split(".")[1];
    if (payload !== undefined) {
      const claims = decodeJwtClaims(Buffer.from(payload, "base64url").toString("utf8"));
      expirationDate = claims.exp;
    }
  } catch {
    // ACME has already validated the token. The managed expiry remains a safe fallback.
  }

  if (expirationDate <= nowSeconds) return null;
  return { expirationDate, jwt };
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

async function resolveInstalledExtensionVersion(
  homeDirectory: string,
  extensionId: string,
): Promise<string | null> {
  const chromeRoot = NodePath.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );
  let profiles: ReadonlyArray<NodeFS.Dirent>;
  try {
    profiles = await NodeFS.promises.readdir(chromeRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const versions: string[] = [];
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const extensionRoot = NodePath.join(chromeRoot, profile.name, "Extensions", extensionId);
    let installedVersions: ReadonlyArray<NodeFS.Dirent>;
    try {
      installedVersions = await NodeFS.promises.readdir(extensionRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const installedVersion of installedVersions) {
      if (!installedVersion.isDirectory()) continue;
      try {
        const manifest = decodeExtensionManifest(
          await NodeFS.promises.readFile(
            NodePath.join(extensionRoot, installedVersion.name, "manifest.json"),
            "utf8",
          ),
        );
        versions.push(manifest.version);
      } catch {
        // A partially updated Chrome profile should not disable AEA in other profiles.
      }
    }
  }

  return versions.sort(compareVersions).at(-1) ?? null;
}

export function encodeNativeMessagingRequest(command: string): Buffer {
  const body = Buffer.from(JSON.stringify(command), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export function decodeNativeMessagingResponse(output: Buffer): string {
  if (output.length < 4) {
    throw new Error("AEA native host returned a truncated response header.");
  }
  const bodyLength = output.readUInt32LE(0);
  if (bodyLength > AEA_NATIVE_HOST_MAX_RESPONSE_BYTES || output.length !== bodyLength + 4) {
    throw new Error("AEA native host returned an invalid response length.");
  }
  return output.subarray(4).toString("utf8");
}

function requestNativeHost(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(AEA_NATIVE_HOST_PATH, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const finish = (result: { readonly error: Error } | { readonly output: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if ("error" in result) {
        reject(result.error);
      } else {
        resolve(result.output);
      }
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ error: new Error("AEA native host request timed out.") });
    }, AEA_NATIVE_HOST_TIMEOUT_MS);

    child.once("error", () => {
      finish({ error: new Error("Failed to start the AEA native host.") });
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > AEA_NATIVE_HOST_MAX_RESPONSE_BYTES + 4) {
        child.kill("SIGTERM");
        finish({ error: new Error("AEA native host response exceeded the size limit.") });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.once("close", (exitCode) => {
      if (exitCode !== 0) {
        finish({ error: new Error("AEA native host exited unsuccessfully.") });
        return;
      }
      try {
        finish({ output: decodeNativeMessagingResponse(Buffer.concat(stdout)) });
      } catch {
        finish({ error: new Error("AEA native host returned an invalid response.") });
      }
    });
    child.stdin.once("error", () => {
      finish({ error: new Error("Failed to write to the AEA native host.") });
    });
    child.stdin.end(encodeNativeMessagingRequest(command));
  });
}

function presenceCookieValue(extensionVersion: string): string {
  return Buffer.from(`{ "plugin_version": "${extensionVersion}" }`, "utf8").toString("base64");
}

function setHeader(requestHeaders: Record<string, string>, name: string, value: string): void {
  const existingName = Object.keys(requestHeaders).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  if (existingName !== undefined && existingName !== name) {
    delete requestHeaders[existingName];
  }
  requestHeaders[name] = value;
}

export function mergeAmazonEnterpriseAccessHeaders(
  requestHeaders: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged = { ...requestHeaders };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== "") setHeader(merged, name, value);
  }
  return merged;
}

function makeRequestHeaders(
  extensionVersion: string | null,
  ping: AmazonEnterpriseAccessPing | null,
): Readonly<Record<string, string>> {
  return {
    ...(extensionVersion === null ? {} : { "X-Amzn-AEAExtension-Version": extensionVersion }),
    ...(ping?.aeaVersion ? { "X-Amzn-AEA-Version": ping.aeaVersion } : {}),
    ...(ping?.acmeVersion ? { "X-Amzn-ACME-Version": ping.acmeVersion } : {}),
    ...(ping?.deviceInfo ? { "X-Amzn-Device-Info": ping.deviceInfo } : {}),
    ...(ping?.deviceStack ? { "X-Amzn-Device-Stack": ping.deviceStack } : {}),
  };
}

const defaultDependencies: DesktopAmazonEnterpriseAccessDependencies = {
  requestNativeHost,
  resolveExtensionVersion: resolveInstalledExtensionVersion,
};

export const make = Effect.fn("DesktopAmazonEnterpriseAccess.make")(function* (
  runtime: DesktopAmazonEnterpriseAccessRuntime,
  dependencies: DesktopAmazonEnterpriseAccessDependencies = defaultDependencies,
) {
  if (!runtime.amazonEnabled || runtime.platform !== "darwin") {
    return DesktopAmazonEnterpriseAccess.of({
      configureBrowserSession: () => Effect.void,
    });
  }

  const configuredSessions = new Set<Electron.Session>();
  const failedOperations = new Set<string>();
  const refreshMutex = yield* Semaphore.make(1);
  let configuration: AmazonEnterpriseAccessConfiguration = {
    authDomains: [...DEFAULT_AUTH_DOMAINS],
    configRefreshIntervalSeconds: DEFAULT_CONFIG_REFRESH_INTERVAL_SECONDS,
    cookieExpirySeconds: DEFAULT_COOKIE_EXPIRY_SECONDS,
    cookieRefreshIntervalSeconds: DEFAULT_COOKIE_REFRESH_INTERVAL_SECONDS,
  };
  let credential: AmazonEnterpriseAccessCredential | null = null;
  let extensionVersion = AEA_EXTENSION_COMPATIBILITY_VERSION;
  let initialized = false;
  let ping: AmazonEnterpriseAccessPing | null = null;

  const recoverRequest = <A>(
    operation: string,
    request: Effect.Effect<A, AmazonEnterpriseAccessRequestError>,
  ): Effect.Effect<A | null> =>
    request.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          failedOperations.delete(operation);
        }),
      ),
      Effect.catch(() => {
        const shouldLog = !failedOperations.has(operation);
        failedOperations.add(operation);
        return shouldLog
          ? Effect.logWarning("Amazon Enterprise Access helper request failed.", {
              component: "desktop-amazon-enterprise-access",
              operation,
            }).pipe(Effect.as(null))
          : Effect.succeed(null);
      }),
    );

  const readConfiguration = recoverRequest(
    "getConfig",
    Effect.tryPromise({
      try: () => dependencies.requestNativeHost("getConfig"),
      catch: () =>
        new AmazonEnterpriseAccessRequestError({
          operation: "getConfig",
          reason: "request-failed",
        }),
    }).pipe(
      Effect.flatMap((raw) =>
        decodeConfigurationResponse(raw).pipe(
          Effect.mapError(
            () =>
              new AmazonEnterpriseAccessRequestError({
                operation: "getConfig",
                reason: "invalid-response",
              }),
          ),
        ),
      ),
      Effect.filterOrFail(
        (response) => response.ResultCode === 0,
        () =>
          new AmazonEnterpriseAccessRequestError({
            operation: "getConfig",
            reason: "invalid-response",
          }),
      ),
    ),
  );

  const readPing = recoverRequest(
    "ping",
    Effect.tryPromise({
      try: () => dependencies.requestNativeHost("ping"),
      catch: () =>
        new AmazonEnterpriseAccessRequestError({
          operation: "ping",
          reason: "request-failed",
        }),
    }).pipe(
      Effect.flatMap((raw) =>
        decodePingResponse(raw).pipe(
          Effect.mapError(
            () =>
              new AmazonEnterpriseAccessRequestError({
                operation: "ping",
                reason: "invalid-response",
              }),
          ),
        ),
      ),
      Effect.filterOrFail(
        (response) => response.ResultCode === 0,
        () =>
          new AmazonEnterpriseAccessRequestError({
            operation: "ping",
            reason: "invalid-response",
          }),
      ),
    ),
  );

  const readCredential = recoverRequest(
    "getAcmeData",
    Effect.tryPromise({
      try: () => dependencies.requestNativeHost("getAcmeData"),
      catch: () =>
        new AmazonEnterpriseAccessRequestError({
          operation: "getAcmeData",
          reason: "request-failed",
        }),
    }).pipe(
      Effect.flatMap((raw) =>
        decodePostureResponse(raw).pipe(
          Effect.mapError(
            () =>
              new AmazonEnterpriseAccessRequestError({
                operation: "getAcmeData",
                reason: "invalid-response",
              }),
          ),
        ),
      ),
    ),
  );

  const configureRequestHeaders = (browserSession: Electron.Session): void => {
    browserSession.webRequest.onBeforeSendHeaders(
      {
        urls: configuration.authDomains.map((domain) => `${domain}/*`),
      },
      (
        details: Electron.OnBeforeSendHeadersListenerDetails,
        callback: (response: Electron.BeforeSendResponse) => void,
      ) => {
        callback({
          requestHeaders: mergeAmazonEnterpriseAccessHeaders(
            details.requestHeaders,
            makeRequestHeaders(extensionVersion, ping),
          ),
        });
      },
    );
  };

  const applyCookies = Effect.fn("desktop.amazonEnterpriseAccess.applyCookies")(function* (
    browserSession: Electron.Session,
  ) {
    const currentCredential = credential;
    if (currentCredential === null) return;
    const nowSeconds = Math.round((yield* Clock.currentTimeMillis) / 1_000);
    const cookieDetails: Electron.CookiesSetDetails[] = configuration.authDomains.flatMap(
      (domain) => {
        const hostname = new URL(domain).hostname;
        const postureCookie: Electron.CookiesSetDetails = {
          url: `${domain}/`,
          domain: hostname,
          name: AEA_POSTURE_COOKIE_NAME,
          value: currentCredential.jwt,
          path: "/",
          secure: true,
          sameSite: "no_restriction",
          expirationDate: currentCredential.expirationDate,
        };
        const version = extensionVersion ?? ping?.aeaVersion;
        return version === undefined
          ? [postureCookie]
          : [
              postureCookie,
              {
                url: `${domain}/`,
                domain: hostname,
                name: AEA_PRESENCE_COOKIE_NAME,
                value: presenceCookieValue(version),
                path: "/",
                secure: true,
                sameSite: "no_restriction",
                expirationDate: nowSeconds + AEA_PRESENCE_COOKIE_EXPIRY_SECONDS,
              },
            ];
      },
    );
    const results = yield* Effect.promise(() =>
      Promise.allSettled(
        cookieDetails.map(async (details) => {
          if (details.name === AEA_POSTURE_COOKIE_NAME) {
            await browserSession.cookies.remove(details.url, details.name).catch(() => undefined);
          }
          await browserSession.cookies.set(details);
        }),
      ),
    );
    const operation = "setCookies";
    if (results.some((result) => result.status === "rejected")) {
      if (!failedOperations.has(operation)) {
        failedOperations.add(operation);
        yield* Effect.logWarning("Amazon Enterprise Access cookies could not be applied.", {
          component: "desktop-amazon-enterprise-access",
        });
      }
    } else {
      failedOperations.delete(operation);
    }
  });

  const applyCookiesToAll = Effect.fn("desktop.amazonEnterpriseAccess.applyCookiesToAll")(
    function* () {
      yield* Effect.forEach(configuredSessions, applyCookies, {
        concurrency: "unbounded",
        discard: true,
      });
    },
  );

  const refreshConfiguration = Effect.fn("desktop.amazonEnterpriseAccess.refreshConfiguration")(
    function* () {
      const response = yield* readConfiguration;
      if (response !== null) {
        configuration = normalizeConfiguration(response);
      }

      const pingResponse = yield* readPing;
      if (pingResponse !== null) {
        ping = {
          acmeVersion: pingResponse.ACMEVersion?.trim() ?? "",
          aeaVersion: pingResponse.AEAVersion?.trim() ?? "",
          deviceInfo: pingResponse.DeviceInfo?.trim() ?? "",
          deviceStack: pingResponse.DeviceStack?.trim() ?? "",
        };
      }

      extensionVersion =
        (yield* Effect.promise(() =>
          dependencies.resolveExtensionVersion(runtime.homeDirectory, AEA_EXTENSION_ID),
        ).pipe(Effect.catchCause(() => Effect.succeed(null)))) ??
        AEA_EXTENSION_COMPATIBILITY_VERSION;

      for (const browserSession of configuredSessions) {
        configureRequestHeaders(browserSession);
      }
    },
  );

  const refreshCredential = Effect.fn("desktop.amazonEnterpriseAccess.refreshCredential")(
    function* () {
      const response = yield* readCredential;
      if (response === null) return;
      const nowSeconds = Math.round((yield* Clock.currentTimeMillis) / 1_000);
      const nextCredential = decodeCredential(
        response,
        configuration.cookieExpirySeconds,
        nowSeconds,
      );
      if (nextCredential === null) {
        if (!failedOperations.has("getAcmeData")) {
          failedOperations.add("getAcmeData");
          yield* Effect.logWarning(
            "Amazon Enterprise Access returned an unusable posture credential.",
            {
              component: "desktop-amazon-enterprise-access",
            },
          );
        }
        return;
      }
      credential = nextCredential;
      failedOperations.delete("getAcmeData");
    },
  );

  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.seconds(configuration.cookieRefreshIntervalSeconds));
      if (configuredSessions.size === 0) continue;
      yield* refreshMutex.withPermits(1)(
        refreshCredential().pipe(Effect.andThen(applyCookiesToAll())),
      );
    }
  }).pipe(Effect.forkScoped);

  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.seconds(configuration.configRefreshIntervalSeconds));
      if (configuredSessions.size === 0) continue;
      yield* refreshMutex.withPermits(1)(
        refreshConfiguration().pipe(Effect.andThen(applyCookiesToAll())),
      );
    }
  }).pipe(Effect.forkScoped);

  const configureBrowserSession: DesktopAmazonEnterpriseAccess["Service"]["configureBrowserSession"] =
    (browserSession) =>
      refreshMutex
        .withPermits(1)(
          Effect.gen(function* () {
            if (!initialized) {
              yield* refreshConfiguration();
              initialized = true;
            }
            configuredSessions.add(browserSession);
            const nowSeconds = Math.round((yield* Clock.currentTimeMillis) / 1_000);
            if (credential === null || credential.expirationDate <= nowSeconds + 60) {
              yield* refreshCredential();
            }
            configureRequestHeaders(browserSession);
            yield* applyCookies(browserSession);
          }),
        )
        .pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Amazon Enterprise Access preview setup failed.", {
              component: "desktop-amazon-enterprise-access",
            }),
          ),
        );

  return DesktopAmazonEnterpriseAccess.of({ configureBrowserSession });
});

export const layer = Layer.effect(
  DesktopAmazonEnterpriseAccess,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* make({
      homeDirectory: environment.homeDirectory,
      amazonEnabled: environment.amazonEnabled,
      platform: environment.platform,
    });
  }),
);
