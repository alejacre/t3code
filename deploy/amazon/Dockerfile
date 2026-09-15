# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG T3CODE_RUNTIME_BASE=runtime-base-al2023

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS node-toolchain

RUN sed -i \
      -e 's|URIs: http://deb.debian.org/debian-security|URIs: http://snapshot.debian.org/archive/debian-security/20260316T000000Z|' \
      -e 's|URIs: http://deb.debian.org/debian|URIs: http://snapshot.debian.org/archive/debian/20260316T000000Z|' \
      -e '/^Signed-By:/a Check-Valid-Until: no' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates g++ git make python3 \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV SOURCE_DATE_EPOCH=0
ENV T3CODE_INTERNAL_ONLY=1
ENV T3CODE_TELEMETRY_ENABLED=false
ENV T3CODE_CLERK_PUBLISHABLE_KEY=
ENV T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=
ENV T3CODE_RELAY_URL=
ENV T3CODE_HOSTED_APP_URL=
ENV T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=
ENV T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET=
ENV T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=
ENV VITE_CLERK_PUBLISHABLE_KEY=
ENV VITE_CLERK_CLI_OAUTH_CLIENT_ID=
ENV VITE_T3CODE_RELAY_URL=
ENV VITE_HOSTED_APP_URL=
ENV VITE_RELAY_OTLP_TRACES_URL=
ENV VITE_RELAY_OTLP_TRACES_DATASET=
ENV VITE_RELAY_OTLP_TRACES_TOKEN=

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
RUN pnpm config set store-dir /pnpm/store

FROM node-toolchain AS dependency-fetch

WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/marketing/package.json ./apps/marketing/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY infra/relay/package.json ./infra/relay/package.json
COPY oxlint-plugin-t3code/package.json ./oxlint-plugin-t3code/package.json
COPY packages/client-runtime/package.json ./packages/client-runtime/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/effect-acp/package.json ./packages/effect-acp/package.json
COPY packages/effect-codex-app-server/package.json ./packages/effect-codex-app-server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/ssh/package.json ./packages/ssh/package.json
COPY packages/tailscale/package.json ./packages/tailscale/package.json
COPY scripts/package.json ./scripts/package.json

RUN pnpm install \
      --filter t3... \
      --filter @t3tools/scripts... \
      --frozen-lockfile \
      --ignore-scripts

FROM node-toolchain AS build

ENV COREPACK_ENABLE_NETWORK=0
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV npm_config_nodedir=/usr/local
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PUPPETEER_SKIP_DOWNLOAD=1

WORKDIR /src
COPY --from=dependency-fetch /pnpm/store /pnpm/store
COPY . .
RUN --network=none git init

RUN --network=none pnpm install \
      --filter t3... \
      --filter @t3tools/scripts... \
      --frozen-lockfile \
      --trust-lockfile \
      --offline
RUN --network=none node --test \
    deploy/amazon/build-node-pty.test.mjs \
    deploy/amazon/harden-client.test.mjs \
    deploy/amazon/harden-server.test.mjs \
    deploy/amazon/install-native.test.mjs \
    deploy/amazon/list-runtime-native.test.mjs \
    deploy/amazon/reproducibility.test.mjs \
    deploy/amazon/runtime-smoke.test.mjs \
    scripts/t3code-amazon.test.mjs
RUN --network=none pnpm exec vp test run \
    apps/server/src/cli/config.test.ts \
    apps/server/src/cloud/publicConfig.test.ts \
    apps/server/src/cloud/ManagedEndpointRuntime.test.ts \
    apps/server/src/git/GitManager.test.ts \
    apps/server/src/provider/makeManagedServerProvider.test.ts \
    apps/server/src/provider/Layers/codexLaunchArgs.test.ts \
    apps/server/src/provider/providerMaintenance.test.ts \
    apps/server/src/provider/providerMaintenanceRunner.test.ts \
    apps/server/src/relay/AgentAwarenessRelay.test.ts \
    apps/server/src/serverRuntimeStartup.test.ts \
    apps/server/src/telemetry/AnalyticsService.test.ts \
    apps/server/src/vcs/VcsStatusBroadcaster.test.ts \
    apps/web/src/components/settings/settingsSearch.test.ts \
    apps/web/src/lib/favicon.test.ts \
    packages/client-runtime/src/errors/transport.test.ts \
    packages/shared/src/relayClient.test.ts \
    scripts/lib/public-config.test.ts \
    apps/web/src/lib/amazonTunnelFetch.test.ts \
    packages/shared/src/amazonTunnel.test.ts
RUN --network=none pnpm exec vp run \
    --filter t3 \
    --filter @t3tools/web \
    --filter @t3tools/client-runtime \
    --filter @t3tools/scripts \
    typecheck
RUN --network=none pnpm exec vp run --filter @t3tools/web build
RUN --network=none node apps/server/scripts/cli.ts build
RUN --network=none node deploy/amazon/harden-client.mjs /src/apps/server/dist/client/index.html
RUN --network=none node deploy/amazon/harden-server.mjs /src/apps/server/dist/bin.mjs
RUN --network=none pnpm --config.inject-workspace-packages=true --filter t3 deploy \
    --prod \
    --offline \
    --trust-lockfile \
    /runtime

FROM rust:1.89.0-slim-bookworm@sha256:d7fc7de78bb8c1469933aeecbf801314d30d7d6e9f0578bba4cfa285bfa37fe6 AS rust-toolchain

FROM amazonlinux:2@sha256:af6e7c0a7d9abb123f2d27f12b1c2aceedfd80add1cc3109b93440ab900af4d2 AS amazonlinux-pinned

ARG T3CODE_AL_MIRROR_ARCH=x86_64

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN sed -i \
      "/^\[amzn2-core\]\$/,/^\$/ s|^mirrorlist=.*|baseurl=https://cdn.amazonlinux.com/2/core/2.0/${T3CODE_AL_MIRROR_ARCH}/f3227080bbb7eb87233fe07f8bd4307821255d87171ecd2c1acf1c0a240aa9aa/|" \
      /etc/yum.repos.d/amzn2-core.repo \
    && sed -n "/^\[amzn2-core\]\$/,/^\$/p" /etc/yum.repos.d/amzn2-core.repo \
      | grep -F "baseurl=https://cdn.amazonlinux.com/2/core/2.0/${T3CODE_AL_MIRROR_ARCH}/f3227080bbb7eb87233fe07f8bd4307821255d87171ecd2c1acf1c0a240aa9aa/"

FROM amazonlinux:2023@sha256:fa946e513ed149232490479653141fa4c6cd1e71c70130525cf00a791477ed19 AS amazonlinux2023-pinned

ARG T3CODE_AL_MIRROR_ARCH=x86_64

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN sed -i \
      "/^\[amazonlinux\]\$/,/^\$/ s|^mirrorlist=.*|baseurl=https://cdn.amazonlinux.com/al2023/core/guids/e56f3d932530715bd6022770def2a18cbd23bf97fca31b6ad2278227c8ca127e/${T3CODE_AL_MIRROR_ARCH}/|" \
      /etc/yum.repos.d/amazonlinux.repo \
    && sed -n "/^\[amazonlinux\]\$/,/^\$/p" /etc/yum.repos.d/amazonlinux.repo \
      | grep -F "baseurl=https://cdn.amazonlinux.com/al2023/core/guids/e56f3d932530715bd6022770def2a18cbd23bf97fca31b6ad2278227c8ca127e/${T3CODE_AL_MIRROR_ARCH}/"

FROM amazonlinux-pinned AS native-build

ARG FFI_RS_COMMIT=9c5ba3452d8cedbb0b30c7ce4dd0138135bd06ea
ARG FFF_COMMIT=7d7910b6ba78ea8406671eaac8cdb5eb9850d9d1
ARG T3CODE_NAPI_ARCH=x64

RUN yum install -y \
      binutils \
      cmake3 \
      gcc10 \
      gcc10-c++ \
      git \
      make \
      perl-core \
      pkgconfig \
    && yum clean all \
    && ln -s /usr/bin/cmake3 /usr/local/bin/cmake

COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup

ENV CARGO_HOME=/usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup
ENV PATH=/usr/local/cargo/bin:$PATH
ENV SOURCE_DATE_EPOCH=0
ENV CC=/usr/bin/gcc10-gcc
ENV CXX=/usr/bin/gcc10-g++
ENV CMAKE=/usr/bin/cmake3
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/usr/bin/gcc10-gcc
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=/usr/bin/gcc10-gcc

WORKDIR /build
RUN git init ffi-rs \
    && git -C ffi-rs remote add origin https://github.com/zhangyuang/node-ffi-rs.git \
    && git -C ffi-rs fetch --depth 1 origin "$FFI_RS_COMMIT" \
    && git -C ffi-rs checkout --detach FETCH_HEAD \
    && test "$(git -C ffi-rs rev-parse HEAD)" = "$FFI_RS_COMMIT"
RUN git init fff \
    && git -C fff remote add origin https://github.com/dmtrKovalenko/fff.git \
    && git -C fff fetch --depth 1 origin "$FFF_COMMIT" \
    && git -C fff checkout --detach FETCH_HEAD \
    && test "$(git -C fff rev-parse HEAD)" = "$FFF_COMMIT"
RUN --mount=type=cache,id=t3code-amazon-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=t3code-amazon-cargo-git,target=/usr/local/cargo/git \
    cargo build --manifest-path /build/ffi-rs/Cargo.toml --release --locked
RUN --mount=type=cache,id=t3code-amazon-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=t3code-amazon-cargo-git,target=/usr/local/cargo/git \
    cargo build --manifest-path /build/fff/Cargo.toml --release --locked -p fff-c
RUN mkdir -p /native \
    && cp /build/ffi-rs/target/release/libffi_rs.so "/native/ffi-rs.linux-${T3CODE_NAPI_ARCH}-gnu.node" \
    && cp /build/fff/target/release/libfff_c.so /native/libfff_c.so \
    && ffi_symbols="$(objdump -T "/native/ffi-rs.linux-${T3CODE_NAPI_ARCH}-gnu.node")" \
    && fff_symbols="$(objdump -T /native/libfff_c.so)" \
    && test "$(grep -o 'GLIBC_[0-9.]*' <<< "$ffi_symbols" | sort -Vu | tail -n 1)" != "GLIBC_2.27" \
    && ! grep -Eq 'GLIBC_2\.([3-9][0-9]|2[7-9])' <<< "$ffi_symbols" \
    && ! grep -Eq 'GLIBC_2\.([3-9][0-9]|2[7-9])' <<< "$fff_symbols"

FROM amazonlinux-pinned AS runtime-base-al2

RUN yum install -y binutils gcc10 gcc10-c++ gzip tar \
    && yum clean all

ENV CC=/usr/bin/gcc10-gcc
ENV CXX=/usr/bin/gcc10-g++

FROM amazonlinux2023-pinned AS runtime-base-al2023

RUN dnf install -y binutils gcc-c++ gzip tar \
    && dnf clean all

ENV CC=/usr/bin/gcc
ENV CXX=/usr/bin/g++

FROM ${T3CODE_RUNTIME_BASE} AS runtime-build

ARG T3CODE_RUNTIME_GLIBC=2.34
COPY --from=t3code-node / /opt/node
ENV PATH=/opt/node/bin:$PATH
ENV SOURCE_DATE_EPOCH=0
ENV T3CODE_RUNTIME_GLIBC=${T3CODE_RUNTIME_GLIBC}
ENV npm_config_nodedir=/opt/node
ENV npm_config_build_from_source=true
ENV npm_config_offline=true
ENV T3CODE_INTERNAL_ONLY=1
ENV T3CODE_TELEMETRY_ENABLED=false

RUN node -e "const assert = require('node:assert/strict'); assert.match(process.version, /^v24\\./); assert.equal(process.report.getReport().header.glibcVersionRuntime, process.env.T3CODE_RUNTIME_GLIBC)"

COPY --from=build /runtime /runtime
COPY --from=native-build /native /native
COPY --from=build /src/deploy/amazon/build-node-pty.mjs /opt/t3code/build-node-pty.mjs
COPY --from=build /src/deploy/amazon/install-native.mjs /opt/t3code/install-native.mjs
COPY --from=build /src/deploy/amazon/node-distribution-fingerprint.mjs /opt/t3code/node-distribution-fingerprint.mjs

RUN --network=none node /opt/t3code/install-native.mjs /runtime /native
RUN --network=none node /opt/t3code/build-node-pty.mjs \
      /runtime/node_modules/node-pty \
      /opt/node
RUN --network=none node --version > /runtime/.t3code-node-version
RUN --network=none node /opt/t3code/node-distribution-fingerprint.mjs /opt/node \
      > /runtime/.t3code-node-distribution-sha256
RUN --network=none find /runtime -type f \( -name '*.node' -o -name '*.so' \) -exec bash -o pipefail -c \
      'for native do \
        if [[ "$(od -An -N4 -tx1 "$native" | tr -d " \n")" != "7f454c46" ]]; then \
          continue; \
        fi; \
        symbols="$(objdump -T "$native")" || { \
          echo "Could not inspect native artifact: $native" >&2; \
          exit 1; \
        }; \
        max_glibc="$(grep -o "GLIBC_[0-9.]*" <<< "$symbols" | sort -Vu | tail -n 1)"; \
        if [[ "$(printf "GLIBC_%s\n%s\n" "$T3CODE_RUNTIME_GLIBC" "$max_glibc" | sort -Vu | tail -n 1)" != "GLIBC_$T3CODE_RUNTIME_GLIBC" ]]; then \
          echo "Native artifact exceeds the GLIBC $T3CODE_RUNTIME_GLIBC ceiling: $native" >&2; \
          exit 1; \
        fi; \
      done' bash {} +

FROM ${T3CODE_RUNTIME_BASE} AS runtime-verify

COPY --from=t3code-node / /opt/node
ENV PATH=/opt/node/bin:$PATH
ENV T3CODE_INTERNAL_ONLY=1
ENV T3CODE_TELEMETRY_ENABLED=false

COPY --from=runtime-build /runtime /runtime
COPY --from=build /src/deploy/amazon/list-runtime-native.mjs /opt/t3code/list-runtime-native.mjs
COPY --from=build /src/deploy/amazon/runtime-smoke.mjs /opt/t3code/runtime-smoke.mjs

RUN --network=none while IFS= read -r -d '' native; do \
      ldd "$native" || exit 1; \
    done < <(node /opt/t3code/list-runtime-native.mjs /runtime) \
      | tee /tmp/native-dependencies.txt \
    && ! grep -q 'not found' /tmp/native-dependencies.txt
RUN --network=none node /opt/t3code/runtime-smoke.mjs /runtime

RUN --network=none touch /runtime-verified

FROM runtime-build AS artifact-build

COPY --from=runtime-verify /runtime-verified /runtime-verified
RUN --network=none mkdir -p /artifacts \
    && tar \
      --sort=name \
      --mtime="@${SOURCE_DATE_EPOCH}" \
      --owner=0 \
      --group=0 \
      --numeric-owner \
      -C /runtime \
      -czf /artifacts/t3code-amazon-runtime.tar.gz \
      .

FROM scratch AS artifact
COPY --from=artifact-build /artifacts/ /
