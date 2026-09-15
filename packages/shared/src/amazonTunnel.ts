const AMAZON_TUNNEL_HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9])?\.tunnels\.lab\.aws\.dev$/u;

export const AMAZON_TUNNEL_DESKTOP_PROXY_PATH = "/_t3code/amazon-tunnel";
export const AMAZON_TUNNEL_DESKTOP_TARGET_HEADER = "x-t3code-amazon-tunnel-target";

function parseAmazonTunnelUrl(value: string | URL): URL | null {
  try {
    const url = value instanceof URL ? new URL(value.toString()) : new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      !AMAZON_TUNNEL_HOSTNAME_PATTERN.test(url.hostname.toLowerCase())
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function isAmazonTunnelUrl(value: string | URL): boolean {
  return parseAmazonTunnelUrl(value) !== null;
}

export function resolveAmazonTunnelOrigin(value: string | URL): string | null {
  return parseAmazonTunnelUrl(value)?.origin ?? null;
}

export function resolveAmazonTunnelAuthUrl(value: string | URL): string | null {
  const origin = resolveAmazonTunnelOrigin(value);
  return origin === null
    ? null
    : `${origin}/tunnel-auth?redirect=${encodeURIComponent(`${origin}/`)}`;
}
