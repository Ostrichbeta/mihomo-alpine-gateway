# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1: Download mihomo binary
# =============================================================================
FROM alpine:3.24 AS mihomo-downloader

ARG MIHOMO_VERSION=latest
ARG TARGETPLATFORM
ARG MIHOMO_VARIANT

RUN apk add --no-cache curl gzip

RUN set -eux; \
    # Resolve "latest" to an actual version tag via HTTP redirect
    if [ "$MIHOMO_VERSION" = "latest" ]; then \
      MIHOMO_VERSION=$(curl -sI https://github.com/MetaCubeX/mihomo/releases/latest \
        | grep -i '^location:' \
        | sed 's#.*/tag/##' \
        | tr -d '\r\n'); \
    fi; \
    # Extract arch from TARGETPLATFORM (linux/amd64 -> amd64)
    ARCH=$(echo "$TARGETPLATFORM" | cut -d/ -f2); \
    # Construct asset name based on arch and variant
    if [ "$ARCH" = "arm64" ]; then \
      ASSET="mihomo-linux-arm64-${MIHOMO_VERSION}.gz"; \
    else \
      ASSET="mihomo-linux-amd64-${MIHOMO_VARIANT}-${MIHOMO_VERSION}.gz"; \
    fi; \
    URL="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${ASSET}"; \
    echo "Downloading $URL"; \
    curl -fL "$URL" | gunzip > /usr/local/bin/mihomo; \
    chmod +x /usr/local/bin/mihomo; \
    /usr/local/bin/mihomo -v

# =============================================================================
# Stage 2: Download geo databases
# =============================================================================
FROM alpine:3.24 AS geodata-downloader

RUN apk add --no-cache curl

ENV GEODATA_BASE=https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest

RUN mkdir -p /geo && \
    curl -fL ${GEODATA_BASE}/geosite.dat      -o /geo/GeoSite.dat && \
    curl -fL ${GEODATA_BASE}/geoip.metadb     -o /geo/geoip.metadb && \
    curl -fL ${GEODATA_BASE}/GeoLite2-ASN.mmdb -o /geo/ASN.mmdb

# =============================================================================
# Stage 3: Download MetaCubeXD static dashboard
# =============================================================================
FROM alpine:3.24 AS metacubexd-downloader

ARG METACUBEXD_VERSION=latest

RUN apk add --no-cache curl tar

RUN set -eux; \
    if [ "$METACUBEXD_VERSION" = "latest" ]; then \
      METACUBEXD_VERSION=$(curl -sI https://github.com/MetaCubeX/metacubexd/releases/latest \
        | grep -i '^location:' \
        | sed 's#.*/tag/##' \
        | tr -d '\r\n'); \
    fi; \
    URL="https://github.com/MetaCubeX/metacubexd/releases/download/${METACUBEXD_VERSION}/compressed-dist.tgz"; \
    echo "Downloading $URL"; \
    mkdir -p /tmp/metacubexd /out; \
    curl -fL "$URL" -o /tmp/metacubexd.tgz; \
    tar -xzf /tmp/metacubexd.tgz -C /tmp/metacubexd; \
    if [ -d /tmp/metacubexd/dist ]; then \
      cp -a /tmp/metacubexd/dist/. /out/; \
    else \
      cp -a /tmp/metacubexd/. /out/; \
    fi; \
    test -f /out/index.html

# =============================================================================
# Stage 4: Build Web UI executable
# =============================================================================
FROM oven/bun:1-alpine AS webui-builder

ARG TARGETARCH

WORKDIR /app

COPY webui/package.json webui/bun.lock ./
RUN bun install --production --frozen-lockfile
COPY webui/src ./src
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) WEBUI_TARGET="bun-linux-x64-baseline-musl" ;; \
      arm64) WEBUI_TARGET="bun-linux-arm64-musl" ;; \
      *) echo "Unsupported Web UI target arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    bun build --compile --target "$WEBUI_TARGET" --minify ./src/server.ts --outfile /usr/local/bin/mihomo-webui

# =============================================================================
# Stage 5: Runtime image
# =============================================================================
FROM alpine:3.24

RUN apk add --no-cache \
      ca-certificates \
      libstdc++ \
      iproute2 \
      nftables \
      curl \
      bind-tools \
      tcpdump \
      tzdata \
      openrc \
      dnsmasq

WORKDIR /etc/mihomo

COPY --from=mihomo-downloader /usr/local/bin/mihomo /usr/local/bin/mihomo
COPY --from=geodata-downloader /geo/ /etc/mihomo/
COPY --from=metacubexd-downloader /out/ /usr/share/metacubexd/
COPY --from=webui-builder /usr/local/bin/mihomo-webui /usr/local/bin/mihomo-webui

COPY nftables.nft      /etc/nftables.nft
COPY mihomo.initd      /etc/init.d/mihomo
COPY dnsmasq.initd     /etc/init.d/dnsmasq
COPY webui.initd       /etc/init.d/webui
COPY entrypoint.sh     /entrypoint.sh

RUN chmod +x /usr/local/bin/mihomo /usr/local/bin/mihomo-webui /entrypoint.sh \
      /etc/init.d/mihomo /etc/init.d/dnsmasq /etc/init.d/webui

ENTRYPOINT ["/entrypoint.sh"]
