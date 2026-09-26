# Ravelon Sync: API and web interface in one image, on one port.
#
# One container is the whole deployment. The web interface is built into static
# files the API serves itself, so there is no second image, no CORS to
# configure and no API URL baked in at build time.

# Node 24 is the Active LTS line. Stay on an LTS major: an odd-numbered or
# not-yet-LTS "Current" release drops out of support within months.

# --- build ------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 compiles a native module when no prebuilt binary matches the
# platform. None of this reaches the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Manifests first, so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build --workspace web \
  && npm run build --workspace server


# --- production dependencies ------------------------------------------------
# A separate install rather than pruning the build tree: the result carries no
# build tooling, and npm resolves it from the same lockfile, so it is exactly
# reproducible.
FROM node:24-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
# npm workspaces hoists into the root node_modules, so this one directory is
# the whole dependency tree.
RUN npm ci --omit=dev


# --- runtime ----------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# Reported by /v1/health and the admin interface. CI passes the release tag or
# commit; a local build without it reports the server's built-in version.
ARG RAVELON_SYNC_VERSION=""

ENV NODE_ENV=production \
    RAVELON_SYNC_VERSION=${RAVELON_SYNC_VERSION} \
    PORT=4100 \
    HOST=0.0.0.0 \
    DATABASE_FILE=/data/ravelon-sync.db \
    WEB_ROOT=/app/server/public

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown -R node:node /data

COPY --from=deps  --chown=node:node /app/node_modules   ./node_modules
COPY --from=build --chown=node:node /app/server/dist    ./server/dist
COPY --from=build --chown=node:node /app/server/public  ./server/public
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/package.json   ./package.json

# Never root. The database lives in a volume this user owns. `node` is uid and
# gid 1000 in the official image; a bind mount instead of the named volume has
# to be writable by that uid (see docs/INSTALLATION.md).
USER node
VOLUME ["/data"]
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node handles SIGTERM itself for a clean shutdown, so no init wrapper.
CMD ["node", "server/dist/main.js"]
