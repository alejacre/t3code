import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { make } from "./AmznMidwayCookieSync.ts";

const MIDWAY_JAR = [
  "#HttpOnly_.midway-auth.amazon.com\tTRUE\t/\tTRUE\t1788982214\tamazon_enterprise_access\tposture",
  "#HttpOnly_midway-auth.amazon.com\tFALSE\t/\tTRUE\t1789042821\t__Host-session\tsession-value",
].join("\n");

const INSECURE_COOKIE_JAR = "build.amazon.com\tFALSE\t/\tFALSE\t1789042822\tbraveheart\tpreference";

function makeBrowserSession() {
  const cookies: Electron.CookiesSetDetails[] = [];
  const set = vi.fn((details: Electron.CookiesSetDetails) => {
    cookies.push(details);
    return Promise.resolve();
  });
  return {
    browserSession: { cookies: { set } } as unknown as Electron.Session,
    cookies,
    set,
  };
}

describe("AmznMidwayCookieSync", () => {
  it.effect("stays dormant outside Amazon internal builds", () =>
    Effect.gen(function* () {
      const readCookieJar = vi.fn((_filePath: string) => Effect.succeed(Option.none<string>()));
      const service = make(
        {
          amazonEnabled: false,
          midwayCookiePath: "/Users/test/.midway/cookie",
        },
        { readCookieJar },
      );
      const browser = makeBrowserSession();

      yield* service.syncSession(browser.browserSession);

      assert.equal(readCookieJar.mock.calls.length, 0);
      assert.equal(browser.set.mock.calls.length, 0);
    }),
  );

  it.effect("makes imported Midway session cookies available to cross-site auth", () =>
    Effect.gen(function* () {
      const readCookieJar = vi.fn((_filePath: string) => Effect.succeed(Option.some(MIDWAY_JAR)));
      const service = make(
        {
          amazonEnabled: true,
          midwayCookiePath: "/Users/test/.midway/cookie",
        },
        { readCookieJar },
      );
      const browser = makeBrowserSession();

      yield* service.syncSession(browser.browserSession, false);

      assert.deepEqual(readCookieJar.mock.calls, [["/Users/test/.midway/cookie"]]);
      assert.deepEqual(browser.cookies, [
        {
          url: "https://midway-auth.amazon.com/",
          name: "__Host-session",
          value: "session-value",
          path: "/",
          secure: true,
          httpOnly: true,
          expirationDate: 1_789_042_821,
          sameSite: "no_restriction",
        },
        {
          url: "https://midway-auth.amazon.com/",
          name: "sentry_braveheart",
          value: "1",
          domain: ".midway-auth.amazon.com",
          path: "/",
          secure: true,
          sameSite: "no_restriction",
        },
      ]);
    }),
  );

  it.effect("imports AEA posture when no managed refresher owns the session", () =>
    Effect.gen(function* () {
      const readCookieJar = vi.fn((_filePath: string) => Effect.succeed(Option.some(MIDWAY_JAR)));
      const service = make(
        {
          amazonEnabled: true,
          midwayCookiePath: "/Users/test/.midway/cookie",
        },
        { readCookieJar },
      );
      const browser = makeBrowserSession();

      yield* service.syncSession(browser.browserSession);

      assert.deepEqual(
        browser.cookies.find(({ name }) => name === "amazon_enterprise_access"),
        {
          url: "https://midway-auth.amazon.com/",
          name: "amazon_enterprise_access",
          value: "posture",
          domain: ".midway-auth.amazon.com",
          path: "/",
          secure: true,
          httpOnly: true,
          expirationDate: 1_788_982_214,
          sameSite: "no_restriction",
        },
      );
    }),
  );

  it.effect("keeps insecure jar cookies off the SameSite=None policy", () =>
    Effect.gen(function* () {
      const readCookieJar = vi.fn((_filePath: string) =>
        Effect.succeed(Option.some(INSECURE_COOKIE_JAR)),
      );
      const service = make(
        {
          amazonEnabled: true,
          midwayCookiePath: "/Users/test/.midway/cookie",
        },
        { readCookieJar },
      );
      const browser = makeBrowserSession();

      yield* service.syncSession(browser.browserSession);

      assert.deepEqual(
        browser.cookies.find(({ name }) => name === "braveheart"),
        {
          url: "http://build.amazon.com/",
          name: "braveheart",
          value: "preference",
          domain: "build.amazon.com",
          path: "/",
          secure: false,
          httpOnly: false,
          expirationDate: 1_789_042_822,
        },
      );
    }),
  );

  it.effect("uses an explicit Midway jar path and ignores an unavailable jar", () =>
    Effect.gen(function* () {
      const readCookieJar = vi.fn((_filePath: string) => Effect.succeed(Option.none<string>()));
      const service = make(
        {
          amazonEnabled: true,
          midwayCookiePath: "/custom/midway.jar",
        },
        { readCookieJar },
      );
      const browser = makeBrowserSession();

      yield* service.syncSession(browser.browserSession);

      assert.deepEqual(readCookieJar.mock.calls, [["/custom/midway.jar"]]);
      assert.equal(browser.set.mock.calls.length, 0);
    }),
  );
});
