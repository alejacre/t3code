import assert from "node:assert/strict";
import test from "node:test";

import {
  hardenClientHtml,
  inlineScriptHashes,
  INTERNAL_ONLY_CONTENT_SECURITY_POLICY,
} from "./harden-client.mjs";

test("injects an internal-only browser network policy exactly once", () => {
  const hardened = hardenClientHtml("<!doctype html><html><head></head><body></body></html>");
  assert.match(hardened, /http-equiv="Content-Security-Policy"/u);
  assert.ok(hardened.includes(INTERNAL_ONLY_CONTENT_SECURITY_POLICY));
  assert.match(
    INTERNAL_ONLY_CONTENT_SECURITY_POLICY,
    /connect-src 'self' https:\/\/\*\.tunnels\.lab\.aws\.dev wss:\/\/\*\.tunnels\.lab\.aws\.dev/u,
  );
  assert.match(INTERNAL_ONLY_CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/u);
  assert.doesNotMatch(
    INTERNAL_ONLY_CONTENT_SECURITY_POLICY,
    /(?:^|[.;\s])(?:https?:\/\/|wss?:\/\/)?(?:[^;\s]*\.)?t3\.codes|localhost|127\.0\.0\.1/u,
  );
  assert.equal(hardenClientHtml(hardened), hardened);
});

test("hashes inline bootstrap scripts instead of allowing arbitrary inline JavaScript", () => {
  const source =
    "<!doctype html><html><head><script>window.__theme = 'dark';</script></head><body></body></html>";
  const hashes = inlineScriptHashes(source);
  const hardened = hardenClientHtml(source);

  assert.equal(hashes.length, 1);
  assert.ok(hardened.includes(hashes[0]));
  assert.doesNotMatch(hardened, /script-src[^;"]*'unsafe-inline'/u);
});

test("fails closed when the built client has no head element", () => {
  assert.throws(() => hardenClientHtml("<html></html>"), /head element/u);
});
