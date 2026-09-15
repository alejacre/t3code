import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { amazonTunnelFetch } from "./amazonTunnelFetch.ts";

const tunnelOrigin = "https://jorgebta-t3-code.w.tunnels.lab.aws.dev";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("amazonTunnelFetch", () => {
  it("leaves ordinary requests unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const init = { headers: { accept: "application/json" } };

    await amazonTunnelFetch("https://example.test/api", init);

    expect(fetchMock).toHaveBeenCalledWith("https://example.test/api", init);
  });

  it("authenticates Electron and proxies the request through the desktop session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    const authenticateAmazonTunnel = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { href: "t3code://app/" },
      desktopBridge: { authenticateAmazonTunnel },
    });

    await amazonTunnelFetch(`${tunnelOrigin}/api/auth/session`, {
      headers: { authorization: "Bearer t3-token" },
      credentials: "omit",
    });

    expect(authenticateAmazonTunnel).toHaveBeenCalledWith(`${tunnelOrigin}/api/auth/session`);
    const [proxyUrl, proxyInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(proxyUrl)).toBe("t3code://app/_t3code/amazon-tunnel");
    expect(proxyInit).toMatchObject({
      method: "GET",
      credentials: "same-origin",
    });
    const headers = new Headers(proxyInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer t3-token");
    expect(headers.get("x-t3code-amazon-tunnel-target")).toBe(`${tunnelOrigin}/api/auth/session`);
  });

  it("includes tunnel cookies in a browser after manual tunnel authentication", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { href: `${tunnelOrigin}/` },
    });

    await amazonTunnelFetch(`${tunnelOrigin}/.well-known/t3/environment`);

    expect(fetchMock).toHaveBeenCalledWith(`${tunnelOrigin}/.well-known/t3/environment`, {
      credentials: "include",
    });
  });

  it("reauthenticates once when environment discovery rejects a cached tunnel cookie", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response('{"environmentId":"remote"}'));
    const authenticateAmazonTunnel = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { href: "t3code://app/" },
      desktopBridge: { authenticateAmazonTunnel },
    });

    const response = await amazonTunnelFetch(`${tunnelOrigin}/.well-known/t3/environment`);

    expect(await response.text()).toBe('{"environmentId":"remote"}');
    expect(authenticateAmazonTunnel).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reauthenticate for an application-level 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const authenticateAmazonTunnel = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { href: "t3code://app/" },
      desktopBridge: { authenticateAmazonTunnel },
    });

    const response = await amazonTunnelFetch(`${tunnelOrigin}/oauth/token`, {
      method: "POST",
      body: "subject_token=expired-token",
    });

    expect(response.status).toBe(401);
    expect(authenticateAmazonTunnel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send the request when interactive authentication fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { href: "t3code://app/" },
      desktopBridge: { authenticateAmazonTunnel: vi.fn().mockResolvedValue(false) },
    });

    await expect(amazonTunnelFetch(`${tunnelOrigin}/api/auth/session`)).rejects.toThrow(
      "Amazon Tunnel authentication did not complete",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
