import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import { decryptChromeCookie, toElectronCookie } from "./ChromeCookieImporter.ts";

const encryptCookie = (plaintext: Buffer, key: Buffer): Uint8Array => {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
};

describe("ChromeCookieImporter", () => {
  it("decrypts Chrome v24 cookies after validating the host hash", () => {
    const host = ".amazon.com";
    const key = Buffer.from("0123456789abcdef");
    const value = "midway-cookie";
    const plaintext = Buffer.concat([
      NodeCrypto.createHash("sha256").update(host).digest(),
      Buffer.from(value),
    ]);
    const encryptedValue = encryptCookie(plaintext, key);

    assert.equal(
      decryptChromeCookie({ host_key: host, value: "", encrypted_value: encryptedValue }, key, 24),
      value,
    );
    assert.isNull(
      decryptChromeCookie(
        { host_key: ".amazon.dev", value: "", encrypted_value: encryptedValue },
        key,
        24,
      ),
    );
  });

  it("uses an unencrypted cookie value without consulting the encrypted payload", () => {
    assert.equal(
      decryptChromeCookie(
        { host_key: ".amazon.com", value: "plain", encrypted_value: new Uint8Array() },
        Buffer.alloc(16),
        24,
      ),
      "plain",
    );
  });

  it("preserves the distinction between host-only and domain cookies", () => {
    const row = {
      name: "session",
      value: "",
      encrypted_value: new Uint8Array(),
      path: "/",
      expires_utc: 0n,
      is_secure: 1n,
      is_httponly: 1n,
      has_expires: 0n,
      samesite: 1n,
    };

    const hostOnly = toElectronCookie({ ...row, host_key: "amazon.dev" }, "host-only");
    const domain = toElectronCookie({ ...row, host_key: ".amazon.dev" }, "domain");

    if (hostOnly === null || domain === null) assert.fail("Expected supported Amazon cookies");
    assert.notProperty(hostOnly, "domain");
    assert.equal(hostOnly.url, "https://amazon.dev/");
    assert.equal(domain.domain, ".amazon.dev");
  });
});
