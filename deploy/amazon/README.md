# T3 Code on Amazon Tunnels

This deployment builds the repository's web client and serves it from the local T3 server through an
owner-only Amazon HTTPS tunnel.

## Prerequisites

- Linux x86_64 Amazon development desktop.
- Authenticated Amazon Tunnels CLI. This deployment is validated with `tunnel 0.6.7`.
- Toolbox Codex CLI and its managed `codex-DO-NOT-DELETE` AWS profile.
- The standard CRUX CLI. Setup installs MyCli through Builder Toolbox when the remaining list,
  merge, or revision-update commands are missing. Review metadata and diffs use direct Critic,
  Workspace Snapshot, and GitFarm calls authenticated by Midway.
- Local Docker Engine exposed through a Unix socket, plus Git and tar.
- A `node` command capable of launching the setup script. The application runtime itself always
  uses the Node 24 distribution installed by Amazon Tunnels. On AL2, that distribution must itself
  be AL2-compatible.

Validate the checkout and local tools without building or starting anything:

```bash
node scripts/t3code-amazon.mjs doctor
```

`doctor` reports whether MyCli and the CRUX CLI are ready. It does not install them. The `setup`,
`up`, and `up-unique` commands add the MyCli registry and install MyCli when needed.

## Run

From a clean checkout, one command builds, verifies, installs, and starts the deployment:

```bash
node scripts/t3code-amazon.mjs up
```

Or if you'd like a host unique url

```bash
node scripts/t3code-amazon.mjs up-unique
```

On a browser that has not used the tunnel before, first run `url`, open that bare origin, and
complete any Midway authentication requested by Amazon Tunnels. Then issue and open a fresh
application pairing URL in the same browser:

```bash
node scripts/t3code-amazon.mjs url
node scripts/t3code-amazon.mjs pair
```

Do not authenticate the tunnel by opening a pairing URL: an intermediary login can discard its URL
fragment. `pair` is the only command that prints an application credential. Its one-time token is
exchanged for an HttpOnly application session cookie and expires after five minutes by default.
Set `T3CODE_AMAZON_PAIR_TTL` only when a different short lifetime is required. The URL is accepted only when its host exactly matches the current user's owner-prefixed tunnel name in use.

### Tunnel name

`start` and `up` always create the tunnel as `t3-code`, so their URL is the unchanging
`https://<owner>-t3-code.<alias>.tunnels.lab.aws.dev` origin.

To run this deployment on an additional host, start it there with the unique variants instead:

```bash
node scripts/t3code-amazon.mjs up-unique
node scripts/t3code-amazon.mjs start-unique
```

Those commands name the tunnel `t3-code-<host>`, where `<host>` is the first ten hex characters of a SHA-256 digest of the machine's persistent identity: `/etc/machine-id`, `/var/lib/dbus/machine-id`, or the lowercased hostname when neither file exists. The name therefore should never change on a host across reboots.

`start`, `up`, `start-unique`, and `up-unique` record the name they used.
`status`, `url`, `pair`, and `restart` then address the recorded tunnel name, so restarting never changes a running URL.
`doctor` prints the current name, its origin, and this host's unique name.

Set `T3CODE_AMAZON_TUNNEL_NAME` to pin one fixed readable name for every command instead, for example `t3-code-laptop`.
It accepts 1 to 32 lowercase alphanumeric or hyphen characters that start and end alphanumerically.

Run `stop` once before switching between `up` and `up-unique`.

To build and install without starting the server or tunnel, run:

```bash
node scripts/t3code-amazon.mjs setup
```

Useful lifecycle commands:

```bash
node scripts/t3code-amazon.mjs status
node scripts/t3code-amazon.mjs url
node scripts/t3code-amazon.mjs logs
node scripts/t3code-amazon.mjs stop
```

## macOS desktop client

The repository's existing Electron UI has an Amazon internal build mode. It can run a local backend
against provider CLIs installed on the Mac and can pair with this dev-desktop backend through its
Amazon Tunnel. The internal desktop build uses `~/.t3-amazon/userdata` for server and client state
and a separate Electron user-data directory; it does not read or migrate `~/.t3/userdata`.

From the repository root on an Apple Silicon Mac:

```bash
corepack pnpm install --frozen-lockfile

# Compile and open a production-mode desktop build
corepack pnpm start:desktop:amazon

# Or run the desktop development loop
corepack pnpm dev:desktop:amazon

# Build an unsigned arm64 DMG
corepack pnpm dist:desktop:dmg:arm64:amazon
```

In **Settings > Connections > Add environment**, select **SSH** and choose the development
desktop's SSH alias. An Amazon-internal desktop build automatically:

- clones the matching `T3CodeAmazonInternal` revision into
  `~/.cache/t3code-amazon/source` when the internal runtime is absent or stale;
- builds, smoke-tests, and installs the runtime matching the development desktop's Node glibc;
- reuses the running internal server or starts the exact installed runtime;
- forwards its loopback port over SSH and issues a fresh credential automatically;
- keeps backend state under `~/.local/state/t3code-amazon/t3-home`; and
- reconnects the saved SSH environment when the app starts.

The first connection can take several minutes. It requires the same Cloud Desktop prerequisites as
manual `setup`, plus authenticated read access to
`ssh://git.amazon.com:2222/pkg/T3CodeAmazonInternal`. Later connections skip provisioning
when the installed revision matches the desktop build. SSH or internal Git authentication failures
are reported as connection failures; no public `t3` package is installed.

To connect through Amazon Tunnels instead, including from the browser or mobile client:

1. Run `node scripts/t3code-amazon.mjs status` on the dev desktop and confirm the server and tunnel
   are ready.
2. Run `node scripts/t3code-amazon.mjs pair` and transfer the short-lived pairing URL directly to
   the Mac without logging or sharing it.
3. In the desktop app, open **Settings > Connections > Add environment** and paste the complete
   pairing URL.
4. Complete the Amazon sign-in window if it appears. The app injects the local Midway cookie jar
   when available and keeps Amazon Tunnel cookies in its isolated Electron session.
5. Select the saved environment to access the same T3 projects and threads. T3-managed provider
   sessions can then resume on either client because execution and thread state remain on the dev
   desktop.

The tunnel URL must match `*.tunnels.lab.aws.dev`. Internal desktop content security policy permits
only the app's local services and Amazon Tunnel HTTPS/WebSocket endpoints. Clerk, T3-hosted relay,
OTLP/PostHog telemetry, and updater startup are disabled. Provider traffic and explicit Git or
browser actions still use their configured destinations.

The Mac backend scopes its Codex subprocesses to the same `codex-DO-NOT-DELETE` AWS profile as the
dev-desktop launcher. Codex reads the region from the user's Codex config unless
`T3CODE_AMAZON_CODEX_AWS_REGION` explicitly overrides it. The existing
`T3CODE_AMAZON_CODEX_AWS_PROFILE` override also applies to both.

Amazon T3 records the effective Bedrock region in each Codex thread's resume cursor. Changing the
user's Codex region therefore affects new threads without moving existing continuations. Threads
created by older Amazon T3 builds have no recorded region and continue in the former `us-east-2`
default on their first resume.

The embedded desktop browser also uses the Mac's managed Chromium authentication allowlists and
local Amazon Enterprise Access native helper. On an enrolled Amazon Mac, internal sites receive
the same short-lived AEA posture cookies and authentication headers as managed Chrome without
copying Chrome profile cookies or requiring an extension install inside T3 Code. This integration
is inactive in standard desktop builds and on non-macOS hosts.

The internal desktop backend itself always binds to `127.0.0.1`. Persisted settings and inherited
environment variables cannot enable LAN exposure, custom advertised endpoints, or Tailscale Serve.
The Connections UI labels this boundary as a machine-only local backend with authenticated Amazon
Tunnels as the only remote pairing route.

With the installed deployment running, execute its authenticated browser feature and egress smoke
test from the repository root:

```bash
node deploy/amazon/browser-smoke.mjs
```

The smoke test creates and consumes its own short-lived pairing token. It checks the installable and
offline PWA shell, responsive phone/tablet/desktop layouts, image and camera attachments, software
QR fallback, touch-terminal accessory keys, archived-thread controls, notifications, and that
the Toolbox Codex and Claude providers and their models are discovered. It also verifies that
browser requests stay on the configured application origin.

## Reproducibility

`setup` pins the Dockerfile frontend and every external base image by digest. Debian packages come
from a dated snapshot, Amazon Linux packages come from a content-addressed repository revision,
pnpm is pinned to the repository's `packageManager`, and dependency installation uses the frozen
lockfile. Native FFI sources use full Git commit IDs and locked Cargo dependencies. Exported tar
metadata is normalized for stable ordering, ownership, and timestamps.

Clean-checkout bootstrap requires network access to pull the pinned Dockerfile frontend and base
images, Debian and Amazon Linux packages, pnpm and lockfile dependencies, and the pinned native Git
and Cargo inputs. Those downloads happen only in stages that do not contain application source. The
pnpm acquisition stage receives dependency manifests, the lockfile, workspace metadata, and
dependency patch inputs; it uses `--ignore-scripts`. Docker must still send the build context to its
daemon, so the setup driver requires a local Unix-socket daemon unless a reviewed workflow opts in
to a remote builder explicitly.

The dependency store is complete before `COPY . .`. From that full application-source copy onward,
pnpm runs offline,
Corepack and common browser-binary downloads are disabled, and every source-aware Docker `RUN`
uses `--network=none`. The online, source-free acquisition validates the lockfile supply-chain
policy; the source-aware install trusts that same frozen lockfile to avoid repeating registry
metadata and attestation lookups without network access. Native dependency scripts use the Node
headers already present in the pinned toolchain rather than downloading headers. Amazon Linux
package acquisition likewise finishes before the built runtime is copied into its stage; native
installation, rebuilds, verification, and artifact creation remain network-disabled. Dependency
lifecycle and repository build scripts therefore cannot send source over the network during setup.

The Amazon Tunnels CLI's Node distribution is mounted into a matching amd64 Amazon Linux 2 or
Amazon Linux 2023 runtime build stage. The setup script selects the stage from the glibc used by
that Node distribution. It compiles pinned `node-pty` sources directly without Python or package
lifecycle scripts. A separate Amazon Linux 2 stage compiles pinned `ffi-rs` and FFF revisions
against glibc 2.26, and the selected runtime stage runs server,
asset, pairing, authenticated WebSocket, file-search, and PTY smoke tests. Startup never runs a
package-manager install.

`up` and `up-unique` fingerprint all deployment source bytes, file modes, and tracked deletions.
They rebuild when those inputs or the tunnel-managed Node distribution change.
The distribution fingerprint covers the actual Node executable, Node headers, and bundled npm metadata, not just the reported version.
Mutating commands publish a complete lifecycle lock atomically. After readiness, server and tunnel
process records are sealed to the executable and complete argument vector observed through
`/proc`, in addition to PID and Linux process start time. Lifecycle commands refuse to trust or
signal a process unless all recorded identity fields still match.

Override discovery only when needed:

```bash
T3CODE_NODE_BIN=/path/to/node \
T3CODE_NODE_ROOT=/path/to/complete/node/distribution \
T3CODE_TUNNEL_BIN=/path/to/tunnel \
T3CODE_AMAZON_WORKSPACE=/path/to/project \
node scripts/t3code-amazon.mjs setup
```

### Codex on Bedrock

By default, the launcher scopes Codex subprocesses to the `codex-DO-NOT-DELETE` AWS profile and
leaves region selection to the user's Codex config. It appends the profile configuration after the
user's existing Codex launch arguments; it does not replace those arguments, set process-wide
`AWS_PROFILE`, or alter Claude authentication. To override either value for this deployment, set
`T3CODE_AMAZON_CODEX_AWS_PROFILE` or `T3CODE_AMAZON_CODEX_AWS_REGION`; `doctor`, `setup`, and
`start` validate explicit overrides before use.

The effective Bedrock region is persisted with each Codex resume cursor. A later region override or
Codex config change applies to new threads while existing threads continue in the region where they
were created. Resume cursors written before region persistence use the former `us-east-2` default
unless their provider launch arguments already select a region.

The launcher also repairs only three known stale, unprefixed models in the text-generation setting
stored in the isolated Amazon T3 home: `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol` become
`openai.gpt-5.6-luna`, `openai.gpt-5.6-terra`, and `openai.gpt-5.6-sol`, respectively. Already
prefixed values and every other model identifier are preserved. This normalization does not inspect
or modify the developer's normal `~/.t3/userdata`.

State defaults to `~/.local/state/t3code-amazon` and can be moved with
`T3CODE_AMAZON_STATE_DIR`. The directory must be owned by the current user, cannot be a symlink, and
is marked with a deployment sentinel before recursive cleanup is allowed. A non-empty state
directory without that sentinel is rejected. State cannot overlap the repository or
`~/.t3/userdata`; logs and records are owner-only regular files.

Builds reject remote Docker contexts and non-Unix `DOCKER_HOST` endpoints by default so repository
contents are not sent to another daemon. If a reviewed workflow intentionally uses a remote
builder, opt in explicitly with `T3CODE_AMAZON_ALLOW_REMOTE_DOCKER=1`.

## Network Policy

The source build and runtime set `T3CODE_INTERNAL_ONLY=1`. This disables T3 Connect, Clerk,
PostHog, relay OTLP, automatic package-version checks, hosted model-manifest refreshes, provider
feedback uploads, and in-app provider update commands. Local provider status and model discovery
remain enabled because they are required to operate the configured provider CLIs. Generic OTEL
exporters and provider error-reporting hints are also disabled in the launched process environment.
Docker excludes every `.env` file from the build
context. The packaged client receives a restrictive Content Security Policy that permits
same-origin requests plus HTTPS and WebSocket connections to Amazon tunnel subdomains, while
blocking automatic third-party browser requests. No `VITE_HTTP_URL` or `VITE_WS_URL` is baked into
the client. The app binds only to `127.0.0.1:3773`; Amazon Tunnels supplies HTTPS and owner
authentication.

The recorded tunnel URL is accepted only when it is an HTTPS origin with the exact
`<owner>-<name>.<alias>.tunnels.lab.aws.dev` hostname, where the CLI-assigned alias is one
alphanumeric character, or its legacy unlabeled form. Recovery and readiness use
`tunnel list --json` and require one exact match for the current owner-prefixed tunnel name, local
port `3773`, recorded tunnel PID, and allowlist containing only the current Amazon user.
`doctor` also requires an authenticated tunnel CLI. When Builder Toolbox vends the command, the
lifecycle runner resolves its versioned launcher so Toolbox's dispatcher cannot hide the tunnel
worker behind a different PID.

Provider CLIs and explicit source-control actions still use their configured provider and repository
endpoints. Internal-only mode prevents T3-owned background egress; it is not a generic network
sandbox for child processes launched by a user. The source-free bootstrap stages still contact the
configured package registries and pinned source endpoints described above; the installed runtime
does not perform those setup downloads.

## Mobile parity

The installed web app is responsive across phone, tablet, and desktop layouts and includes camera
and QR pairing with an on-device software decoder fallback, image sharing, complete touch-terminal
accessory keys, installable PWA assets, durable offline tasks, notifications, badging,
searchable/filterable archived threads, and Amazon-tunnel multi-environment connections. Saved
remote environment labels and URLs can be edited without exposing or replacing their paired
credential.

iOS APIs that have no browser equivalent use internal-only web behavior instead:

- ActivityKit status is represented by the document title, favicon state, app badge, and browser
  notification while the PWA is connected.
- Closed-app push subscriptions are not registered because browser push delivery depends on Apple
  or Google push services. Where the installed browser grants Periodic Background Sync, the service
  worker instead performs best-effort checks against only this authenticated origin and displays
  generic approval, input, completion, or failure notifications. Browser policy controls timing;
  unsupported browsers fall back to open-app or reconnect delivery.
- Installed web manifests provide the static New task launcher shortcut; recent threads remain at
  the top of the in-app sidebar because browsers do not expose a reliable dynamic shortcut API.
