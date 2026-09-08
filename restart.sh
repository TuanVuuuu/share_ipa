#!/usr/bin/env bash
# Restart Share-IPA: cloudflared tunnel + node server + Caddy
# Chỉ dừng process của Share-IPA — KHÔNG kill process lạ trên cổng (tránh đụng Jenkins).
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

kill_pidfile() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "   stop pid $pid ($file)"
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  fi
}

# Chỉ báo cáo nếu cổng bận — không kill process người khác
assert_port_free() {
  local port="$1"
  local pids
  pids="$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "❌ Cổng $port đang bị chiếm bởi PID: $pids"
    lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
    echo "   Không tự kill (an toàn cho Jenkins/dịch vụ khác)."
    echo "   Nếu chắc là Share-IPA cũ: kill đúng PID ở trên, rồi chạy lại ./restart.sh"
    return 1
  fi
  return 0
}

echo "==> Dừng process Share-IPA cũ (theo pidfile + đúng path)..."
kill_pidfile "$PID_DIR/cloudflared.pid"
kill_pidfile "$PID_DIR/server.pid"

# Chỉ dừng đúng Share-IPA — không pkill mọi "node server.js" trên máy
pkill -f "cloudflared tunnel run --token" 2>/dev/null || true
pkill -f "node ${APP_DIR}/server.js" 2>/dev/null || true
sleep 1
pkill -9 -f "node ${APP_DIR}/server.js" 2>/dev/null || true

sudo caddy stop 2>/dev/null || true
sleep 1

echo "==> Kiểm tra cổng $PORT_NUM (Node) và 3080 (Caddy LAN) — không kill process lạ..."
assert_port_free "$PORT_NUM"
assert_port_free 3080

echo "==> Chạy cloudflared tunnel..."
nohup cloudflared tunnel run --token "$CLOUDFLARED_TOKEN" \
  > "$PID_DIR/cloudflared.log" 2>&1 &
echo $! > "$PID_DIR/cloudflared.pid"

echo "==> npm install..."
npm install

assert_port_free "$PORT_NUM"

echo "==> Chạy node server.js (PORT=$PORT_NUM)..."
nohup node server.js > "$PID_DIR/server.log" 2>&1 &
echo $! > "$PID_DIR/server.pid"
sleep 0.8

if ! kill -0 "$(cat "$PID_DIR/server.pid")" 2>/dev/null; then
  echo "❌ node server.js đã thoát ngay sau khi start:"
  tail -n 40 "$PID_DIR/server.log" || true
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
echo "   node port: $PORT_NUM (Jenkins :3000 không bị đụng)"
echo "   logs: $PID_DIR/cloudflared.log , $PID_DIR/server.log"
if [[ "$ready" -eq 1 ]]; then
  echo "   LAN API: OK"
  curl -s --noproxy '*' "http://127.0.0.1:${PORT_NUM}/api/lan-info"; echo
else
  echo "   LAN API: CHƯA OK — xem logs/server.log"
  tail -n 40 "$PID_DIR/server.log" || true
  exit 1
fi
