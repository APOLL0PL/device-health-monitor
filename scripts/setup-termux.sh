#!/data/data/com.termux/files/usr/bin/sh
# ============================================================================
# Device Health Monitor — AGENT auto-setup on a PHONE (Termux)
#
# Downloads the agent, installs dependencies, registers with the server,
# starts the agent and configures autostart via Termux:Boot.
#
# Usage (on the phone, after opening Termux):
#   pkg install -y curl
#   curl -fsSL https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/setup-termux.sh -o /tmp/setup-dhm.sh
#   REGISTER_TOKEN=<server-token> SERVER_URL=http://<server-IP>:4000 DEVICE_NAME="Phone" sh /tmp/setup-dhm.sh
#
# Variables:
#   SERVER_URL      DHM server address (empty = probe own IP + gateway, then ask)
#   GITHUB_URL      agent tarball on GitHub Releases
#   DEVICE_NAME     name on the dashboard (default: phone model)
#   REPORT_INTERVAL report interval in seconds (default: 300 = 5 min)
#   REGISTER_TOKEN  registration token from the server/server/.env
# ============================================================================
set -e

SERVER_URL="${SERVER_URL:-}"
GITHUB_URL="${GITHUB_URL:-https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/dhm-agent.tar.gz}"
DEVICE_NAME="${DEVICE_NAME:-$(getprop ro.product.model 2>/dev/null || echo 'Phone')}"
DEVICE_TYPE=phone
REPORT_INTERVAL="${REPORT_INTERVAL:-}"
REGISTER_TOKEN="${REGISTER_TOKEN:-}"

INSTALL_DIR="$HOME/dhm-agent"
AGENT_TAR="$HOME/dhm-agent.tar.gz"

# --- Registration token: env -> prompt (or abort) ---
if [ -z "$REGISTER_TOKEN" ]; then
  printf "Registration token (REGISTER_TOKEN from server/.env): "
  read -r REGISTER_TOKEN || true
fi
if [ -z "$REGISTER_TOKEN" ]; then
  echo "[ERROR] No registration token - get it from server/.env on the DHM server."
  exit 1
fi

# --- Detect the phone's local IP (if `ip` is available) ---
detect_ip() {
  command -v ip >/dev/null 2>&1 && ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1
}

# --- Detect the gateway (default route) IP ---
detect_gateway() {
  command -v ip >/dev/null 2>&1 && ip -4 route show default 2>/dev/null | awk '/via /{print $3; exit}'
}

# --- Probe whether a DHM server responds at ip:port ---
dhm_probe() {
  curl -fsS -m 3 "http://$1:${2:-4000}/api/devices" -o /dev/null 2>/dev/null
}

# --- Server address (probe own IP + gateway, otherwise ask) ---
if [ -z "$SERVER_URL" ]; then
  LOCAL_IP="$(detect_ip)"
  GATEWAY_IP="$(detect_gateway)"
  for cand in "$LOCAL_IP" "$GATEWAY_IP"; do
    if [ -n "$cand" ] && dhm_probe "$cand" 4000; then
      SERVER_URL="http://$cand:4000"
      echo "Detected DHM server at: $SERVER_URL"
      break
    fi
  done
fi
if [ -z "$SERVER_URL" ]; then
  DEFAULT_IP="${GATEWAY_IP:-$LOCAL_IP}"
  echo "Could not auto-detect the DHM server (probed your phone IP and the gateway)."
  echo "You can pass it explicitly: REGISTER_TOKEN=... SERVER_URL=http://<server-IP>:4000 sh /tmp/setup-dhm.sh"
  if [ -n "$DEFAULT_IP" ]; then
    printf "DHM server address (http://IP:4000) [http://%s:4000]: " "$DEFAULT_IP"
    read -r ANS || true
    SERVER_URL="${ANS:-http://$DEFAULT_IP:4000}"
  else
    printf "DHM server address (http://IP:4000): "
    read -r ANS || true
    SERVER_URL="${ANS:-http://192.168.0.10:4000}"
  fi
fi

echo "=== DHM Agent — Termux ==="
echo "Server:     $SERVER_URL"
echo "Device:     $DEVICE_NAME (phone)"

# --- Report interval (seconds): env -> prompt (default 300 = 5 min) ---
if [ -z "$REPORT_INTERVAL" ]; then
  printf "How often should the agent report? (seconds) [300]: "
  read -r ANS
  REPORT_INTERVAL="${ANS:-300}"
fi
case "$REPORT_INTERVAL" in
  ''|*[!0-9]*) echo "Invalid REPORT_INTERVAL - using 300."; REPORT_INTERVAL=300 ;;
esac
echo "Reports:    every ${REPORT_INTERVAL}s"

# --- Dependencies ---
command -v curl >/dev/null 2>&1 || pkg install -y curl
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Installing nodejs-lts..."
  pkg install -y nodejs-lts
fi

# --- Download the agent (GitHub Releases) ---
mkdir -p "$INSTALL_DIR"
echo "Downloading the agent..."
if ! curl -fsSL --max-time 120 "$GITHUB_URL" -o "$AGENT_TAR" 2>/dev/null; then
  echo "Could not download the agent from $GITHUB_URL"
  echo "Check the internet connection / GITHUB_URL."
  exit 1
fi
tar xzf "$AGENT_TAR" -C "$INSTALL_DIR"
rm -f "$AGENT_TAR"

# --- Agent dependencies ---
cd "$INSTALL_DIR"
echo "Installing dependencies (npm install)..."
npm install --omit=dev

# --- First registration ---
echo "Registering with the server..."
SERVER_URL="$SERVER_URL" DEVICE_TYPE="$DEVICE_TYPE" DEVICE_NAME="$DEVICE_NAME" REPORT_INTERVAL="$REPORT_INTERVAL" REGISTER_TOKEN="$REGISTER_TOKEN" node index.js >/tmp/dhm-agent.log 2>&1 &
AGENT_PID=$!
sleep 12
kill "$AGENT_PID" 2>/dev/null || true
if [ -f "$INSTALL_DIR/.api_key" ]; then
  echo "[OK] Registered"
else
  echo "[ERROR] No key — check the log:"
  cat /tmp/dhm-agent.log
  exit 1
fi

# --- Autostart (Termux:Boot) ---
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/dhm-agent.sh" <<SH
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd $HOME/dhm-agent
DEVICE_TYPE=phone SERVER_URL="$SERVER_URL" REPORT_INTERVAL="$REPORT_INTERVAL" node index.js &
SH
chmod +x "$HOME/.termux/boot/dhm-agent.sh"

# --- Start now ---
nohup sh "$HOME/.termux/boot/dhm-agent.sh" >/dev/null 2>&1 &
sleep 3

echo
echo "=== DONE ==="
echo "Agent running (reports every ${REPORT_INTERVAL}s). Dashboard: $SERVER_URL"
echo "Install 'Termux:Boot' from F-Droid and open it once — autostart after reboot."
