# mihomo-gateway

[mihomo](https://github.com/MetaCubeX/mihomo) transparent proxy gateway container with fail-open routing and DNS fallback.

## Variants

| Tag suffix | Platform | CPU target |
|---|---|---|
| `amd64-v1` | linux/amd64 | x86-64 baseline (max compat) |
| `amd64-v2` | linux/amd64 | SSE4.2 |
| `amd64-v3` | linux/amd64 | AVX2 (modern, default for `latest`) |
| `arm64` | linux/arm64 | ARMv8 |

`latest` and version tags map `linux/amd64` → v3, `linux/arm64` → arm64. Pull explicit tags for older CPUs.

## Usage

```yaml
services:
  mihomo:
    image: ghcr.io/<owner>/mihomo-gateway:latest
    container_name: mihomo-gateway
    restart: unless-stopped
    privileged: true
    sysctls:
      net.ipv4.ip_forward: "1"
    volumes:
      - ./config.yaml:/etc/mihomo/config.yaml
    environment:
      MIHOMO_DNS: 127.0.0.1#1053      # mihomo DNS listen address
      FALLBACK_DNS_1: 8.8.8.8          # primary fallback (when mihomo down)
      FALLBACK_DNS_2: 1.1.1.1          # secondary fallback
    networks:
      lan:
        ipv4_address: 192.168.12.200

networks:
  lan:
    driver: macvlan
    driver_opts:
      parent: eth0
    ipam:
      config:
        - subnet: 192.168.12.0/23
          gateway: 192.168.12.254
```

Requires `privileged: true` or (`NET_ADMIN` + `NET_RAW` + `/dev/net/tun`).

**Config is required** — mount your mihomo config at `/etc/mihomo/config.yaml`. The container will fail to start without it. See `config-dummy.yaml` in the repo as a reference template.

### Environment variables

| Env | Default | Description |
|---|---|---|
| `MIHOMO_DNS` | `127.0.0.1#1053` | Where dnsmasq forwards DNS for mihomo (must match `dns.listen` in your mihomo config) |
| `FALLBACK_DNS_1` | `8.8.8.8` | Primary fallback DNS when mihomo is down |
| `FALLBACK_DNS_2` | `1.1.1.1` | Secondary fallback DNS when mihomo is down |

### mihomo config requirements

Your mounted `config.yaml` must have:
- `dns.listen: 127.0.0.1:1053` (must match `MIHOMO_DNS` env, default `127.0.0.1#1053`)
- `tun.enable: true` with `auto-route: true`

Geo databases (`GeoSite.dat`, `geoip.metadb`, `ASN.mmdb`) are pre-baked into the image.

## Build

```sh
# All variants
./scripts/build-local.sh

# Single variant
docker buildx build --load --platform linux/amd64 \
  --build-arg MIHOMO_VARIANT=v3 --tag mihomo-gateway:amd64-v3 .
```

| Build arg | Default | Options |
|---|---|---|
| `MIHOMO_VERSION` | `latest` | `latest` or `v1.19.27` |
| `MIHOMO_VARIANT` | *(empty)* | `v1`/`v2`/`v3` for amd64; empty for arm64 |

Pushes to `main` trigger CI (`.github/workflows/build.yml`) → GHCR.

## Files

```
├── Dockerfile              # Multi-stage: fetch binary + geo DBs, runtime
├── entrypoint.sh           # TUN check, generate dnsmasq.conf, start services
├── nftables.nft            # NAT masquerade rules
├── mihomo.initd            # OpenRC service (supervised, auto-restart)
├── dnsmasq.initd           # OpenRC service (always-on)
├── docker-compose.example.yaml  # macvlan examples (new + existing network)
├── .github/workflows/build.yml
└── scripts/build-local.sh
```
