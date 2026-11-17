# syntax=docker/dockerfile:1
#
# Retween renderer: Timeline JSON -> MP4 (Remotion) behind an HTTP server on :8080.
#
# Build from the REPO ROOT (the image needs shared/ as well as renderer/):
#   docker build --platform linux/amd64 -f renderer/Dockerfile -t retween-renderer .
#
# Target: Cloudflare Containers (linux/amd64, runs as root, no GPU, ephemeral disk).

ARG NODE_IMAGE=node:24-bookworm-slim

# --- build: Remotion bundle + server bundle ----------------------------------
# Both outputs are plain JavaScript, so this stage runs on the build machine's
# own architecture instead of under emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app/renderer
COPY renderer/package.json renderer/package-lock.json ./
RUN npm ci --no-audit --no-fund
# shared/timeline.ts is the contract. The composition only imports its types; the server
# bundle inlines it and leaves `zod` external, so zod resolves from /app/renderer/node_modules
# at runtime (it would not be found by walking up from /app/shared).
COPY shared /app/shared
COPY renderer/tsconfig.json ./
COPY renderer/scripts ./scripts
COPY renderer/src ./src
COPY renderer/server ./server
# Source maps stay: Remotion reads bundle.js.map when it prepares a render.
RUN npm run build

# --- deps: production node_modules + the browser ------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app/renderer
COPY renderer/package.json renderer/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Chrome Headless Shell is downloaded now, into node_modules/.remotion, never at request time.
RUN node -e "import('@remotion/renderer').then((r) => r.ensureBrowser()).then((b) => console.log('browser:', b.path))"
# Trim what a render never touches.
RUN find node_modules \( -name '*.map' -o -name '*.md' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.tsbuildinfo' \) -type f -delete

# --- runtime -------------------------------------------------------------------
# Plain Debian plus the node binary: no npm, yarn or corepack in the final image.
FROM debian:bookworm-slim AS runtime
# Shared libraries Chrome Headless Shell needs (https://www.remotion.dev/docs/miscellaneous/linux-dependencies),
# one base font so no glyph can ever render invisibly, and tini to reap Chrome's child processes.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 \
		libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2 \
		fonts-dejavu-core ca-certificates tini \
	&& rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
WORKDIR /app/renderer
COPY --from=deps /app/renderer/node_modules ./node_modules
COPY renderer/package.json ./
COPY --from=build /app/renderer/build ./build
COPY --from=build /app/renderer/dist ./dist

ENV NODE_ENV=production \
	PORT=8080 \
	OUTPUT_DIR=/tmp/retween-renderer
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.mjs"]
