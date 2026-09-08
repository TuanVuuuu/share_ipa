#!/usr/bin/env bash
# Restart Share-IPA: cloudflared tunnel + node server + Caddy
set -euo pipefail

APP_DIR="/Users/sds/dev/share_ipa"
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "❌ Thiếu file .env trong $APP_DIR"
  echo "   Thêm dòng: CLOUDFLARED_TOKEN=..."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${CLOUDFLARED_TOKEN:-}" ]]; then
  echo "❌ Thiếu CLOUDFLARED_TOKEN trong .env"
  exit 1
fi

mkdir -p logs
PID_DIR="$APP_DIR/logs"

echo "==> Dừng process cũ..."
if [[ -f "$PID_DIR/cloudflared.pid" ]]; then
  kill "$(cat "$PID_DIR/cloudflared.pid")" 2>/dev/null || true
  rm -f "$PID_DIR/cloudflared.pid"
fi
if [[ -f "$PID_DIR/server.pid" ]]; then
  kill "$(cat "$PID_DIR/server.pid")" 2>/dev/null || true
  rm -f "$PID_DIR/server.pid"
fi

pkill -f "cloudflared tunnel run --token" 2>/dev/null || true
pkill -9 -f "node server.js" 2>/dev/null || true

# Giải phóng cổng 3000/3080 nếu còn process chiếm
for port in 3000 3080; do
  pids="$(lsof -t -nP -iTCP:$port -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "   Kill process đang giữ :$port -> $pids"
    kill -9 $pids 2>/dev/null || true
  fi
done

sudo caddy stop 2>/dev/null || true
sleep 1

echo "==> Chạy cloudflared tunnel..."
nohup cloudflared tunnel run --token "$CLOUDFLARED_TOKEN" \
  > "$PID_DIR/cloudflared.log" 2>&1 &
echo $! > "$PID_DIR/cloudflared.pid"

echo "==> npm install..."
npm install

echo "==> Chạy node server.js..."
nohup node server.js > "$PID_DIR/server.log" 2>&1 &
echo $! > "$PID_DIR/server.pid"

echo "==> Chờ API sẵn sàng..."
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf --noproxy '*' "http://127.0.0.1:3000/api/lan-info" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

echo "==> Caddy validate + start..."
sudo caddy validate --config ./Caddyfile
sudo caddy start --config ./Caddyfile

echo ""
echo "✅ Share-IPA đã restart."
echo "   cloudflared pid: $(cat "$PID_DIR/cloudflared.pid")"
echo "   server      pid: $(cat "$PID_DIR/server.pid")"
echo "   logs: $PID_DIR/cloudflared.log , $PID_DIR/server.log"
if [[ "$ready" -eq 1 ]]; then
  echo "   LAN API: OK"
  curl -s --noproxy '*' "http://127.0.0.1:3000/api/lan-info"; echo
else
  echo "   LAN API: CHƯA OK — xem logs/server.log"
  tail -n 30 "$PID_DIR/server.log" || true
fi
