# Single container: the helm serves the built web app + API + sockets from one origin.
# SEC-021 / OPT-059: multi-stage. The build stage has dev tooling; the runtime stage has production dependencies
# only, runs compiled JS (no tsx) as the unprivileged `node` user (via docker-entrypoint.mjs), with NODE_ENV=production baked in.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
# Browser-visible build-time key (restrict it by HTTP referrer in Google Cloud)
ARG VITE_GOOGLE_MAP_TILES_KEY=""
ENV VITE_GOOGLE_MAP_TILES_KEY=$VITE_GOOGLE_MAP_TILES_KEY
ARG VITE_CESIUM_ION_TOKEN=""
ENV VITE_CESIUM_ION_TOKEN=$VITE_CESIUM_ION_TOKEN
# web → apps/web/dist (hidden source maps, deleted here: SEC-024); server → apps/server/dist/index.js
RUN npm run build && find apps/web/dist -name '*.map' -delete

FROM node:22-slim
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace=@all-ayes/server --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY apps/server/scripts/docker-entrypoint.mjs apps/server/scripts/docker-entrypoint.mjs
# default DATA_DIR / CACHE_DIR, owned by the node user
RUN mkdir -p apps/server/data apps/server/.cache && chown -R node:node apps/server/data apps/server/.cache
# The container starts as root ONLY so the entrypoint can chown a mounted persistent disk (Render mounts /var/data
# root-owned) at DATA_DIR/CACHE_DIR; it then drops to `node` (uid 1000) before the server loads. The server never
# runs as root. `docker run --user node` also works (the chown step is skipped; the mount must then be writable).
EXPOSE 8787
CMD ["node", "apps/server/scripts/docker-entrypoint.mjs"]
