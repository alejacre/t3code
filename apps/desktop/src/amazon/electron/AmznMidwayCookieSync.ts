import type { Session } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { parseMidwayCookieJar } from "./AmznMidwayCookies.ts";

export interface AmznMidwayCookieSyncRuntime {
  readonly amazonEnabled: boolean;
  readonly midwayCookiePath: string;
}

export interface AmznMidwayCookieSyncDependencies {
  readonly readCookieJar: (filePath: string) => Effect.Effect<Option.Option<string>>;
}

export class AmznMidwayCookieSync extends Context.Service<
  AmznMidwayCookieSync,
  {
    readonly syncSession: (targetSession: Session, includePosture?: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/amazon/electron/AmznMidwayCookieSync") {}

export function make(
  runtime: AmznMidwayCookieSyncRuntime,
  dependencies: AmznMidwayCookieSyncDependencies,
) {
  const syncSession = Effect.fn("AmznMidwayCookieSync.syncSession")(function* (
    targetSession: Session,
    includePosture = true,
  ) {
    if (!runtime.amazonEnabled) return;

    const raw = yield* dependencies.readCookieJar(runtime.midwayCookiePath);
    if (Option.isNone(raw) || raw.value === "") return;

    yield* Effect.forEach(
      parseMidwayCookieJar(raw.value).filter(
        (cookie) => includePosture || cookie.name !== "amazon_enterprise_access",
      ),
      (cookie) =>
        Effect.promise(() =>
          targetSession.cookies.set(
            cookie.secure ? { ...cookie, sameSite: "no_restriction" } : cookie,
          ),
        ).pipe(Effect.ignore),
      { concurrency: "unbounded", discard: true },
    );

    yield* Effect.promise(() =>
      targetSession.cookies.set({
        url: "https://midway-auth.amazon.com/",
        name: "sentry_braveheart",
        value: "1",
        domain: ".midway-auth.amazon.com",
        path: "/",
        secure: true,
        sameSite: "no_restriction",
      }),
    ).pipe(Effect.ignore);
  });

  return AmznMidwayCookieSync.of({ syncSession });
}

export const layer = Layer.effect(
  AmznMidwayCookieSync,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configuredCookiePath = process.env.MIDWAY_COOKIE_PATH?.trim();
    return make(
      {
        amazonEnabled: environment.amazonEnabled,
        midwayCookiePath:
          configuredCookiePath || path.join(environment.homeDirectory, ".midway", "cookie"),
      },
      {
        readCookieJar: (filePath) =>
          fileSystem.readFileString(filePath).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none()),
          ),
      },
    );
  }),
);
