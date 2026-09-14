/**
 * Midway refresh — the one-click path behind the preview toolbar button.
 *
 * The full import wizard refuses to read Chrome while it runs, because a
 * whole-profile import from a live database could snapshot a torn write. For
 * Midway that caution costs more than it saves: the session is a handful of
 * cookies, `VACUUM INTO` gives a consistent snapshot without ever opening
 * Chrome's file for write (verified against a running Chrome), and the user
 * needs to do this every day. So this path skips the running-browser check,
 * copies only the Midway SSO cookies, and falls back to the `mwinit` jar when
 * no Chrome profile holds a live session.
 *
 * @module MidwayRefresh
 */
import {
  type MidwayRefreshFailureReason,
  MidwayRefreshFailureReason as MidwayRefreshFailureReasonSchema,
  type MidwayRefreshResult,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BrowserSession from "../BrowserSession.ts";
import { writeCookies } from "./BrowserImport.ts";
import { readChromiumCookies } from "./ChromiumCookies.ts";
import { bareHost, type ImportedCookie } from "./CookieDatabase.ts";
import {
  hasLiveMidwaySession,
  MIDWAY_AUTH_HOST,
  MIDWAY_SESSION_COOKIE,
  readMidwayCookies,
} from "./MidwayCookies.ts";
import {
  BROWSER_IMPORT_SOURCES,
  listSourceProfiles,
  resolveCookieDatabase,
  sourcePathContext,
  type BrowserImportPathContext,
  type BrowserImportSourceDefinition,
} from "./Sources.ts";

export class MidwayRefreshFailedError extends Schema.TaggedError<MidwayRefreshFailedError>()(
  "MidwayRefreshFailedError",
  {
    reason: MidwayRefreshFailureReasonSchema,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The reason token rides in the message: IPC flattens the error to its
  // message, and the renderer maps the token back to user-facing copy.
  override get message(): string {
    return `Refreshing the Midway session failed: ${this.reason}.`;
  }
}

export class MidwayRefresh extends Context.Service<
  MidwayRefresh,
  {
    readonly refresh: (input: {
      readonly scope: string;
      readonly persistent: boolean;
      readonly namespace?: BrowserSession.BrowserSessionPartitionNamespace;
    }) => Effect.Effect<MidwayRefreshResult, MidwayRefreshFailedError>;
  }
>()("@t3tools/desktop/preview/BrowserImport/MidwayRefresh") {}

/**
 * Hosts whose cookies make up a Midway session: the auth origin itself plus
 * the `auth.midway.*` aliases that carry `amazon_enterprise_access`. Per-site
 * `amzn_sso_token` cookies are deliberately left out — they are minted on the
 * SSO hop and expire in minutes.
 */
export function isMidwayCookieHost(host: string): boolean {
  const bare = bareHost(host).toLowerCase();
  return (
    bare === MIDWAY_AUTH_HOST ||
    bare.endsWith(`.${MIDWAY_AUTH_HOST}`) ||
    /^auth\.midway\.(aws\.dev|amazon\.dev|aws\.a2z\.com)$/.test(bare)
  );
}

export function selectMidwayCookies(
  cookies: ReadonlyArray<ImportedCookie>,
  nowSeconds: number,
): ReadonlyArray<ImportedCookie> {
  return cookies.filter(
    (cookie) =>
      isMidwayCookieHost(new URL(cookie.url).hostname) &&
      (cookie.expirationDate === undefined || cookie.expirationDate > nowSeconds),
  );
}

/** Expiry of the imported `session` cookie, for the toast. */
function sessionExpiry(cookies: ReadonlyArray<ImportedCookie>): string | undefined {
  const session = cookies.find(
    (cookie) =>
      cookie.name === MIDWAY_SESSION_COOKIE &&
      new URL(cookie.url).hostname === MIDWAY_AUTH_HOST &&
      cookie.expirationDate !== undefined,
  );
  return session?.expirationDate === undefined
    ? undefined
    : DateTime.formatIso(DateTime.makeUnsafe(session.expirationDate * 1000));
}

interface ChromeProfileSession {
  readonly profileName: string;
  readonly cookies: ReadonlyArray<ImportedCookie>;
}

/**
 * The Chrome profile with a live Midway session, most recently written first.
 * Reads happen without the running-browser pre-flight: only the Midway rows
 * are used, and the snapshot is transactionally consistent.
 */
const readChromeMidwaySession = Effect.fnUntraced(function* (
  chrome: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  platform: NodeJS.Platform,
  nowSeconds: number,
): Effect.fn.Return<
  ChromeProfileSession | undefined,
  MidwayRefreshFailedError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const profiles = yield* listSourceProfiles(chrome, context);
  const candidates: Array<{ readonly name: string; readonly database: string; mtime: number }> = [];
  for (const profile of profiles) {
    const database = yield* resolveCookieDatabase(chrome, context, profile.directory);
    if (database === undefined) continue;
    const mtime = yield* fileSystem.stat(database).pipe(
      Effect.map((info) => Number(info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0)),
      Effect.orElseSucceed(() => 0),
    );
    candidates.push({ name: profile.name, database, mtime });
  }
  candidates.sort((left, right) => right.mtime - left.mtime);

  const userDataDirectory = chrome.userDataDirectory(context);
  for (const candidate of candidates) {
    const read = yield* readChromiumCookies({
      cookieDatabasePath: candidate.database,
      keychainService: chrome.keychainService,
      keychainAccount: chrome.keychainAccount,
      linuxSecretApplication: chrome.linuxSecretApplication,
      ...(platform === "win32" && userDataDirectory !== undefined
        ? { windowsLocalStatePath: context.path.join(userDataDirectory, "Local State") }
        : {}),
      platform,
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) => {
        // A denied keychain prompt is the one failure the user can fix; every
        // other read problem on one profile should not stop the others.
        const reason: MidwayRefreshFailureReason =
          cause.reason === "needsKeychainApproval" ? "needsKeychainApproval" : "readFailed";
        return new MidwayRefreshFailedError({ reason, cause });
      }),
    );
    const cookies = selectMidwayCookies(read.cookies, nowSeconds);
    if (hasLiveMidwaySession({ cookies, expired: 0 })) {
      return { profileName: candidate.name, cookies };
    }
  }
  return undefined;
});

export const make = Effect.gen(function* MidwayRefreshMake() {
  const browserSession = yield* BrowserSession.BrowserSession;
  const platform = yield* HostProcessPlatform;
  const platformServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const pathContext = yield* sourcePathContext;
  const chrome = BROWSER_IMPORT_SOURCES.find((source) => source.id === "chrome");
  const midway = BROWSER_IMPORT_SOURCES.find((source) => source.id === "midway");

  const refresh = Effect.fn("MidwayRefresh.refresh")(function* (input: {
    readonly scope: string;
    readonly persistent: boolean;
    readonly namespace?: BrowserSession.BrowserSessionPartitionNamespace;
  }) {
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);

    // Chrome first: its session is the one the user actually renews by
    // browsing, and it usually outlives the mwinit jar.
    let source: MidwayRefreshResult["source"] | undefined;
    let sourceProfileName: string | undefined;
    let cookies: ReadonlyArray<ImportedCookie> = [];
    if (chrome !== undefined && chrome.platforms.includes(pathContext.platform)) {
      const fromChrome = yield* readChromeMidwaySession(
        chrome,
        pathContext,
        platform,
        nowSeconds,
      ).pipe(
        Effect.provide(platformServices),
        Effect.map((session) => ({ _tag: "read" as const, session })),
        // A keychain denial is surfaced only if the jar cannot rescue us either.
        Effect.catchTag("MidwayRefreshFailedError", (error) =>
          error.reason === "needsKeychainApproval"
            ? Effect.succeed({ _tag: "denied" as const, error })
            : Effect.fail(error),
        ),
      );
      if (fromChrome._tag === "denied") {
        const jar = yield* readJar(midway, pathContext, nowSeconds).pipe(
          Effect.provide(platformServices),
        );
        if (jar === undefined) return yield* fromChrome.error;
        source = "midway";
        cookies = jar;
      } else if (fromChrome.session !== undefined) {
        source = "chrome";
        sourceProfileName = fromChrome.session.profileName;
        cookies = fromChrome.session.cookies;
      }
    }
    if (source === undefined) {
      const jar = yield* readJar(midway, pathContext, nowSeconds).pipe(
        Effect.provide(platformServices),
      );
      if (jar === undefined) {
        return yield* new MidwayRefreshFailedError({ reason: "noLiveSession" });
      }
      source = "midway";
      cookies = jar;
    }

    const session = yield* browserSession
      .getSession(input.scope, input.persistent, input.namespace)
      .pipe(
        Effect.mapError(
          (cause) => new MidwayRefreshFailedError({ reason: "sessionUnavailable", cause }),
        ),
      );
    const written = yield* writeCookies(session, {
      cookies,
      undecryptable: 0,
      undecryptableHosts: [],
    });
    const expiresAt = sessionExpiry(cookies);
    return {
      source,
      ...(sourceProfileName === undefined ? {} : { sourceProfileName }),
      imported: written.imported,
      skipped: written.skipped,
      ...(expiresAt === undefined ? {} : { sessionExpiresAt: expiresAt }),
    } satisfies MidwayRefreshResult;
  });

  return MidwayRefresh.of({ refresh });
});

/** The mwinit jar's Midway cookies, or undefined when it holds no live session. */
const readJar = Effect.fnUntraced(function* (
  midway: BrowserImportSourceDefinition | undefined,
  context: BrowserImportPathContext,
  nowSeconds: number,
): Effect.fn.Return<ReadonlyArray<ImportedCookie> | undefined, never, FileSystem.FileSystem> {
  if (midway === undefined) return undefined;
  const jarPath = yield* resolveCookieDatabase(midway, context, ".");
  if (jarPath === undefined) return undefined;
  const jar = yield* readMidwayCookies(jarPath, nowSeconds).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (jar === undefined || !hasLiveMidwaySession(jar)) return undefined;
  return selectMidwayCookies(jar.cookies, nowSeconds);
});

export const layer = Layer.effect(MidwayRefresh, make);
