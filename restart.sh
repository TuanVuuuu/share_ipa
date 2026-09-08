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
PORT_NUM="${PORT:-3081}"

free_port() {
  local port="$1"
  local attempt pids
  for attempt in 1 2 3 4 5 6 7 8; do
    pids="$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -z "${pids}" ]]; then
      pids="$(sudo lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    fi
    if [[ -z "${pids}" ]]; then
      return 0
    fi
    echo "   [:$port] đang bị chiếm bởi PID: $pids (lần $attempt) — kill -9"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    # shellcheck disable=SC2086
    sudo kill -9 $pids 2>/dev/null || true
    sleep 0.6
  done
  echo "❌ Không giải phóng được cổng $port. Process còn giữ:"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  sudo lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  netstat -anv 2>/dev/null | grep -E "\.${port} .*LISTEN" || true
  return 1
}

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
pkill -9 -f "/Users/sds/dev/share_ipa/server.js" 2>/dev/null || true

sudo caddy stop 2>/dev/null || true
sleep 1

echo "==> Giải phóng cổng $PORT_NUM và 3080..."
free_port "$PORT_NUM"
free_port 3080

echo "==> Chạy cloudflared tunnel..."
nohup cloudflared tunnel run --token "$CLOUDFLARED_TOKEN" \
  > "$PID_DIR/cloudflared.log" 2>&1 &
echo $! > "$PID_DIR/cloudflared.pid"

echo "==> npm install..."
npm install

# Đảm bảo cổng vẫn trống sau npm (phòng process tự respawn)
free_port "$PORT_NUM"

echo "==> Chạy node server.js..."
nohup node server.js > "$PID_DIR/server.log" 2>&1 &
echo $! > "$PID_DIR/server.pid"
sleep 0.8

if ! kill -0 "$(cat "$PID_DIR/server.pid")" 2>/dev/null; then
  echo "❌ node server.js đã thoát ngay sau khi start:"
  tail -n 40 "$PID_DIR/server.log" || true
  echo ""
  echo "   Ai đang giữ :$PORT_NUM?"
  lsof -nP -iTCP:"$PORT_NUM" -sTCP:LISTEN || echo "   (lsof không thấy process)"
  exit 1
fi

echo "==> Chờ API sẵn sàng..."
ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -sf --noproxy '*' "http://127.0.0.1:${PORT_NUM}/api/lan-info" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$(cat "$PID_DIR/server.pid")" 2>/dev/null; then
    echo "❌ server chết trong lúc chờ API:"
    tail -n 40 "$PID_DIR/server.log" || true
    exit 1
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
  curl -s --noproxy '*' "http://127.0.0.1:${PORT_NUM}/api/lan-info"; echo
else
  echo "   LAN API: CHƯA OK — xem logs/server.log"
  tail -n 40 "$PID_DIR/server.log" || true
  lsof -nP -iTCP:"$PORT_NUM" -sTCP:LISTEN || true
  exit 1
fi
