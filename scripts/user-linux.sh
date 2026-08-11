#!/usr/bin/env bash
# ============================================================================
# DHM AGENT - Linux auto-install (Debian/Ubuntu/Fedora/Arch/RPi)
#
# Installs the DHM agent on this machine, registers the device with the
# DHM server and enables autostart (systemd user unit + linger, so it also
# runs after reboot without login).
#
# Fully self-contained on the LAN (local tarball / :9999). When no local
# copy exists - e.g. when run via the one-liner from the README - it
# downloads the agent from GitHub Releases automatically.
#
# Where the agent code comes from (first match wins):
#   1. INSTALL_DIR already contains index.js   -> used as-is
#   2. dhm-agent.tar.gz next to this script    -> extracted
#   3. dhm-bundle.tar.gz next to this script   -> agent/ extracted from it
#   4. LAN file server  (:9999)                -> downloaded (internal net)
#   5. GitHub Releases (dhm-agent.tar.gz)      -> downloaded
# After the install the script cleans up (removes downloaded tarball).
#
# Variables:
#   SERVER_URL      DHM server (empty = auto-detect local IP, then ask)
#   SERVE_URL       LAN file server (default: http://192.168.0.10:9999)
#   DEVICE_NAME     dashboard name (default: hostname)
#   DEVICE_TYPE     server|desktop|laptop (default: desktop)
#   REPORT_INTERVAL report interval in seconds (default: 60, phone: 300)
#   REGISTER_TOKEN  registration token (or dhm-token.txt next to this
#                   script, or interactive prompt)
#   INSTALL_DIR     install dir (default: $HOME/dhm-agent)
#   GITHUB_URL      agent tarball on GitHub Releases (fallback download)
#
# Example:
#   ./user-linux.sh
#   REGISTER_TOKEN=... SERVER_URL=http://192.168.0.10:4000 DEVICE_NAME=Laptop ./user-linux.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_URL="${SERVER_URL:-}"
SERVE_URL="${SERVE_URL:-http://192.168.0.10:9999}"
GITHUB_URL="${GITHUB_URL:-https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/dhm-agent.tar.gz}"
DEVICE_NAME="${DEVICE_NAME:-$(hostname)}"
DEVICE_TYPE="${DEVICE_TYPE:-desktop}"
REGISTER_TOKEN="${REGISTER_TOKEN:-}"
REPORT_INTERVAL="${REPORT_INTERVAL:-}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/dhm-agent}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- registration token: env -> dhm-token.txt (LAN) -> prompt ----
if [ -z "$REGISTER_TOKEN" ] && [ -f "$SCRIPT_DIR/dhm-token.txt" ]; then
    REGISTER_TOKEN="$(tr -d '\r\n' < "$SCRIPT_DIR/dhm-token.txt")"
fi
if [ -z "$REGISTER_TOKEN" ]; then
    printf 'Registration token (REGISTER_TOKEN from server/.env): '
    read -r REGISTER_TOKEN || true
fi

# ---- report interval (seconds): env -> prompt (default 60, phone 300) ----
if [ -z "$REPORT_INTERVAL" ]; then
    DEFAULT_INTERVAL=60
    if [ "$DEVICE_TYPE" = "phone" ] || [ "$DEVICE_TYPE" = "android" ]; then
        DEFAULT_INTERVAL=300
    fi
    printf 'How often should the agent report? (seconds) [%s]: ' "$DEFAULT_INTERVAL"
    read -r REPORT_INTERVAL || true
    REPORT_INTERVAL="${REPORT_INTERVAL:-$DEFAULT_INTERVAL}"
fi
if ! echo "$REPORT_INTERVAL" | grep -qE '^[0-9]{1,5}$' || [ "$REPORT_INTERVAL" -lt 10 ]; then
    warn "Invalid REPORT_INTERVAL - using default (60s)."
    REPORT_INTERVAL=60
fi
ok "Report interval: ${REPORT_INTERVAL}s"

# ---- server address (auto-detect local IP, otherwise ask) ----
get_local_ip() {
    local ip
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
    [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -z "$ip" ] && ip=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)
    [ -z "$ip" ] && ip=$(ifconfig 2>/dev/null | awk '/inet / && $2!="127.0.0.1"{print $2; exit}')
    echo "$ip"
}

dhm_probe() {
    curl -fsS -m 3 "http://$1:${2:-4000}/api/devices" -o /dev/null 2>/dev/null
}

if [ -z "$SERVER_URL" ]; then
    DEFAULT_IP="$(get_local_ip)"
    DEFAULT_URL="http://${DEFAULT_IP:-localhost}:4000"
    if [ -n "$DEFAULT_IP" ] && dhm_probe "$DEFAULT_IP" 4000; then
        SERVER_URL="http://$DEFAULT_IP:4000"
        ok "Detected DHM server at: $SERVER_URL"
    else
        [ -n "$DEFAULT_IP" ] && echo "No DHM server detected at $DEFAULT_IP."
        ans=""
        read -r -p "DHM server address (http://IP:4000) [$DEFAULT_URL]: " ans || true
        SERVER_URL="${ans:-$DEFAULT_URL}"
    fi
fi

echo
echo "=== DHM Agent install (Linux) ==="
echo "Server:    $SERVER_URL"
echo "Device:    $DEVICE_NAME  ($DEVICE_TYPE)"
echo

# ---- Node.js + curl ----
if ! command -v curl >/dev/null 2>&1; then
    echo "curl not found. Installing..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y && sudo apt-get install -y curl
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y curl
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm curl
    fi
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Node.js not found. Installing..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y && sudo apt-get install -y nodejs npm
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y nodejs npm
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm nodejs npm
    else
        fail "Unknown package manager - install Node.js >= 18 manually (https://nodejs.org)."
    fi
fi
command -v node >/dev/null 2>&1 || fail "node not found after install"
command -v npm  >/dev/null 2>&1 || fail "npm not found after install"
command -v curl >/dev/null 2>&1 || fail "curl not found after install"
ok "Node.js $(node --version)"

# ---- get the agent code (offline on LAN, GitHub Releases as fallback) ----
# Priority: 1) existing install, 2) dhm-agent.tar.gz next to script,
#           3) dhm-bundle.tar.gz next to script, 4) LAN server :9999,
#           5) GitHub Releases.
if [ -f "$INSTALL_DIR/index.js" ]; then
    warn "Agent files already present in $INSTALL_DIR - using them (no download)."
else
    mkdir -p "$INSTALL_DIR"
    TMP_AGENT="$(mktemp)"
    CLEANUP_AGENT=0
    if [ -f "$SCRIPT_DIR/dhm-agent.tar.gz" ]; then
        warn "Extracting agent from $SCRIPT_DIR/dhm-agent.tar.gz ..."
        tar xzf "$SCRIPT_DIR/dhm-agent.tar.gz" -C "$INSTALL_DIR" 2>/dev/null \
            || fail "Could not extract dhm-agent.tar.gz."
    elif [ -f "$SCRIPT_DIR/dhm-bundle.tar.gz" ]; then
        warn "Extracting agent/ from $SCRIPT_DIR/dhm-bundle.tar.gz ..."
        rm -rf "$INSTALL_DIR"
        mkdir -p "$INSTALL_DIR"
        TMP_BD="$(mktemp -d)"
        tar xzf "$SCRIPT_DIR/dhm-bundle.tar.gz" -C "$TMP_BD" --strip-components=1 2>/dev/null \
            || fail "Could not extract dhm-bundle.tar.gz."
        [ -d "$TMP_BD/agent" ] || fail "dhm-bundle.tar.gz has no agent/ directory."
        cp -a "$TMP_BD/agent/." "$INSTALL_DIR/"
        rm -rf "$TMP_BD"
    elif curl -fsSL --max-time 10 "$SERVE_URL/dhm-agent.tar.gz" -o "$TMP_AGENT" 2>/dev/null; then
        warn "Downloading agent from $SERVE_URL ..."
        tar xzf "$TMP_AGENT" -C "$INSTALL_DIR" 2>/dev/null \
            || fail "Could not extract the downloaded agent tarball."
        CLEANUP_AGENT=1
    elif curl -fsSL --max-time 120 "$GITHUB_URL" -o "$TMP_AGENT" 2>/dev/null; then
        warn "Downloading agent from GitHub Releases ..."
        tar xzf "$TMP_AGENT" -C "$INSTALL_DIR" 2>/dev/null \
            || fail "Could not extract the downloaded agent tarball."
        CLEANUP_AGENT=1
    else
        fail "No agent code found. Put dhm-agent.tar.gz (or dhm-bundle.tar.gz) next to
   this script, make the LAN server :9999 reachable, or let the script
   download it from GitHub Releases (needs internet)."
    fi
    rm -f "$TMP_AGENT"
    if [ "$CLEANUP_AGENT" = "1" ]; then
        warn "Cleaning up downloaded tarball."
    fi
fi
rm -f "$INSTALL_DIR/.api_key"
[ -f "$INSTALL_DIR/index.js" ] || fail "Agent files missing in $INSTALL_DIR"
ok "Agent ready"

# ---- dependencies ----
cd "$INSTALL_DIR"
npm install --omit=dev || fail "npm install failed."
ok "Dependencies installed"

# ---- register + first run ----
echo "Registering with the server..."
SERVER_URL="$SERVER_URL" \
DEVICE_NAME="$DEVICE_NAME" \
DEVICE_TYPE="$DEVICE_TYPE" \
REPORT_INTERVAL="$REPORT_INTERVAL" \
REGISTER_TOKEN="$REGISTER_TOKEN" \
node index.js >/tmp/dhm-agent-register.log 2>&1 &
AGENT_PID=$!
sleep 12
kill "$AGENT_PID" 2>/dev/null || true
if [ ! -f "$INSTALL_DIR/.api_key" ]; then
    echo "[ERROR] Registration failed. Log:"
    cat /tmp/dhm-agent-register.log
    fail "Check REGISTER_TOKEN and whether the server is reachable."
fi
ok "Registered"

# ---- autostart: systemd user unit + linger ----
if [ -d /run/systemd/system ] || [ -d /etc/systemd ]; then
    mkdir -p "$HOME/.config/systemd/user"
    NODE_BIN="$(command -v node)"
    cat > "$HOME/.config/systemd/user/dhm-agent.service" <<EOF
[Unit]
Description=DHM Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN index.js
Restart=always
RestartSec=10
Environment=SERVER_URL=$SERVER_URL
Environment=DEVICE_NAME=$DEVICE_NAME
Environment=DEVICE_TYPE=$DEVICE_TYPE
Environment=REPORT_INTERVAL=$REPORT_INTERVAL

[Install]
WantedBy=default.target
EOF
    if systemctl --user daemon-reload 2>/dev/null && systemctl --user enable --now dhm-agent 2>/dev/null; then
        if ! loginctl enable-linger "$USER" 2>/dev/null; then
            sudo loginctl enable-linger "$USER" 2>/dev/null \
                || warn "Could not enable linger - the agent will start only after login."
        fi
        ok "Autostart configured (systemd user service + linger)"
    else
        warn "systemctl --user unavailable here (no login session?) - starting the agent directly."
        nohup "$NODE_BIN" index.js >/tmp/dhm-agent.log 2>&1 &
        echo "To enable boot autostart later, add a user systemd service (see README.md)."
    fi
else
    warn "No systemd detected - add a manual autostart entry (see README.md)."
fi

echo
echo "=== DONE ==="
echo "Server:    $SERVER_URL"
echo "Device:    $DEVICE_NAME  ($DEVICE_TYPE)"
echo "Reports:   every ${REPORT_INTERVAL}s"
echo "Logs:      journalctl --user -u dhm-agent -f"
echo "Dashboard: $SERVER_URL  (the device shows up on its own in ~1 min)"
