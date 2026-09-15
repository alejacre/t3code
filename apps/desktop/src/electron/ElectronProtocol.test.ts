import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const { cookiesGetMock, cookiesRemoveMock, handleMock, netFetchMock, nodeFetchMock, unhandleMock } =
  vi.hoisted(() => ({
    cookiesGetMock: vi.fn(),
    cookiesRemoveMock: vi.fn(),
    handleMock: vi.fn(),
    netFetchMock: vi.fn(),
    nodeFetchMock: vi.fn(),
    unhandleMock: vi.fn(),
  }));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
  session: {
    defaultSession: { cookies: { get: cookiesGetMock, remove: cookiesRemoveMock } },
  },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol", () => {
  beforeEach(() => {
    cookiesGetMock.mockReset();
    cookiesRemoveMock.mockReset();
    handleMock.mockReset();
    netFetchMock.mockReset();
    nodeFetchMock.mockReset();
    unhandleMock.mockReset();
    vi.stubGlobal("fetch", nodeFetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3774/"),
            clerkFrontendApiHostname: "clerk.t3.codes",
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("t3code-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "t3code-dev://app",
                  referer: "t3code-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.t3.codes https://challenges.cloudflare.com",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' http: https: ws: wss:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' t3code-dev: blob: data: http: https:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' t3code-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["t3code-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["t3code-dev"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("t3code://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("proxies authenticated Amazon Tunnel requests through the default session", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      cookiesGetMock.mockResolvedValue([
        {
          name: "oidc-auth",
          value: "tunnel-cookie",
        },
      ]);
      nodeFetchMock.mockResolvedValue(
        new Response('{"ok":true}', {
          headers: {
            "content-encoding": "gzip",
            "content-length": "7",
            "content-type": "application/json",
          },
        }),
      );

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
            amazonEnabled: true,
          });
          return yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/_t3code/amazon-tunnel", {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  origin: "t3code://app",
                  "x-t3code-amazon-tunnel-target":
                    "https://jorgebta-t3-code.w.tunnels.lab.aws.dev/oauth/token",
                },
                body: "subject_token=pairing-token",
              }),
            ),
          );
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), '{"ok":true}');
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.isNull(response.headers.get("content-encoding"));
      assert.isNull(response.headers.get("content-length"));
      assert.equal(
        nodeFetchMock.mock.calls[0]?.[0],
        "https://jorgebta-t3-code.w.tunnels.lab.aws.dev/oauth/token",
      );
      const forwardedHeaders = new Headers(nodeFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("content-type"), "application/x-www-form-urlencoded");
      assert.equal(forwardedHeaders.get("cookie"), "oidc-auth=tunnel-cookie");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("x-t3code-amazon-tunnel-target"));
      assert.instanceOf(nodeFetchMock.mock.calls[0]?.[1]?.body, ArrayBuffer);
      assert.notProperty(nodeFetchMock.mock.calls[0]?.[1], "duplex");
      assert.equal(
        yield* Effect.promise(() => new Response(nodeFetchMock.mock.calls[0]?.[1]?.body).text()),
        "subject_token=pairing-token",
      );
      assert.equal(netFetchMock.mock.calls.length, 0);
      assert.equal(cookiesRemoveMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("clears a rejected tunnel cookie when environment discovery returns 401", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      cookiesGetMock.mockResolvedValue([
        {
          name: "oidc-auth",
          value: "stale-tunnel-cookie",
        },
      ]);
      nodeFetchMock.mockResolvedValue(new Response(null, { status: 401 }));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
            amazonEnabled: true,
          });
          return yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/_t3code/amazon-tunnel", {
                headers: {
                  "x-t3code-amazon-tunnel-target":
                    "https://jorgebta-t3-code.w.tunnels.lab.aws.dev/.well-known/t3/environment",
                },
              }),
            ),
          );
        }),
      );

      assert.equal(response.status, 401);
      assert.deepEqual(cookiesRemoveMock.mock.calls, [
        ["https://jorgebta-t3-code.w.tunnels.lab.aws.dev", "oidc-auth"],
      ]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("keeps the tunnel cookie when an application endpoint returns 401", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      cookiesGetMock.mockResolvedValue([
        {
          name: "oidc-auth",
          value: "valid-tunnel-cookie",
        },
      ]);
      nodeFetchMock.mockResolvedValue(new Response(null, { status: 401 }));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
            amazonEnabled: true,
          });
          return yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/_t3code/amazon-tunnel", {
                method: "POST",
                headers: {
                  "x-t3code-amazon-tunnel-target":
                    "https://jorgebta-t3-code.w.tunnels.lab.aws.dev/oauth/token",
                },
                body: "subject_token=expired-token",
              }),
            ),
          );
        }),
      );

      assert.equal(response.status, 401);
      assert.equal(cookiesRemoveMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("does not proxy an Amazon Tunnel request without its authenticated cookie", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      cookiesGetMock.mockResolvedValue([]);

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
            amazonEnabled: true,
          });
          return yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/_t3code/amazon-tunnel", {
                headers: {
                  "x-t3code-amazon-tunnel-target":
                    "https://jorgebta-t3-code.w.tunnels.lab.aws.dev/.well-known/t3/environment",
                },
              }),
            ),
          );
        }),
      );

      assert.equal(response.status, 401);
      assert.equal(nodeFetchMock.mock.calls.length, 0);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("rejects invalid Amazon Tunnel proxy targets", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
            amazonEnabled: true,
          });
          return yield* Effect.promise(() =>
            handler!(
              new Request("t3code://app/_t3code/amazon-tunnel", {
                headers: {
                  "x-t3code-amazon-tunnel-target": "https://example.test/private",
                },
              }),
            ),
          );
        }),
      );

      assert.equal(response.status, 400);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "t3code-dev",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("t3code-dev://app/")));
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "t3code-dev",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          backendOrigin: new URL("http://127.0.0.1:3774/"),
          clerkFrontendApiHostname: undefined,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "t3code-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "t3code-dev".');
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(
          protocol.registerDesktopProtocol({
            scheme: "t3code",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          }),
        ),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
        assert.equal(error.scheme, "t3code");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, 'Failed to unregister Electron protocol scheme "t3code".');
      }
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("keeps executable sources host-restricted while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "t3code",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      backendOrigin: new URL("http://127.0.0.1:3773/"),
      clerkFrontendApiHostname: "clerk.t3.codes",
    });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );

    assert.deepEqual(directives["script-src"], [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      "https://clerk.t3.codes",
      "https://challenges.cloudflare.com",
    ]);
    assert.deepEqual(directives["connect-src"], ["'self'", "http:", "https:", "ws:", "wss:"]);
    assert.deepEqual(directives["img-src"], [
      "'self'",
      "t3code:",
      "blob:",
      "data:",
      "http:",
      "https:",
    ]);
    assert.deepEqual(directives["media-src"], ["'self'", "t3code:", "blob:", "http:", "https:"]);
    assert.deepEqual(directives["frame-src"], ["'self'", "blob:", "http:", "https:"]);
    assert.deepEqual(directives["font-src"], ["'self'", "t3code:", "data:"]);
  });
});
