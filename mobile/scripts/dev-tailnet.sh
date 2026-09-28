#!/bin/sh
# Serves Metro over Tailscale HTTPS so Frink Dev loads code from anywhere on your tailnet.
set -eu
host=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')
tailscale serve --bg --https=8444 http://127.0.0.1:8081 >/dev/null
echo "Frink Dev will load code from https://$host:8444"
EXPO_PACKAGER_PROXY_URL="https://$host:8444" exec bunx expo start --dev-client
