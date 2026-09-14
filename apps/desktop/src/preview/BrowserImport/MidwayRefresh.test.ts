import { describe, expect, it } from "@effect/vitest";

import type { ImportedCookie } from "./CookieDatabase.ts";
import { isMidwayCookieHost, selectMidwayCookies } from "./MidwayRefresh.ts";

const NOW = 1_800_000_000;

const cookie = (
  url: string,
  name: string,
  expirationDate: number | undefined = NOW + 3600,
): ImportedCookie => ({
  url,
  name,
  value: "v",
  domain: undefined,
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate,
  sameSite: "unspecified",
});

describe("isMidwayCookieHost", () => {
  it("accepts the auth origin, its subdomains and the auth.midway aliases", () => {
    for (const host of [
      "midway-auth.amazon.com",
      ".midway-auth.amazon.com",
      "eu.midway-auth.amazon.com",
      "auth.midway.aws.dev",
      ".auth.midway.amazon.dev",
      "auth.midway.aws.a2z.com",
    ]) {
      expect(isMidwayCookieHost(host), host).toBe(true);
    }
  });

  it("rejects per-site SSO token hosts and lookalikes", () => {
    for (const host of [
      "code.amazon.com",
      "prod.coe-mcp.reflect.aws.dev",
      "notmidway-auth.amazon.com",
      "midway-auth.amazon.com.evil.test",
    ]) {
      expect(isMidwayCookieHost(host), host).toBe(false);
    }
  });
});

describe("selectMidwayCookies", () => {
  it("keeps only unexpired Midway cookies", () => {
    const selected = selectMidwayCookies(
      [
        cookie("https://midway-auth.amazon.com/", "session"),
        cookie("https://midway-auth.amazon.com/", "stale", NOW - 1),
        cookie("https://auth.midway.aws.dev/", "amazon_enterprise_access"),
        cookie("https://midway-auth.amazon.com/", "user_name", undefined),
        cookie("https://code.amazon.com/", "amzn_sso_token"),
      ],
      NOW,
    );
    expect(selected.map((entry) => entry.name)).toEqual([
      "session",
      "amazon_enterprise_access",
      "user_name",
    ]);
  });
});
