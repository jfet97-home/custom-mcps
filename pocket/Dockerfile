FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY ui ./ui
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG POCKET_SOURCE_REVISION=development
LABEL org.opencontainers.image.source="https://github.com/jfet97-home/custom-mcps" \
      org.opencontainers.image.revision="${POCKET_SOURCE_REVISION}"
WORKDIR /app
ENV NODE_ENV=production HOME=/home/node POCKET_HOST=0.0.0.0 POCKET_PORT=9011 \
    POCKET_DATA_DIR=/data POCKET_SESSION_LOCK_DIR=/data POCKET_SOURCE_REVISION=${POCKET_SOURCE_REVISION}
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/ui ./dist/ui
USER node
EXPOSE 9011
CMD ["node", "dist/src/cli.js", "serve"]
