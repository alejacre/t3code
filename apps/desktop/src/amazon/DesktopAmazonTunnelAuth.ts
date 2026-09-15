import { BrowserWindow, session, type Cookie, type Session } from "electron";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import {
  resolveAmazonTunnelAuthUrl,
  resolveAmazonTunnelOrigin,
} from "@t3tools/shared/amazonTunnel";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as AmznMidwayCookieSync from "./electron/AmznMidwayCookieSync.ts";

const AUTH_TIMEOUT = Duration.minutes(3);
const OIDC_COOKIE_NAME = "oidc-auth";

export class DesktopAmazonTunnelAuth extends Context.Service<
  DesktopAmazonTunnelAuth,
  {
    readonly authenticate: (url: string) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/amazon/DesktopAmazonTunnelAuth") {}

const getCookie = Effect.fn("desktop.amazonTunnelAuth.getCookie")(function* (
  targetSession: Session,
  url: string,
  name: string,
) {
  const cookies = yield* Effect.promise(() => targetSession.cookies.get({ url, name })).pipe(
    Effect.orElseSucceed(() => [] as Cookie[]),
  );
  return cookies[0];
});

const relaxOidcCookie = Effect.fn("desktop.amazonTunnelAuth.relaxOidcCookie")(function* (
  targetSession: Session,
  targetOrigin: string,
  oidc: Cookie,
) {
  yield* Effect.promise(() =>
    targetSession.cookies.set({
      url: targetOrigin,
      name: oidc.name,
      value: oidc.value,
      ...(oidc.domain ? { domain: oidc.domain } : {}),
      path: oidc.path || "/",
      secure: true,
      httpOnly: oidc.httpOnly ?? true,
      sameSite: "no_restriction",
      ...(oidc.expirationDate ? { expirationDate: oidc.expirationDate } : {}),
    }),
  ).pipe(Effect.ignore);
});

async function followSignInLink(authWindow: BrowserWindow): Promise<boolean> {
  try {
    const href = (await authWindow.webContents.executeJavaScript(
      `(() => { const link = [...document.querySelectorAll("a")].find((candidate) => /sign in/i.test(candidate.textContent || "")); return link ? link.href : null; })()`,
    )) as string | null;
    if (!href || authWindow.isDestroyed()) return false;
    await authWindow.loadURL(href);
    return true;
  } catch {
    return false;
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const runAuthWindow = Effect.fn("desktop.amazonTunnelAuth.runAuthWindow")(function* (input: {
  readonly preAuthUrl: string;
  readonly targetOrigin: string;
  readonly targetSession: Session;
}): Effect.fn.Return<void, never, Scope.Scope> {
  const authWindow = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new BrowserWindow({
          show: false,
          width: 480,
          height: 640,
          title: "Amazon Tunnel Sign In",
          webPreferences: {
            session: input.targetSession,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        }),
    ),
    (window) =>
      Effect.sync(() => {
        if (!window.isDestroyed()) {
          window.destroy();
        }
      }),
  );

  yield* Effect.callback<void>((resume) => {
    let followedSignIn = false;
    const finish = (): void => resume(Effect.void);
    const hasOidc = (): Promise<boolean> =>
      input.targetSession.cookies
        .get({ url: input.targetOrigin, name: OIDC_COOKIE_NAME })
        .then((cookies) => cookies.length > 0)
        .catch(() => false);

    const onLoaded = (): void => {
      void (async () => {
        if (authWindow.isDestroyed()) return;
        const currentUrl = parseUrl(authWindow.webContents.getURL());
        if (!currentUrl) return;

        if (await hasOidc()) {
          finish();
          return;
        }

        if (!followedSignIn && currentUrl.pathname.startsWith("/tunnel-auth")) {
          if (await followSignInLink(authWindow)) {
            followedSignIn = true;
            return;
          }
        }

        if (followedSignIn && !authWindow.isDestroyed() && !authWindow.isVisible()) {
          authWindow.show();
        }
      })();
    };

    const onNavigate = (_event: unknown, url: string): void => {
      const host = parseUrl(url)?.host ?? "";
      if (/midway|federate|sso|signin/iu.test(host) && !authWindow.isDestroyed()) {
        authWindow.show();
      }
    };

    authWindow.webContents.on("did-finish-load", onLoaded);
    authWindow.webContents.on("did-navigate", onNavigate);
    authWindow.webContents.on("did-redirect-navigation", onNavigate);
    authWindow.on("closed", finish);

    void authWindow.loadURL(input.preAuthUrl).catch(() => undefined);

    return Effect.sync(() => {
      if (authWindow.isDestroyed()) return;
      authWindow.webContents.removeListener("did-finish-load", onLoaded);
      authWindow.webContents.removeListener("did-navigate", onNavigate);
      authWindow.webContents.removeListener("did-redirect-navigation", onNavigate);
      authWindow.removeListener("closed", finish);
    });
  });
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const midwayCookieSync = yield* AmznMidwayCookieSync.AmznMidwayCookieSync;
  const mutex = yield* Semaphore.make(1);

  const authenticate = (rawUrl: string) => {
    const targetOrigin = resolveAmazonTunnelOrigin(rawUrl);
    const preAuthUrl = resolveAmazonTunnelAuthUrl(rawUrl);
    if (!environment.amazonEnabled || targetOrigin === null || preAuthUrl === null) {
      return Effect.succeed(false);
    }

    return mutex
      .withPermits(1)(
        Effect.gen(function* () {
          const targetSession = session.defaultSession;
          const existing = yield* getCookie(targetSession, targetOrigin, OIDC_COOKIE_NAME);
          if (existing) {
            yield* relaxOidcCookie(targetSession, targetOrigin, existing);
            return true;
          }

          yield* midwayCookieSync.syncSession(targetSession);
          yield* Effect.scoped(
            runAuthWindow({
              preAuthUrl,
              targetOrigin,
              targetSession,
            }),
          ).pipe(Effect.timeout(AUTH_TIMEOUT), Effect.ignore);

          const oidc = yield* getCookie(targetSession, targetOrigin, OIDC_COOKIE_NAME);
          if (!oidc) return false;
          yield* relaxOidcCookie(targetSession, targetOrigin, oidc);
          return true;
        }),
      )
      .pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Amazon Tunnel authentication failed", {
            component: "desktop-amazon-tunnel-auth",
            origin: targetOrigin,
          }).pipe(Effect.as(false)),
        ),
      );
  };

  return DesktopAmazonTunnelAuth.of({ authenticate });
});

export const layer = Layer.effect(DesktopAmazonTunnelAuth, make);
