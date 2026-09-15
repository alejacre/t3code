import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  makeWithDependencies,
  MidwayCoralAuthenticationError,
  parseMidwayCookieFile,
  type RawHttpResponse,
  type RawRequest,
} from "./MidwayCoralClient.ts";

const COOKIE_FILE = [
  "#HttpOnly_.midway-auth.amazon.com TRUE / TRUE 0 session session-token",
  ".midway-auth.amazon.com TRUE / TRUE 0 amazon_enterprise_access posture-token",
].join("\n");

describe("MidwayCoralClient", () => {
  for (const status of [401, 403]) {
    it.effect(`returns actionable access guidance for a POST ${status} without retrying`, () => {
      const request: RawRequest = vi.fn(async (input) =>
        input.method === "GET"
          ? { status: 200, headers: {}, body: "ready" }
          : { status, headers: {}, body: "denied" },
      );
      const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE });
      return Effect.gen(function* () {
        const result = yield* client
          .call({
            endpoint: "https://critic-service-sso.corp.amazon.com",
            target: "com.amazon.critic.CriticService.GetApprovalStatus",
            body: {},
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(MidwayCoralAuthenticationError);
          expect(result.failure.detail).toContain("mwinit");
          if (status === 403) expect(result.failure.detail).toContain("service permissions");
        }
        expect(request).toHaveBeenCalledTimes(2);
      });
    });
  }

  it("parses HttpOnly and domain-scoped Midway cookies", () => {
    expect(parseMidwayCookieFile(COOKIE_FILE)).toEqual([
      expect.objectContaining({
        name: "session",
        domain: "midway-auth.amazon.com",
        secure: true,
        hostOnly: false,
      }),
      expect.objectContaining({
        name: "amazon_enterprise_access",
        domain: "midway-auth.amazon.com",
        secure: true,
        hostOnly: false,
      }),
    ]);
  });

  it.effect("warms a cold service through Midway and reuses the service cookie for POST", () => {
    const requests: Parameters<RawRequest>[0][] = [];
    const readCookieFile = vi.fn(() => COOKIE_FILE);
    const request: RawRequest = vi.fn(async (input) => {
      requests.push(input);
      switch (requests.length) {
        case 1:
          return {
            status: 307,
            headers: {
              location:
                "https://midway-auth.amazon.com/SSO/redirect?redirect_uri=https%3A%2F%2Fcritic-service-sso.corp.amazon.com%2F",
            },
            body: "",
          };
        case 2:
          return {
            status: 302,
            headers: { location: "https://critic-service-sso.corp.amazon.com/callback" },
            body: "",
          };
        case 3:
          return {
            status: 200,
            headers: {
              "set-cookie": ["critic_session=service-token; Path=/; Secure; HttpOnly"],
            },
            body: "ready",
          };
        default:
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"reviews":[]}',
          };
      }
    });
    const client = makeWithDependencies({ request, readCookieFile });

    return Effect.gen(function* () {
      const response = yield* client.call({
        endpoint: "https://critic-service-sso.corp.amazon.com",
        target: "com.amazon.critic.CriticService.GetRevisionsByReview",
        body: { cr: "CR-1" },
      });

      expect(response).toEqual({ reviews: [] });
      expect(requests[0]).toMatchObject({ method: "GET" });
      expect(requests[0]?.headers.Cookie).toBeUndefined();
      expect(requests[1]?.headers.Cookie).toContain("session=session-token");
      expect(requests[3]).toMatchObject({
        method: "POST",
        body: '{"cr":"CR-1"}',
      });
      expect(requests[3]?.headers.Cookie).toContain("critic_session=service-token");
      expect(requests[3]?.headers["X-Amz-Target"]).toBe(
        "com.amazon.critic.CriticService.GetRevisionsByReview",
      );
      expect(readCookieFile).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("does not let an expired file cookie replace a fresh service cookie", () => {
    const cookieFile = [
      COOKIE_FILE,
      "critic-service-sso.corp.amazon.com FALSE / TRUE 1 critic_session expired-token",
    ].join("\n");
    const requests: Parameters<RawRequest>[0][] = [];
    const request: RawRequest = vi.fn(async (input) => {
      requests.push(input);
      if (input.method === "GET") {
        return {
          status: 200,
          headers: { "set-cookie": ["critic_session=fresh-token; Path=/; Secure"] },
          body: "ready",
        };
      }
      return input.headers.Cookie?.includes("critic_session=fresh-token") === true
        ? { status: 200, headers: { "content-type": "application/json" }, body: "{}" }
        : { status: 401, headers: {}, body: "" };
    });
    const client = makeWithDependencies({ request, readCookieFile: () => cookieFile });

    return Effect.gen(function* () {
      yield* client.call({
        endpoint: "https://critic-service-sso.corp.amazon.com",
        target: "com.amazon.critic.CriticService.GetRevision",
        body: {},
      });
      yield* client.call({
        endpoint: "https://critic-service-sso.corp.amazon.com",
        target: "com.amazon.critic.CriticService.GetRevision",
        body: {},
      });
      expect(requests.filter((input) => input.method === "GET")).toHaveLength(1);
      expect(requests.filter((input) => input.method === "POST")).toHaveLength(2);
    });
  });

  it.effect("does not accept a Set-Cookie domain unrelated to the response host", () => {
    const requests: Parameters<RawRequest>[0][] = [];
    const request: RawRequest = vi.fn(async (input) => {
      requests.push(input);
      if (input.method === "GET" && input.url.includes("critic-service")) {
        return {
          status: 200,
          headers: {
            "set-cookie": ["foreign=secret; Domain=gitfarm-sso.corp.amazon.com; Path=/; Secure"],
          },
          body: "ready",
        };
      }
      return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    });
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE });

    return Effect.gen(function* () {
      yield* client.call({
        endpoint: "https://critic-service-sso.corp.amazon.com",
        target: "critic.read",
        body: {},
      });
      yield* client.call({
        endpoint: "https://gitfarm-sso.corp.amazon.com",
        target: "gitfarm.read",
        body: {},
      });
      const gitFarmWarm = requests.find(
        (input) => input.method === "GET" && input.url.includes("gitfarm-sso"),
      );
      expect(gitFarmWarm).toBeDefined();
      expect(gitFarmWarm?.headers.Cookie ?? "").not.toContain("foreign=secret");
    });
  });

  it.effect("coalesces concurrent warm-up calls for one service origin", () => {
    const request: RawRequest = vi.fn(async (input) => {
      if (input.method === "GET") {
        await Promise.resolve();
        return { status: 200, headers: {}, body: "ready" };
      }
      return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    });
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE });

    return Effect.gen(function* () {
      yield* Effect.all(
        [
          client.call({
            endpoint: "https://gitfarm-sso.corp.amazon.com",
            target: "x.first",
            body: {},
          }),
          client.call({
            endpoint: "https://gitfarm-sso.corp.amazon.com",
            target: "x.second",
            body: {},
          }),
        ],
        { concurrency: "unbounded" },
      );
      const calls = vi.mocked(request).mock.calls.map(([input]) => input);
      expect(calls.filter((input) => input.method === "GET")).toHaveLength(1);
      expect(calls.filter((input) => input.method === "POST")).toHaveLength(2);
    });
  });

  it.effect("keeps a shared warm-up alive when one caller is interrupted", () => {
    let resolveWarmStarted!: (signal: AbortSignal) => void;
    let resolveWarmResponse!: (response: RawHttpResponse) => void;
    const warmStarted = new Promise<AbortSignal>((resolve) => {
      resolveWarmStarted = resolve;
    });
    let getCount = 0;
    let postCount = 0;
    const request: RawRequest = vi.fn(async (input, signal) => {
      if (input.method === "POST") {
        postCount += 1;
        return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
      }
      if (signal === undefined) throw new Error("Expected the shared warm-up AbortSignal");
      getCount += 1;
      resolveWarmStarted(signal);
      return new Promise<RawHttpResponse>((resolve, reject) => {
        resolveWarmResponse = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE });

    return Effect.gen(function* () {
      const first = yield* client
        .call({
          endpoint: "https://gitfarm-sso.corp.amazon.com",
          target: "x.first",
          body: {},
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const sharedSignal = yield* Effect.promise(() => warmStarted);
      const second = yield* client
        .call({
          endpoint: "https://gitfarm-sso.corp.amazon.com",
          target: "x.second",
          body: {},
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Fiber.interrupt(first);
      expect(sharedSignal.aborted).toBe(false);

      resolveWarmResponse({ status: 200, headers: {}, body: "ready" });
      yield* Fiber.join(second);
      expect(getCount).toBe(1);
      expect(postCount).toBe(1);
    });
  });

  it.effect("retries HTML service-error pages with a one-second first backoff", () => {
    const sleep = vi.fn(async () => undefined);
    let postCount = 0;
    const request: RawRequest = vi.fn(async (input) => {
      if (input.method === "GET") return { status: 200, headers: {}, body: "ready" };
      postCount += 1;
      return postCount === 1
        ? { status: 503, headers: { "content-type": "text/html" }, body: "<h1>Unavailable</h1>" }
        : { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    });
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE, sleep });

    return Effect.gen(function* () {
      yield* client.call({
        endpoint: "https://gitfarm-sso.corp.amazon.com",
        target: "com.amazon.brazil.gitfarm.service.GitFarmService.rawDiff",
        body: {},
      });
      expect(postCount).toBe(2);
      expect(sleep).toHaveBeenCalledWith(1_000, expect.anything());
    });
  });

  it.effect("backs off for Coral HTTP 400 throttling on read operations", () => {
    const sleep = vi.fn(async () => undefined);
    let postCount = 0;
    const request: RawRequest = async (input) => {
      if (input.method === "GET") return { status: 200, headers: {}, body: "ready" };
      postCount += 1;
      return postCount === 1
        ? {
            status: 400,
            headers: { "content-type": "application/json" },
            body: '{"__type":"com.amazon.coral.availability#ThrottlingException","message":"Rate exceeded"}',
          }
        : { status: 200, headers: { "content-type": "application/json" }, body: '{"reviews":[]}' };
    };
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE, sleep });
    return Effect.gen(function* () {
      const value = yield* client.call({
        endpoint: "https://critic-service-sso.corp.amazon.com",
        target: "com.amazon.critic.CriticService.GetRevisionsByReview",
        body: { cr: "CR-123" },
      });
      expect(value).toEqual({ reviews: [] });
      expect(postCount).toBe(2);
      expect(sleep).toHaveBeenCalledWith(1_000, expect.anything());
    });
  });

  it.effect("does not replay mutations for Coral HTTP 400 throttling", () => {
    const sleep = vi.fn(async () => undefined);
    let postCount = 0;
    const client = makeWithDependencies({
      readCookieFile: () => COOKIE_FILE,
      sleep,
      request: async (input) => {
        if (input.method === "GET") return { status: 200, headers: {}, body: "ready" };
        postCount += 1;
        return {
          status: 400,
          headers: {},
          body: '{"__type":"com.amazon.coral.availability#ThrottlingException"}',
        };
      },
    });
    return Effect.gen(function* () {
      const result = yield* client
        .call({
          endpoint: "https://critic-service-sso.corp.amazon.com",
          target: "com.amazon.critic.CriticService.CreateComment",
          body: {},
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(postCount).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  it.effect("aborts an in-flight request when the calling fiber is interrupted", () => {
    let resolveRequestStarted: ((signal: AbortSignal) => void) | undefined;
    const requestStarted = new Promise<AbortSignal>((resolve) => {
      resolveRequestStarted = resolve;
    });
    const request: RawRequest = vi.fn(async (input, signal) => {
      if (input.method === "GET") return { status: 200, headers: {}, body: "ready" };
      if (signal === undefined) throw new Error("Expected the Effect AbortSignal");
      resolveRequestStarted?.(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE });

    return Effect.gen(function* () {
      const call = yield* client
        .call({
          endpoint: "https://critic-service-sso.corp.amazon.com",
          target: "com.amazon.critic.CriticService.GetRevision",
          body: {},
        })
        .pipe(Effect.forkScoped);
      const signal = yield* Effect.promise(() => requestStarted);

      expect(signal.aborted).toBe(false);
      yield* Fiber.interrupt(call);
      expect(signal.aborted).toBe(true);
    });
  });

  it.effect("aborts a pending retry backoff when the calling fiber is interrupted", () => {
    let resolveBackoffStarted: ((signal: AbortSignal) => void) | undefined;
    const backoffStarted = new Promise<AbortSignal>((resolve) => {
      resolveBackoffStarted = resolve;
    });
    const request: RawRequest = vi.fn(async (input) =>
      input.method === "GET"
        ? { status: 200, headers: {}, body: "ready" }
        : { status: 503, headers: {}, body: "" },
    );
    const sleep = vi.fn(async (_milliseconds: number, signal?: AbortSignal): Promise<void> => {
      if (signal === undefined) throw new Error("Expected the Effect AbortSignal");
      resolveBackoffStarted?.(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE, sleep });

    return Effect.gen(function* () {
      const call = yield* client
        .call({
          endpoint: "https://gitfarm-sso.corp.amazon.com",
          target: "com.amazon.brazil.gitfarm.service.GitFarmService.rawDiff",
          body: {},
        })
        .pipe(Effect.forkScoped);
      const signal = yield* Effect.promise(() => backoffStarted);

      expect(signal.aborted).toBe(false);
      yield* Fiber.interrupt(call);
      expect(signal.aborted).toBe(true);
      expect(sleep).toHaveBeenCalledWith(1_000, signal);
    });
  });

  it.effect("does not retry a mutation after a retryable HTTP status", () => {
    const sleep = vi.fn(async () => undefined);
    let postCount = 0;
    const request: RawRequest = vi.fn(async (input) => {
      if (input.method === "GET") return { status: 200, headers: {}, body: "ready" };
      postCount += 1;
      return { status: 503, headers: {}, body: "" };
    });
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE, sleep });

    return Effect.gen(function* () {
      const error = yield* client
        .call({
          endpoint: "https://critic-service-sso.corp.amazon.com",
          target: "com.amazon.critic.CriticService.CreateComment",
          body: {},
        })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => null,
          }),
        );
      expect(error).toMatchObject({ _tag: "MidwayCoralRequestError", status: 503 });
      expect(postCount).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  it.effect("classifies a successful HTML response as stale Midway", () => {
    const request: RawRequest = vi.fn(async (input) =>
      input.method === "GET"
        ? { status: 200, headers: {}, body: "ready" }
        : { status: 200, headers: { "content-type": "text/html" }, body: "<html />" },
    );
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE });

    return Effect.gen(function* () {
      const error = yield* client
        .call({ endpoint: "https://critic-service-sso.corp.amazon.com", target: "x", body: {} })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => null,
          }),
        );
      expect(error?._tag).toBe("MidwayCoralAuthenticationError");
    });
  });

  it.effect("warms the service again after an authenticated POST returns HTML", () => {
    let getCount = 0;
    let postCount = 0;
    const request: RawRequest = vi.fn(async (input) => {
      if (input.method === "GET") {
        getCount += 1;
        return { status: 200, headers: {}, body: "ready" };
      }
      postCount += 1;
      return postCount === 1
        ? { status: 200, headers: { "content-type": "text/html" }, body: "<html />" }
        : { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    });
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE });

    return Effect.gen(function* () {
      yield* client
        .call({ endpoint: "https://critic-service-sso.corp.amazon.com", target: "x", body: {} })
        .pipe(Effect.ignore);
      yield* client.call({
        endpoint: "https://critic-service-sso.corp.amazon.com",
        target: "x",
        body: {},
      });
      expect(getCount).toBe(2);
      expect(postCount).toBe(2);
    });
  });

  it.effect("rejects a redirect outside the internal HTTPS allowlist", () => {
    const request: RawRequest = vi.fn(async () => ({
      status: 307,
      headers: { location: "http://example.com/login" },
      body: "",
    }));
    const client = makeWithDependencies({ request, readCookieFile: () => COOKIE_FILE });

    return Effect.gen(function* () {
      const error = yield* client
        .call({ endpoint: "https://critic-service-sso.corp.amazon.com", target: "x", body: {} })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => null,
          }),
        );
      expect(error).toMatchObject({ _tag: "MidwayCoralRequestError", operation: "MidwayRedirect" });
    });
  });

  it.effect("fails before the network when no usable Midway cookies exist", () => {
    const request: RawRequest = vi.fn(async () => ({ status: 200, headers: {}, body: "{}" }));
    const client = makeWithDependencies({ request, readCookieFile: () => "" });

    return Effect.gen(function* () {
      const error = yield* client
        .call({ endpoint: "https://critic-service-sso.corp.amazon.com", target: "x", body: {} })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => null,
          }),
        );
      expect(error?._tag).toBe("MidwayCoralAuthenticationError");
      expect(request).not.toHaveBeenCalled();
    });
  });
});
