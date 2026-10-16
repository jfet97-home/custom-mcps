FROM eclipse-temurin:21-jdk-jammy@sha256:e0c60c487345d1dc9d0fc7b6f0496f3cc941e5132e09296cc17a6decc71b902b AS java

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS ghidra-build

ARG GHIDRA_VERSION=12.1.4
ARG GHIDRA_RELEASE_DATE=20260921
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bison build-essential ca-certificates curl unzip zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --retry 3 \
        "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_RELEASE_DATE}.zip" \
        --output /tmp/ghidra.zip \
    && printf '%s  /tmp/ghidra.zip\n' "$GHIDRA_SHA256" | sha256sum --check - \
    && unzip -q /tmp/ghidra.zip -d /opt \
    && mv "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra \
    && rm /tmp/ghidra.zip

WORKDIR /opt/ghidra/Ghidra/Features/Decompiler/src/decompile/cpp
RUN case "$TARGETARCH" in \
        arm64) ghidra_platform=linux_arm_64 ;; \
        amd64) ghidra_platform=linux_x86_64 ;; \
        *) printf 'Unsupported Ghidra architecture: %s\n' "$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && make -j2 ghidra_opt ARCH_TYPE= OSDIR="$ghidra_platform" \
    && install -D -m 755 ghidra_opt "/opt/ghidra/Ghidra/Features/Decompiler/os/$ghidra_platform/decompile" \
    && rm -rf ghi_opt ghidra_opt

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

ENV NODE_ENV=production \
    JAVA_HOME=/opt/java/openjdk \
    GHIDRA_INSTALL_DIR=/opt/ghidra
ENV PATH="${JAVA_HOME}/bin:${PATH}"

COPY --from=java /opt/java/openjdk /opt/java/openjdk
COPY --from=ghidra-build /opt/ghidra /opt/ghidra

RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/rea
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit \
    && mkdir -p /home/node/.rea \
    && chown node:node /home/node/.rea

USER node

CMD ["node", "node_modules/supergateway/dist/index.js", "--stdio", "node /opt/rea/node_modules/rea-agents/scripts/rea.mjs mcp", "--outputTransport", "streamableHttp", "--stateful", "--sessionTimeout", "86400000", "--host", "0.0.0.0", "--port", "9012", "--healthEndpoint", "/healthz", "--logLevel", "none"]
