# Build with: docker buildx build --platform linux/arm64 -f agentarts/Dockerfile .
# The exact multi-architecture digest was verified from Docker Hub for Node
# 24.15.0-bookworm-slim. Runtime deployment also pins the final image digest.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS build
WORKDIR /opt/app
COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY assets ./assets
COPY scripts ./scripts
COPY tsconfig.json ./
COPY test/fixtures/messages-sse.mjs test/fixtures/messages-sse.d.mts ./test/fixtures/
# Only the Runtime is deployed; host Controller/evaluation bundles are built separately.
RUN node scripts/build-agentarts.mjs --runtime-only

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS namespace-build
RUN apt-get update \
    && apt-get install --no-install-recommends --yes build-essential dpkg-dev pkg-config libcap-dev libselinux1-dev ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /inputs
COPY agentarts/bubblewrap-source.json agentarts/bubblewrap-proc-subset.patch ./agentarts/
COPY scripts/build-agentarts-bwrap.mjs ./scripts/
RUN NODE_USE_ENV_PROXY=1 node scripts/build-agentarts-bwrap.mjs /build

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install --no-install-recommends --yes libcap2 libselinux1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=namespace-build /build/bubblewrap/bwrap /usr/bin/bwrap
COPY --from=namespace-build /build/sources /usr/share/doc/bubblewrap/agentarts-source
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && groupadd --gid 10001 dshworker \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dshworker
COPY --from=build /opt/app/dist-agentarts/runtime ./dist-agentarts/runtime
COPY assets ./assets
COPY LICENSE THIRD_PARTY_NOTICES.md BUNDLED_DEPENDENCIES.md ./
# Only repair writable files/directories; chmod on every dependency inode forces
# an unnecessary overlay copy-up. Like recursive chmod, do not follow symlinks.
RUN find /opt/app \( -type d -o -type f \) -perm /022 -exec chmod go-w {} +
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# Supervisor constructs sealed task namespaces and mediates credentials.
# Repository/tool processes run inside bwrap under UID/GID 10001.
USER 0:0
CMD ["node", "dist-agentarts/runtime/index.js"]
