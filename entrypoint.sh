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

# Clean up stale state from unclean host shutdown.
# Docker preserves the writable layer across restarts, so PID files,
# OpenRC state, and cache.db from a previous run may persist.
# Stale PID files confuse OpenRC, and a corrupted cache.db (BoltDB)
# causes mihomo to panic on startup.
rm -f /run/mihomo.pid /run/dnsmasq.pid
rm -f /etc/mihomo/cache.db

# Reset crashed services to "stopped" so rc-service start works.
# OpenRC exit codes: 0=started, 3=stopped, 32=crashed, 4=stopping, 8=starting
# Note: must use `|| rc=$?` pattern because `set -e` would abort the
# script on any non-zero exit from `rc-service status`.
for svc in mihomo dnsmasq; do
    rc=0
    rc-service "$svc" status >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 32 ]; then
        echo "Resetting crashed service: $svc"
        rc-service "$svc" zap >/dev/null 2>&1 || true
    fi
done

# Start dnsmasq first (always-on DNS on :53, forwards to mihomo)
# When mihomo is down, dnsmasq falls back to FALLBACK_DNS_1 / FALLBACK_DNS_2
rc-service dnsmasq start

# Start mihomo as a supervised OpenRC service.
# supervise-daemon will auto-restart on crash with a 5s delay.
# --respawn-max 0 (set in mihomo.initd) means unlimited retries.
# During the restart gap, TUN is destroyed by the kernel and traffic
# falls back to direct routing via ip_forward + nftables masquerade.
# DNS is handled by dnsmasq fallback upstream.
rc-service mihomo start

# Forward container signals to the services
# Use || true so a failed stop doesn't prevent the next service from stopping
trap 'rc-service mihomo stop || true; rc-service dnsmasq stop || true; exit 0' INT TERM

# Background watchdog: if supervise-daemon somehow exits (e.g. mihomo
# crashes faster than the respawn period can reset the counter), detect
# the "crashed" state, clear corrupted cache.db, and restart the service.
# Only acts on "crashed" (rc=32), not "stopped" (rc=3) from manual stop.
# set +e so the watchdog never dies on a failed rc-service call.
(
    set +e
    while true; do
        sleep 30
        rc=0
        rc-service mihomo status >/dev/null 2>&1 || rc=$?
        if [ "$rc" -eq 32 ]; then
            echo "[$(date '+%Y-%m-%dT%H:%M:%S')] mihomo crashed, clearing cache and restarting..." >&2
            rm -f /etc/mihomo/cache.db /run/mihomo.pid
            rc-service mihomo zap >/dev/null 2>&1 || true
            rc-service mihomo start || true
        fi
    done
) &

# Tail mihomo log to stdout so docker logs always works, even after restarts
tail -f /var/log/mihomo/mihomo.log
