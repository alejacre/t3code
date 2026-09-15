# Amazon features in T3 Custom

T3 Custom keeps the upstream T3 Code experience and adds two Amazon capabilities, ported from
[`T3CodeAmazonInternal`](https://code.amazon.com/packages/T3CodeAmazonInternal):

| Feature | What it does | Where it lives |
| --- | --- | --- |
| Midway / AEA browser auth | The embedded preview browser imports the `mwinit` cookie jar, receives the Amazon Enterprise Access posture cookie and headers from the AEA native host, and refreshes them every 60 s. Chromium negotiate-auth allowlists follow the managed Chrome policy. | `apps/desktop/src/amazon/DesktopAmazonEnterpriseAccess.ts`, `apps/desktop/src/amazon/electron/AmznMidwayCookieSync.ts`, `apps/desktop/src/app/DesktopPreReadyPlatform.ts` |
| Cloud Desktop over Amazon Tunnel | The Mac app pairs with a T3 server running on a Cloud Desktop behind an owner-only Amazon Tunnel. Tunnel sign-in opens a Midway window once; the renderer then talks to the tunnel through the `t3code://app/_t3code/amazon-tunnel` proxy that carries the tunnel OIDC cookie. | `apps/desktop/src/amazon/DesktopAmazonTunnelAuth.ts`, `apps/desktop/src/electron/ElectronProtocol.ts`, `apps/web/src/lib/amazonTunnelFetch.ts`, `packages/shared/src/amazonTunnel.ts` |

Unlike the internal fork, nothing is disabled: Clerk, LAN exposure, Tailscale, telemetry settings, and
the regular `~/.t3` state directory behave exactly as upstream. CRUX source control and the
"expose my Mac through a tunnel" mode were not ported.

## Enabling

Amazon features are a runtime flag, not a build flavor (`apps/desktop/src/amazon/AmazonFeatures.ts`):

| Condition | Result |
| --- | --- |
| `T3CODE_AMAZON=1` in the app's environment | Enabled |
| `T3CODE_AMAZON=0` | Disabled |
| Neither, and `~/.midway` exists | Enabled (an `mwinit` has run on this Mac) |
| Neither, and no `~/.midway` | Disabled |

The same binary therefore works on and off the Amazon network.

## Midway / AEA

1. Run `mwinit` as usual.
2. Open a preview in T3 Custom. Midway-protected pages (Harmony, a2z.com, internal wikis) load
   without a sign-in prompt. Posture cookies refresh in the background; the existing
   **Refresh Midway** toolbar button still forces a reimport.

`MIDWAY_COOKIE_PATH` overrides the default `~/.midway/cookie` jar.

## Cloud Desktop environment

### Prerequisites on the Cloud Desktop

- x86_64 Amazon Cloud Desktop with Git, tar, and a local Docker Engine.
- Amazon Tunnels: `toolbox install tunnels`, then `tunnel list --json` must print JSON.
- At least one harness on `PATH`: `kiro-cli`, `claude`, or `codex`. Codex is optional; when it is
  present the script wires its managed Bedrock profile (`T3CODE_AMAZON_CODEX_AWS_PROFILE`,
  default `codex-DO-NOT-DELETE`). MyCli/CRUX is optional and only reported.

### Start the server and tunnel

```bash
git clone <your T3 Custom remote> t3code && cd t3code
node scripts/t3code-amazon.mjs doctor   # read-only prerequisite report
node scripts/t3code-amazon.mjs up       # reproducible Docker build, start server + tunnel
node scripts/t3code-amazon.mjs status   # server: ready / tunnel: ready / url
```

The runtime lives under `~/.local/state/t3code-amazon` and never touches `~/.t3`. The server is bound
to `127.0.0.1:3773`; only the tunnel exposes it, and only to its owner.

### Pair the Mac app

```bash
node scripts/t3code-amazon.mjs pair     # single-use URL, 5 minutes
```

In T3 Custom: **Settings > Connections > Remote environments > Add environment > Remote link**, paste
the URL. A Midway window appears the first time the tunnel needs authentication; afterwards the
OIDC cookie is reused.

### Pair a browser

`node scripts/t3code-amazon.mjs url` prints the stable tunnel address. Open it in an AEA-enabled
browser, then open a fresh `pair` URL in the same browser. The browser session lasts 30 days.

### Other commands

| Command | Purpose |
| --- | --- |
| `logs` | Last 100 server and tunnel log lines |
| `restart` | Restart without rebuilding |
| `stop` | Stop only this deployment's processes |
| `up-unique` / `start-unique` | Use a per-host tunnel name |

## Server-side note

The Cloud Desktop runtime sets `T3CODE_INTERNAL_ONLY=1`. In T3 Custom the server reads it in a single
place (`apps/server/src/http.ts`) to keep CORS origins explicit, because every tunnel request carries
the OIDC cookie and is therefore credentialed. It has no other effect.
