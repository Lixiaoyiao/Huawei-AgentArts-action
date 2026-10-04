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
COPY test/fixtures/messages-sse.mjs test/fixtures/messages-sse.d.mts ./test/fixtures/
RUN npm run build:agentarts

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && groupadd --gid 10001 dshworker \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin dshworker
COPY --from=build /opt/app/dist-agentarts/runtime ./dist-agentarts/runtime
COPY assets ./assets
COPY LICENSE THIRD_PARTY_NOTICES.md BUNDLED_DEPENDENCIES.md ./
RUN chmod -R go-w /opt/app
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# Supervisor must retain root only to construct sealed workspaces and drop the
# DSH subprocess to UID/GID 10001. No repository code or shell tool is enabled.
USER 0:0
CMD ["node", "dist-agentarts/runtime/index.js"]
