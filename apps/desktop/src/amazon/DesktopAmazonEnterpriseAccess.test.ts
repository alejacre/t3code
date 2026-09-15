import type * as Electron from "electron";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  decodeNativeMessagingResponse,
  encodeNativeMessagingRequest,
  make,
} from "./DesktopAmazonEnterpriseAccess.ts";

const JWT_EXPIRATION = 4_102_444_800;
const POSTURE_JWT = [
  "header",
  Buffer.from(JSON.stringify({ exp: JWT_EXPIRATION }), "utf8").toString("base64url"),
  "signature",
].join(".");

interface HeaderRegistration {
  readonly filter: { readonly urls: ReadonlyArray<string> };
  readonly listener: (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (response: Electron.BeforeSendResponse) => void,
  ) => void;
}

function makeBrowserSession(deferRemoval = false) {
  const cookies: Electron.CookiesSetDetails[] = [];
  const registrations: HeaderRegistration[] = [];
  let markRemovalStarted = () => {};
  const removalStarted = new Promise<void>((resolve) => {
    markRemovalStarted = resolve;
  });
  let releaseRemoval = () => {};
  const removalFinished = deferRemoval
    ? new Promise<void>((resolve) => {
        releaseRemoval = resolve;
      })
    : Promise.resolve();
  const removeCookie = vi.fn((_url: string, _name: string) => {
    markRemovalStarted();
    return removalFinished;
  });
  const setCookie = vi.fn((details: Electron.CookiesSetDetails) => {
    cookies.push(details);
    return Promise.resolve();
  });
  const onBeforeSendHeaders = vi.fn(
    (filter: HeaderRegistration["filter"], listener: HeaderRegistration["listener"]) => {
      registrations.push({ filter, listener });
    },
  );
  const browserSession = {
    cookies: { remove: removeCookie, set: setCookie },
    webRequest: { onBeforeSendHeaders },
  } as unknown as Electron.Session;
  return { browserSession, cookies, registrations, releaseRemoval, removalStarted };
}

describe("DesktopAmazonEnterpriseAccess", () => {
  it("encodes and decodes Chromium native-messaging frames", () => {
    const request = encodeNativeMessagingRequest("getConfig");
    const requestBody = Buffer.from(JSON.stringify("getConfig"), "utf8");
    assert.equal(request.readUInt32LE(0), requestBody.length);
    assert.deepEqual(request.subarray(4), requestBody);

    const responseBody = Buffer.from(JSON.stringify({ ResultCode: 0 }), "utf8");
    const responseHeader = Buffer.alloc(4);
    responseHeader.writeUInt32LE(responseBody.length);
    assert.equal(
      decodeNativeMessagingResponse(Buffer.concat([responseHeader, responseBody])),
      responseBody.toString("utf8"),
    );

    assert.throws(
      () => decodeNativeMessagingResponse(Buffer.alloc(3)),
      /truncated response header/u,
    );
    responseHeader.writeUInt32LE(responseBody.length + 1);
    assert.throws(
      () => decodeNativeMessagingResponse(Buffer.concat([responseHeader, responseBody])),
      /invalid response length/u,
    );
  });

  it.effect("stays dormant outside Amazon internal macOS builds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestNativeHost = vi.fn((_command: string) =>
          Promise.reject(new Error("must not run")),
        );
        const resolveExtensionVersion = vi.fn((_homeDirectory: string, _extensionId: string) =>
          Promise.reject(new Error("must not run")),
        );

        for (const runtime of [
          {
            homeDirectory: "/Users/test",
            amazonEnabled: false,
            platform: "darwin" as const,
          },
          {
            homeDirectory: "/home/test",
            amazonEnabled: true,
            platform: "linux" as const,
          },
        ]) {
          const service = yield* make(runtime, {
            requestNativeHost,
            resolveExtensionVersion,
          });
          yield* service.configureBrowserSession({} as Electron.Session);
        }

        assert.equal(requestNativeHost.mock.calls.length, 0);
        assert.equal(resolveExtensionVersion.mock.calls.length, 0);
      }),
    ),
  );

  it.effect("applies managed posture cookies and AEA headers to preview sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestNativeHost = vi.fn((command: string): Promise<string> => {
          switch (command) {
            case "getConfig":
              return Promise.resolve(
                JSON.stringify({
                  ResultCode: 0,
                  auth_domain: [
                    "https://auth.midway.aws.dev",
                    "http://auth.midway.aws.dev",
                    "not-a-url",
                  ],
                  config_refresh_interval: 3_600,
                  cookie_expiry: 900,
                  cookie_refresh_interval: 60,
                }),
              );
            case "ping":
              return Promise.resolve(
                JSON.stringify({
                  ResultCode: 0,
                  ACMEVersion: "3.5.5",
                  AEAVersion: "3.5.5",
                  DeviceInfo: "managed-device",
                  DeviceStack: "acme",
                }),
              );
            case "getAcmeData":
              return Promise.resolve(JSON.stringify({ ResultCode: 0, Jwt: POSTURE_JWT }));
            default:
              return Promise.reject(new Error(`Unexpected AEA command: ${command}`));
          }
        });
        const resolveExtensionVersion = vi.fn((_homeDirectory: string, _extensionId: string) =>
          Promise.resolve(null),
        );
        const browser = makeBrowserSession(true);
        const nowSeconds = Math.round((yield* Clock.currentTimeMillis) / 1_000);
        const service = yield* make(
          {
            homeDirectory: "/Users/test",
            amazonEnabled: true,
            platform: "darwin",
          },
          {
            requestNativeHost,
            resolveExtensionVersion,
          },
        );

        const configuration = yield* Effect.forkChild(
          service.configureBrowserSession(browser.browserSession),
        );
        yield* Effect.promise(() => browser.removalStarted);
        assert.isUndefined(browser.cookies.find(({ name }) => name === "amazon_enterprise_access"));
        browser.releaseRemoval();
        yield* Fiber.join(configuration);

        assert.deepEqual(
          requestNativeHost.mock.calls.map(([command]) => command),
          ["getConfig", "ping", "getAcmeData"],
        );
        assert.deepEqual(resolveExtensionVersion.mock.calls, [
          ["/Users/test", "bkbighdlgofgdhcjnhocalbkiehhpdei"],
        ]);
        assert.deepEqual(
          Object.fromEntries(browser.cookies.map((cookie) => [cookie.name, cookie])),
          {
            amazon_enterprise_access: {
              url: "https://auth.midway.aws.dev/",
              domain: "auth.midway.aws.dev",
              name: "amazon_enterprise_access",
              value: POSTURE_JWT,
              path: "/",
              secure: true,
              sameSite: "no_restriction",
              expirationDate: JWT_EXPIRATION,
            },
            aea_plugin_present: {
              url: "https://auth.midway.aws.dev/",
              domain: "auth.midway.aws.dev",
              name: "aea_plugin_present",
              value: Buffer.from('{ "plugin_version": "2.0.6" }', "utf8").toString("base64"),
              path: "/",
              secure: true,
              sameSite: "no_restriction",
              expirationDate: nowSeconds + 14 * 24 * 60 * 60,
            },
          },
        );
        assert.equal(browser.registrations.length, 1);
        const registration = browser.registrations[0];
        assert.isDefined(registration);
        assert.deepEqual(registration.filter, {
          urls: ["https://auth.midway.aws.dev/*"],
        });
        let intercepted: Electron.BeforeSendResponse | undefined;
        registration.listener(
          {
            requestHeaders: {
              "User-Agent": "T3",
              "x-amzn-aea-version": "stale",
            },
          } as unknown as Electron.OnBeforeSendHeadersListenerDetails,
          (response) => {
            intercepted = response;
          },
        );
        assert.deepEqual(intercepted?.requestHeaders, {
          "User-Agent": "T3",
          "X-Amzn-AEAExtension-Version": "2.0.6",
          "X-Amzn-AEA-Version": "3.5.5",
          "X-Amzn-ACME-Version": "3.5.5",
          "X-Amzn-Device-Info": "managed-device",
          "X-Amzn-Device-Stack": "acme",
        });
        assert.notInclude(Object.values(intercepted?.requestHeaders ?? {}).join(" "), POSTURE_JWT);
      }),
    ),
  );
});
