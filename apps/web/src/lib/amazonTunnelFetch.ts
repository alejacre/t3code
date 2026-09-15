import {
  AMAZON_TUNNEL_DESKTOP_PROXY_PATH,
  AMAZON_TUNNEL_DESKTOP_TARGET_HEADER,
  isAmazonTunnelUrl,
} from "@t3tools/shared/amazonTunnel";

const ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";

function resolveRequestUrl(input: Parameters<typeof globalThis.fetch>[0]): URL | null {
  try {
    if (input instanceof URL) {
      return input;
    }
    if (typeof input === "string") {
      return new URL(
        input,
        typeof window === "undefined" ? "http://localhost/" : window.location.href,
      );
    }
    return new URL(input.url);
  } catch {
    return null;
  }
}

async function fetchThroughDesktopProxy(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
  targetUrl: URL,
): Promise<Response> {
  const request = new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set(AMAZON_TUNNEL_DESKTOP_TARGET_HEADER, targetUrl.toString());

  const proxyInit: RequestInit = {
    method: request.method,
    headers,
    credentials: "same-origin",
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
    proxyInit.body = await request.arrayBuffer();
  }

  return globalThis.fetch(
    new URL(AMAZON_TUNNEL_DESKTOP_PROXY_PATH, window.location.href),
    proxyInit,
  );
}

export const amazonTunnelFetch: typeof globalThis.fetch = async (input, init) => {
  const url = resolveRequestUrl(input);
  if (url === null || !isAmazonTunnelUrl(url)) {
    return globalThis.fetch(input, init);
  }

  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (bridge?.authenticateAmazonTunnel) {
    const authenticate = async (): Promise<void> => {
      const authenticated = await bridge.authenticateAmazonTunnel!(url.toString());
      if (!authenticated) {
        throw new Error(`Amazon Tunnel authentication did not complete for ${url.origin}.`);
      }
    };

    await authenticate();
    const response = await fetchThroughDesktopProxy(input, init, url);
    if (response.status !== 401 || url.pathname !== ENVIRONMENT_DESCRIPTOR_PATH) {
      return response;
    }

    await authenticate();
    return fetchThroughDesktopProxy(input, init, url);
  }

  return globalThis.fetch(input, {
    ...init,
    credentials: "include",
  });
};
