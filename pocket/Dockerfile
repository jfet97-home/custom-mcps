FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY ui ./ui
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
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
