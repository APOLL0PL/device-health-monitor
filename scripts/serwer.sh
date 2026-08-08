#!/usr/bin/env bash
# ============================================================================
# DHM SERVER - auto-setup (Debian/Ubuntu/Fedora/Arch/RPi)
#
# Installs the DHM server + dashboard, starts it under pm2 and enables
# autostart (systemd). Also starts the LAN install-file server (:9999)
# used by the agent installers.
#
# Fully self-contained - NO GitHub, NO internet needed.
#
# Where the code comes from (first match wins):
#   1. INSTALL_DIR already contains server/index.js  -> used as-is
#   2. dhm-bundle.tar.gz next to this script          -> extracted
#   3. existing folder in INSTALL_DIR                 -> used as-is
# After a fresh install the script cleans up (removes the bundle + .git).
#
# Variables (optionally set before running):
#   INSTALL_DIR     install dir (default: $HOME/device-health-monitor)
#   BUNDLE          path to the code bundle (default: next to this script)
#   PORT            server port (default: 4000)
#   AUTH_TOKEN      dashboard write token (optional, generated if empty)
#   REGISTER_TOKEN  registration token (optional, generated if empty)
#   DHM_INSTALL_DIR dir with installer files served by dhm-serve
#                   (default: /mnt/storage/media/DHM)
#   PM2_NAME        pm2 process name of the server (default: dhm-server)
#   SERVE_PORT      LAN install-file server port (default: 9999)
#   PM2_SERVE_NAME  pm2 process name of the LAN file server (default: dhm-serve)
#
# For a SECOND instance on the same machine: give it a different INSTALL_DIR,
# PORT and PM2_NAME (e.g. INSTALL_DIR=$HOME/dhm-test PORT=4001
# PM2_NAME=dhm-server-test). dhm-serve is skipped if SERVE_PORT is already
# in use (the first instance keeps serving the install files).
#
# Example:
#   ./serwer.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/device-health-monitor}"
BUNDLE="${BUNDLE:-$SCRIPT_DIR/dhm-bundle.tar.gz}"
PORT="${PORT:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
REGISTER_TOKEN="${REGISTER_TOKEN:-}"
DHM_INSTALL_DIR="${DHM_INSTALL_DIR:-/mnt/storage/media/DHM}"
PM2_NAME="${PM2_NAME:-dhm-server}"
SERVE_PORT="${SERVE_PORT:-9999}"
PM2_SERVE_NAME="${PM2_SERVE_NAME:-dhm-serve}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Port selection + busy check ---
port_in_use() {
    local p="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${p}\$"
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${p}\$"
    else
        if node -e "const n=require('net');n.createServer().once('error',()=>process.exit(1)).listen($p,()=>process.exit(0))" 2>/dev/null; then
            return 1
        else
            return 0
        fi
    fi
}

if [ -n "$PORT" ]; then
    if ! echo "$PORT" | grep -qE '^[0-9]{1,5}$' || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
        fail "PORT=$PORT is invalid - use a number 1-65535."
    fi
    if port_in_use "$PORT"; then
        fail "Port $PORT is already in use. Pick a free one, e.g.: PORT=4001 ./serwer.sh"
    fi
else
    PORT=4000
    while true; do
        read -r -p "Which port should the DHM server listen on? [4000]: " ans
        ans="${ans:-4000}"
        if ! echo "$ans" | grep -qE '^[0-9]{1,5}$' || [ "$ans" -lt 1 ] || [ "$ans" -gt 65535 ]; then
            warn "Invalid port - use a number 1-65535."
            continue
        fi
        PORT="$ans"
        if port_in_use "$PORT"; then
            warn "Port $PORT is already IN USE - pick another one."
            continue
        fi
        break
    done
fi
ok "Chosen port: $PORT"

# --- Requirements ---
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Node.js not found. Installing..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y && sudo apt-get install -y nodejs npm build-essential python3
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y nodejs npm gcc-c++ make python3
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm nodejs npm base-devel python
    else
        fail "Unknown package manager - install Node.js >= 18 manually (https://nodejs.org)."
    fi
fi
command -v node >/dev/null 2>&1 || fail "node not found after install"
command -v npm  >/dev/null 2>&1 || fail "npm not found after install"
ok "Node.js $(node --version)"

# --- Get the code (self-contained - no GitHub, no internet) ---
# Priority: 1) existing install, 2) bundle next to script, 3) existing folder.
if [ -f "$INSTALL_DIR/server/index.js" ]; then
    warn "DHM server files already present in $INSTALL_DIR - using them."
elif [ -f "$BUNDLE" ]; then
    warn "Extracting code from $BUNDLE ..."
    mkdir -p "$INSTALL_DIR"
    tar xzf "$BUNDLE" -C "$INSTALL_DIR" --strip-components=1
    # mark that this was a fresh install -> clean up the bundle afterwards
    CLEANUP_BUNDLE=1
else
    mkdir -p "$(dirname "$INSTALL_DIR")"
    fail "No DHM server code found. Put dhm-bundle.tar.gz next to this script
   (or make $INSTALL_DIR/server/index.js exist)."
fi
[ -f "$INSTALL_DIR/server/index.js" ] || fail "DHM server files missing in $INSTALL_DIR/server (index.js not found)."

# --- Server dependencies ---
ok "Installing server dependencies..."
if ! (cd "$INSTALL_DIR/server" && npm install); then
    fail "npm install failed. On Debian/Ubuntu you may need:
       sudo apt install build-essential python3
       (better-sqlite3 requires a native build)"
fi

# --- Dashboard (dist is committed, build it if missing) ---
if [ ! -d "$INSTALL_DIR/dashboard/dist" ]; then
    warn "Dashboard build missing - building (vite)..."
    (cd "$INSTALL_DIR/dashboard" && npm install && npm run build)
fi

# --- pm2 ---
if ! command -v pm2 >/dev/null 2>&1; then
    ok "Installing pm2 (global prefix needs root)..."
    sudo env "PATH=$PATH" npm install -g pm2
fi

# --- Access tokens ---
gen_token() {
    command -v openssl >/dev/null 2>&1 && openssl rand -hex 24 || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
}
if [ -f "$INSTALL_DIR/server/.env" ] && grep -q '^AUTH_TOKEN=' "$INSTALL_DIR/server/.env"; then
    warn "server/.env exists - keeping existing tokens"
else
    AUTH_TOKEN="${AUTH_TOKEN:-$(gen_token)}"
    REGISTER_TOKEN="${REGISTER_TOKEN:-$(gen_token)}"
    cat > "$INSTALL_DIR/server/.env" <<EOF
PORT=$PORT
AUTH_TOKEN=$AUTH_TOKEN
REGISTER_TOKEN=$REGISTER_TOKEN
EOF
    ok "Generated server/.env (write + registration tokens)"
fi
mkdir -p "$INSTALL_DIR/dashboard/dist"
AUTH_TOKEN_FINAL=$(grep '^AUTH_TOKEN=' "$INSTALL_DIR/server/.env" | cut -d= -f2-)
REGISTER_TOKEN_FINAL=$(grep '^REGISTER_TOKEN=' "$INSTALL_DIR/server/.env" | cut -d= -f2-)
PORT_FINAL=$(grep '^PORT=' "$INSTALL_DIR/server/.env" | cut -d= -f2-)
cat > "$INSTALL_DIR/dashboard/dist/config.js" <<EOF
window.DHM_CONFIG = { token: "$AUTH_TOKEN_FINAL" };
EOF
ok "Dashboard config (token) generated"

# --- Start the server ---
# PORT/tokens are read from server/.env by index.js - no need to export them.
cd "$INSTALL_DIR/server"
pm2 start index.js --name "$PM2_NAME"
pm2 save
ok "Server started (pm2 name: $PM2_NAME)."

# --- LAN install-file server (:9999) ---
if [ -f "$INSTALL_DIR/server/serve-install.js" ]; then
    if port_in_use "$SERVE_PORT"; then
        warn "Port $SERVE_PORT (LAN install-file server) is already IN USE - skipping dhm-serve."
        warn "The existing instance already serves the install files on :$SERVE_PORT."
    else
        ok "Starting LAN install-file server ($PM2_SERVE_NAME :$SERVE_PORT)..."
        (cd "$INSTALL_DIR/server" && DHM_INSTALL_DIR="$DHM_INSTALL_DIR" DHM_SERVE_PORT="$SERVE_PORT" pm2 start serve-install.js --name "$PM2_SERVE_NAME")
        pm2 save
    fi
    if [ ! -d "$DHM_INSTALL_DIR" ]; then
        warn "DHM_INSTALL_DIR ($DHM_INSTALL_DIR) does not exist yet - create it and put
       dhm-agent.tar.gz, user-win.bat, user-linux.sh, dhm-token.txt in it."
    fi
else
    warn "serve-install.js missing - the LAN file server on :$SERVE_PORT was NOT started."
fi

# --- Firewall ---
if command -v ufw >/dev/null 2>&1; then
    ok "Opening ports in UFW..."
    sudo ufw allow "$PORT_FINAL"/tcp || true
    sudo ufw allow "$SERVE_PORT"/tcp || true
fi

# --- Autostart after reboot ---
if [ -d /run/systemd/system ] || [ -d /etc/systemd ]; then
    warn "Enabling systemd autostart for pm2 (may ask for sudo)..."
    sudo env "PATH=$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" \
        || warn "Autostart NOT enabled - run manually: sudo env PATH=\$PATH pm2 startup systemd -u $USER --hp $HOME"
fi

# --- Cleanup (remove things not needed to run) ---
if [ "${CLEANUP_BUNDLE:-0}" = "1" ]; then
    warn "Cleaning up - removing .git from $INSTALL_DIR ..."
    rm -rf "$INSTALL_DIR/.git" 2>/dev/null || true
    if [ -f "$BUNDLE" ]; then
        warn "Removing bundle $BUNDLE (not needed - server is installed) ..."
        rm -f "$BUNDLE" 2>/dev/null || true
    fi
else
    warn "Using existing files - keeping .git and bundle."
fi

echo
ok "=== DONE ==="
# Prefer the LAN IP (route-based), fall back to hostname -I only if unavailable
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
[ -z "$LAN_IP" ] && LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
echo "Dashboard:   http://${LAN_IP:-<server-IP>}:$PORT_FINAL"
echo "Logs:        pm2 logs $PM2_NAME"
echo
echo "Agents:      run scripts/user-win.bat (Windows) or scripts/user-linux.sh (Linux)"
echo "REGISTER_TOKEN: $REGISTER_TOKEN_FINAL"
echo "             (keep it secret - agents need it only for the first registration)"
echo
echo "Remove this instance: pm2 delete $PM2_NAME && rm -rf \"$INSTALL_DIR\" && pm2 save"
echo "             (plus: sudo ufw delete allow $PORT_FINAL/tcp)"
echo
