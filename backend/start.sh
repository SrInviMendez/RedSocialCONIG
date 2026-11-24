#!/bin/sh
set -eu

: "${TS_AUTHKEY:?Falta configurar TS_AUTHKEY}"
: "${REGION:?Falta configurar REGION}"

TS_SOCKET="/tmp/tailscaled.sock"

rm -f "$TS_SOCKET"

echo "Iniciando Tailscale en modo userspace..."

tailscaled \
  --tun=userspace-networking \
  --state=mem: \
  --socket="$TS_SOCKET" \
  --socks5-server=127.0.0.1:1055 &

TS_PID=$!

i=0
while [ ! -S "$TS_SOCKET" ]; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "ERROR: Tailscale no inició."
    kill "$TS_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

tailscale --socket="$TS_SOCKET" up \
  --auth-key="$TS_AUTHKEY" \
  --hostname="${TS_HOSTNAME:-red-social-${REGION}}" \
  --accept-dns=false \
  --accept-routes=false

echo "Tailscale conectado:"
tailscale --socket="$TS_SOCKET" status

echo "Iniciando backend de ${REGION}..."

exec node server.js