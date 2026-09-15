import { describe, expect, it } from "vite-plus/test";

import { parseMidwayCookieJar } from "./AmznMidwayCookies.ts";

describe("parseMidwayCookieJar", () => {
  it("parses secure and HttpOnly Netscape cookie records", () => {
    const raw = [
      ".auth.midway.aws.dev\tTRUE\t/\tTRUE\t1783551171\tamazon_enterprise_access\tsecret",
      "#HttpOnly_midway-auth.amazon.com\tFALSE\t/\tTRUE\t0\tsession\tabc",
    ].join("\n");

    expect(parseMidwayCookieJar(raw)).toEqual([
      {
        url: "https://auth.midway.aws.dev/",
        name: "amazon_enterprise_access",
        value: "secret",
        domain: ".auth.midway.aws.dev",
        path: "/",
        secure: true,
        httpOnly: false,
        expirationDate: 1783551171,
      },
      {
        url: "https://midway-auth.amazon.com/",
        name: "session",
        value: "abc",
        domain: "midway-auth.amazon.com",
        path: "/",
        secure: true,
        httpOnly: true,
      },
    ]);
  });

  it("omits forbidden Domain attributes from __Host- cookies", () => {
    const [cookie] = parseMidwayCookieJar(
      "midway-auth.amazon.com\tFALSE\t/\tTRUE\t0\t__Host-session\tvalue",
    );
    expect(cookie).toBeDefined();
    expect(cookie).not.toHaveProperty("domain");
  });

  it("skips comments, blanks, and malformed rows", () => {
    expect(parseMidwayCookieJar("# comment\n\ninvalid\trow")).toEqual([]);
  });
});
