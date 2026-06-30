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
# Stage 3: Runtime image
# =============================================================================
FROM alpine:3.24

RUN apk add --no-cache \
      ca-certificates \
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

COPY nftables.nft      /etc/nftables.nft
COPY mihomo.initd      /etc/init.d/mihomo
COPY dnsmasq.initd     /etc/init.d/dnsmasq
COPY entrypoint.sh     /entrypoint.sh

RUN chmod +x /usr/local/bin/mihomo /entrypoint.sh \
      /etc/init.d/mihomo /etc/init.d/dnsmasq

ENTRYPOINT ["/entrypoint.sh"]
