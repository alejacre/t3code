/**
 * Midway cookie extraction.
 *
 * `mwinit` (Amazon's Midway CLI) keeps the SSO session it obtains in a
 * libcurl-written Netscape cookie jar at `~/.midway/cookie`. The file is plain
 * text owned by the user, so there is no key, no consent prompt and no lock:
 * seven tab-separated columns per cookie, `#`-prefixed comments, and curl's
 * `#HttpOnly_` marker glued to the domain of HttpOnly cookies.
 *
 * The cookie that matters is `session` on `midway-auth.amazon.com`. With it in
 * a profile, any internal site that redirects to Midway completes the SSO hop
 * without asking for the hardware key again. The per-host `amzn_sso_token`
 * cookies the jar also holds are short-lived and come along for free.
 *
 * @module MidwayCookies
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { cookieScope, type ImportedCookie } from "./CookieDatabase.ts";

/** Where the session cookie the import exists for lives. */
export const MIDWAY_AUTH_HOST = "midway-auth.amazon.com";
export const MIDWAY_SESSION_COOKIE = "session";

export class MidwayCookieReadError extends Schema.TaggedErrorClass<MidwayCookieReadError>()(
  "MidwayCookieReadError",
  {
    cookieJarPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read the Midway cookie jar at ${this.cookieJarPath}.`;
  }
}

const HTTP_ONLY_PREFIX = "#HttpOnly_";

/**
 * One parsed jar. `expired` counts rows dropped because their expiry had
 * already passed: Electron would accept them and immediately evict them, so
 * they are tallied as skipped instead of reported as imported.
 */
export interface MidwayCookieJar {
  readonly cookies: ReadonlyArray<ImportedCookie>;
  readonly expired: number;
}

/**
 * Parses a Netscape cookie file. Lines that are blank, comments (other than
 * the HttpOnly marker) or have fewer than seven columns are ignored. A value
 * containing tabs is kept whole by rejoining everything after the sixth column.
 */
export function parseNetscapeCookies(text: string, nowSeconds: number): MidwayCookieJar {
  const cookies: Array<ImportedCookie> = [];
  let expired = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const httpOnly = line.startsWith(HTTP_ONLY_PREFIX);
    if (line.startsWith("#") && !httpOnly) continue;
    const columns = (httpOnly ? line.slice(HTTP_ONLY_PREFIX.length) : line).split("\t");
    if (columns.length < 7) continue;
    const [host, , path, secureFlag, expiryText, name, ...valueParts] = columns as [
      string,
      string,
      string,
      string,
      string,
      string,
      ...string[],
    ];
    if (host === "" || name === "" || host.includes("\u0000")) continue;
    const expiry = Number(expiryText);
    if (!Number.isFinite(expiry)) continue;
    // 0 marks a session cookie in the Netscape format.
    const expirationDate = expiry > 0 ? Math.floor(expiry) : undefined;
    if (expirationDate !== undefined && expirationDate <= nowSeconds) {
      expired += 1;
      continue;
    }
    const secure = secureFlag.toUpperCase() === "TRUE";
    const cookiePath = path.startsWith("/") ? path : "/";
    const scope = cookieScope(host, cookiePath, secure);
    cookies.push({
      url: scope.url,
      name,
      value: valueParts.join("\t"),
      domain: scope.domain,
      path: cookiePath,
      secure,
      httpOnly,
      expirationDate,
      // The format carries no SameSite attribute. `unspecified` lets Chromium
      // apply its default (Lax), which still sends the session on the
      // top-level redirects the Midway hop consists of.
      sameSite: "unspecified",
    });
  }
  return { cookies, expired };
}

/**
 * Whether the jar still holds a live Midway session. Without it the import
 * writes nothing that signs the profile in, so the source reports itself as
 * expired rather than letting the user import a jar of stale tokens.
 */
export function hasLiveMidwaySession(jar: MidwayCookieJar): boolean {
  return jar.cookies.some(
    (cookie) =>
      cookie.name === MIDWAY_SESSION_COOKIE && new URL(cookie.url).hostname === MIDWAY_AUTH_HOST,
  );
}

export const readMidwayCookies = Effect.fn("MidwayCookies.readMidwayCookies")(function* (
  cookieJarPath: string,
  nowSeconds?: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem
    .readFileString(cookieJarPath)
    .pipe(Effect.mapError((cause) => new MidwayCookieReadError({ cookieJarPath, cause })));
  const now = nowSeconds ?? Math.floor((yield* Clock.currentTimeMillis) / 1000);
  return parseNetscapeCookies(text, now);
});
