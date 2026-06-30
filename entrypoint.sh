#!/bin/sh
set -eu

if [ ! -c /dev/net/tun ]; then
    echo "ERROR: /dev/net/tun is missing. Run container with --device /dev/net/tun or privileged mode." >&2
    exit 1
fi

if [ ! -f /etc/mihomo/config.yaml ]; then
    echo "ERROR: /etc/mihomo/config.yaml not found. Mount your config:" >&2
    echo "  -v ./config.yaml:/etc/mihomo/config.yaml" >&2
    exit 1
fi

sysctl -w net.ipv4.ip_forward=1 >/dev/null || true

if [ -f /etc/nftables.nft ]; then
    nft -f /etc/nftables.nft
fi

# Generate dnsmasq.conf from env vars
MIHOMO_DNS="${MIHOMO_DNS:-127.0.0.1#1053}"
FALLBACK_DNS_1="${FALLBACK_DNS_1:-8.8.8.8}"
FALLBACK_DNS_2="${FALLBACK_DNS_2:-1.1.1.1}"

cat > /etc/dnsmasq.conf <<EOF
port=53
no-resolv
strict-order
server=${MIHOMO_DNS}
server=${FALLBACK_DNS_1}
server=${FALLBACK_DNS_2}
cache-size=0
domain-needed
bogus-priv
EOF

# Ensure OpenRC runtime state exists (containers don't boot OpenRC)
mkdir -p /run/openrc
touch /run/openrc/softlevel

# Ensure log directory exists
mkdir -p /var/log/mihomo

# Start dnsmasq first (always-on DNS on :53, forwards to mihomo)
# When mihomo is down, dnsmasq falls back to FALLBACK_DNS_1 / FALLBACK_DNS_2
rc-service dnsmasq start

# Start mihomo as a supervised OpenRC service.
# supervise-daemon will auto-restart on crash with a 5s delay.
# During the restart gap, TUN is destroyed by the kernel and traffic
# falls back to direct routing via ip_forward + nftables masquerade.
# DNS is handled by dnsmasq fallback upstream.
rc-service mihomo start

# Forward container signals to the services
trap 'rc-service mihomo stop; rc-service dnsmasq stop; exit 0' INT TERM

# Tail mihomo log to stdout so docker logs always works, even after restarts
tail -f /var/log/mihomo/mihomo.log
