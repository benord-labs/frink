#!/bin/sh
# Serves Metro over Tailscale HTTPS so Frink Dev loads code from anywhere on your tailnet.
set -eu
port=${FRINK_DEV_PORT:-8444}
metro=http://127.0.0.1:8081
host=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')
# `tailscale serve` silently replaces an existing route on the same port, so never take one another app owns.
current=$(tailscale serve status --json | ROUTE="$host:$port" node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s||"{}").Web?.[process.env.ROUTE]?.Handlers?.["/"]?.Proxy??""))')
if [ -n "$current" ] && [ "$current" != "$metro" ]; then
  echo "Tailscale port $port already serves $current. Pick a free port: FRINK_DEV_PORT=<port> bun run dev:tailnet" >&2
  exit 1
fi
tailscale serve --bg --https="$port" "$metro" >/dev/null
echo "Frink Dev will load code from https://$host:$port"
EXPO_PACKAGER_PROXY_URL="https://$host:$port" exec bunx expo start --dev-client
