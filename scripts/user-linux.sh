#!/usr/bin/env bash
# Instalacja agenta DHM (Debian/Ubuntu/Fedora/Arch/RPi).
# Ściąga agenta z GitHub Releases, rejestruje urządzenie i włącza
# autostart (systemd user unit + linger). Nic nie usuwa.
#
# Zmienne: SERVER_URL, DEVICE_NAME, DEVICE_TYPE, REPORT_INTERVAL,
#          REGISTER_TOKEN, INSTALL_DIR, GITHUB_URL
# Przykład: REGISTER_TOKEN=... SERVER_URL=http://<server-IP>:4000 DEVICE_NAME=Laptop ./user-linux.sh
set -euo pipefail

SERVER_URL="${SERVER_URL:-}"
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

# ---- NIE uruchamiać jako root: agent używa usługi systemd USER ----
if [ "$(id -u)" -eq 0 ]; then
    fail "Nie uruchamiaj instalatora jako root - agent używa usługi systemd user.
   Uruchom jako zwykły użytkownik (sudo niepotrzebne)."
fi

# ---- token rejestracji: env -> prompt ----
if [ -z "$REGISTER_TOKEN" ]; then
    printf 'Token rejestracji (REGISTER_TOKEN z server/.env): '
    read -r REGISTER_TOKEN || true
fi

# ---- interwał raportowania (s): env -> prompt (domyślnie 60, telefon 300) ----
if [ -z "$REPORT_INTERVAL" ]; then
    DEFAULT_INTERVAL=60
    if [ "$DEVICE_TYPE" = "phone" ] || [ "$DEVICE_TYPE" = "android" ]; then
        DEFAULT_INTERVAL=300
    fi
    printf 'Jak często agent ma raportować? (sekundy) [%s]: ' "$DEFAULT_INTERVAL"
    read -r REPORT_INTERVAL || true
    REPORT_INTERVAL="${REPORT_INTERVAL:-$DEFAULT_INTERVAL}"
fi
if ! echo "$REPORT_INTERVAL" | grep -qE '^[0-9]{1,5}$' || [ "$REPORT_INTERVAL" -lt 10 ]; then
    warn "Nieprawidłowy REPORT_INTERVAL - ustawiam domyślny (60s)."
    REPORT_INTERVAL=60
fi
ok "Interwał raportowania: ${REPORT_INTERVAL}s"

# ---- adres serwera (probe własne IP + bramy, inaczej pytaj) ----
get_local_ip() {
    local ip
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
    [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -z "$ip" ] && ip=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)
    [ -z "$ip" ] && ip=$(ifconfig 2>/dev/null | awk '/inet / && $2!="127.0.0.1"{print $2; exit}')
    echo "$ip"
}

get_gateway_ip() {
    ip -4 route show default 2>/dev/null | awk '/via /{print $3; exit}'
}

dhm_probe() {
    curl -fsS -m 3 "http://$1:${2:-4000}/api/devices" -o /dev/null 2>/dev/null
}

if [ -z "$SERVER_URL" ]; then
    LOCAL_IP="$(get_local_ip)"
    GATEWAY_IP="$(get_gateway_ip)"
    for cand in "$LOCAL_IP" "$GATEWAY_IP"; do
        if [ -n "$cand" ] && dhm_probe "$cand" 4000; then
            SERVER_URL="http://$cand:4000"
            ok "Wykryto serwer DHM: $SERVER_URL"
            break
        fi
    done
    if [ -z "$SERVER_URL" ]; then
        DEFAULT_IP="${GATEWAY_IP:-$LOCAL_IP}"
        [ -z "$DEFAULT_IP" ] && DEFAULT_IP=localhost
        DEFAULT_URL="http://${DEFAULT_IP}:4000"
        warn "Nie wykryto serwera DHM (sprawdzono własne IP i bramę)."
        printf 'Adres serwera DHM (http://IP:4000) [%s]: ' "$DEFAULT_URL"
        read -r ans || true
        SERVER_URL="${ans:-$DEFAULT_URL}"
    fi
fi

echo
echo "=== Instalacja agenta DHM (Linux) ==="
echo "Serwer:    $SERVER_URL"
echo "Urządzenie: $DEVICE_NAME  ($DEVICE_TYPE)"
echo

# ---- Node.js + curl ----
if ! command -v curl >/dev/null 2>&1; then
    echo "Brak curl. Instaluję..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y && sudo apt-get install -y curl
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y curl
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm curl
    fi
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Brak Node.js. Instaluję..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y && sudo apt-get install -y nodejs npm
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y nodejs npm
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm nodejs npm
    else
        fail "Nieznany menedżer pakietów - zainstaluj Node.js >= 18 ręcznie (https://nodejs.org)."
    fi
fi
command -v node >/dev/null 2>&1 || fail "node dalej niedostępny po instalacji"
command -v npm  >/dev/null 2>&1 || fail "npm dalej niedostępny po instalacji"
command -v curl >/dev/null 2>&1 || fail "curl dalej niedostępny po instalacji"
ok "Node.js $(node --version)"

# ---- pobierz agenta (już jest -> nie ściągaj) ----
if [ -f "$INSTALL_DIR/index.js" ]; then
    warn "Pliki agenta już są w $INSTALL_DIR - używam ich (bez pobierania)."
else
    mkdir -p "$INSTALL_DIR"
    TMP_AGENT="$(mktemp)"
    if curl -fsSL --max-time 120 "$GITHUB_URL" -o "$TMP_AGENT" 2>/dev/null; then
        warn "Pobieram agenta z GitHub Releases ..."
        tar xzf "$TMP_AGENT" -C "$INSTALL_DIR" 2>/dev/null \
            || fail "Nie udało się rozpakować archiwum agenta."
    else
        rm -f "$TMP_AGENT"
        fail "Nie udało się pobrać agenta z $GITHUB_URL.
   Sprawdź połączenie / zmienną GITHUB_URL."
    fi
    rm -f "$TMP_AGENT"
fi
rm -f "$INSTALL_DIR/.api_key"
[ -f "$INSTALL_DIR/index.js" ] || fail "Brak plików agenta w $INSTALL_DIR"
ok "Agent gotowy"

# ---- zależności ----
cd "$INSTALL_DIR"
npm install --omit=dev || fail "npm install się nie powiodło."
ok "Zależności zainstalowane"

# ---- rejestracja + pierwszy start ----
echo "Rejestruję z serwerem..."
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
    echo "[ERROR] Rejestracja nie powiodła się. Log:"
    cat /tmp/dhm-agent-register.log
    fail "Sprawdź REGISTER_TOKEN i czy serwer jest osiągalny."
fi
ok "Zarejestrowano"

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
                || warn "Nie udało się włączyć linger - agent wystartuje dopiero po zalogowaniu."
        fi
        ok "Autostart skonfigurowany (systemd user + linger)"
    else
        warn "systemctl --user niedostępny (brak sesji logowania?) - startuję agenta bezpośrednio."
        nohup "$NODE_BIN" index.js >/tmp/dhm-agent.log 2>&1 &
        echo "Aby włączyć autostart później, dodaj user systemd service (patrz README.md)."
    fi
else
    warn "Brak systemd - dodaj ręcznie autostart (patrz README.md)."
fi

echo
echo "=== GOTOWE ==="
echo "Serwer:    $SERVER_URL"
echo "Urządzenie: $DEVICE_NAME  ($DEVICE_TYPE)"
echo "Raporty:   co ${REPORT_INTERVAL}s"
echo "Logi:      journalctl --user -u dhm-agent -f"
echo "Dashboard: $SERVER_URL  (urządzenie pojawi się samo w ok. 1 min)"
