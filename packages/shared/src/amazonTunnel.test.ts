import { describe, expect, it } from "vite-plus/test";

import {
  isAmazonTunnelUrl,
  resolveAmazonTunnelAuthUrl,
  resolveAmazonTunnelOrigin,
} from "./amazonTunnel.ts";

describe("amazonTunnel", () => {
  it.each([
    "https://jorgebta-t3-code.tunnels.lab.aws.dev",
    "https://jorgebta-t3-code.w.tunnels.lab.aws.dev/",
    "https://jorgebta-t3-code.v.tunnels.lab.aws.dev/",
    "https://jorgebta-t3-code.7.tunnels.lab.aws.dev",
    "https://jorgebta-t3-code-b5381a3ac5.v.tunnels.lab.aws.dev",
    "https://a.tunnels.lab.aws.dev/path?query=1",
  ])("accepts an Amazon Tunnel HTTPS URL: %s", (url) => {
    expect(isAmazonTunnelUrl(url)).toBe(true);
  });

  it.each([
    "http://jorgebta-t3-code.tunnels.lab.aws.dev",
    "https://tunnels.lab.aws.dev",
    "https://nested.jorgebta-t3-code.tunnels.lab.aws.dev",
    "https://jorgebta-t3-code.other.tunnels.lab.aws.dev",
    "https://jorgebta-t3-code.tunnels.lab.aws.dev.evil.test",
    "https://user@jorgebta-t3-code.tunnels.lab.aws.dev",
    "https://jorgebta-t3-code.tunnels.lab.aws.dev:8443",
    "not a url",
  ])("rejects a non-tunnel URL: %s", (url) => {
    expect(isAmazonTunnelUrl(url)).toBe(false);
    expect(resolveAmazonTunnelOrigin(url)).toBeNull();
    expect(resolveAmazonTunnelAuthUrl(url)).toBeNull();
  });

  it("builds the per-tunnel auth gate URL without preserving request paths", () => {
    const origin = "https://jorgebta-t3-code.w.tunnels.lab.aws.dev";
    expect(resolveAmazonTunnelOrigin(`${origin}/project?token=ignored`)).toBe(origin);
    expect(resolveAmazonTunnelAuthUrl(`${origin}/project?token=ignored`)).toBe(
      `${origin}/tunnel-auth?redirect=${encodeURIComponent(`${origin}/`)}`,
    );
  });
});
