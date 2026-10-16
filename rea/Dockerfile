FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/rea
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit \
    && mkdir -p /home/node/.rea \
    && chown node:node /home/node/.rea

USER node

CMD ["node", "node_modules/supergateway/dist/index.js", "--stdio", "node /opt/rea/node_modules/rea-agents/scripts/rea.mjs mcp", "--outputTransport", "streamableHttp", "--stateful", "--sessionTimeout", "86400000", "--host", "0.0.0.0", "--port", "9012", "--healthEndpoint", "/healthz", "--logLevel", "none"]
