#!/data/data/com.termux/files/usr/bin/sh
# Instalacja agenta DHM na telefonie (Termux).
# Ściąga agenta z GitHub Releases, rejestruje, startuje i konfiguruje
# autostart przez Termux:Boot.
#
# Zmienne: SERVER_URL, GITHUB_URL, DEVICE_NAME, REPORT_INTERVAL, REGISTER_TOKEN
# Przykład: REGISTER_TOKEN=<token> SERVER_URL=http://<server-IP>:4000 sh /tmp/setup-dhm.sh
set -e

SERVER_URL="${SERVER_URL:-}"
GITHUB_URL="${GITHUB_URL:-https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/dhm-agent.tar.gz}"
DEVICE_NAME="${DEVICE_NAME:-$(getprop ro.product.model 2>/dev/null || echo 'Phone')}"
DEVICE_TYPE=phone
REPORT_INTERVAL="${REPORT_INTERVAL:-}"
REGISTER_TOKEN="${REGISTER_TOKEN:-}"

INSTALL_DIR="$HOME/dhm-agent"
AGENT_TAR="$HOME/dhm-agent.tar.gz"

# --- token rejestracji: env -> prompt (lub przerwij) ---
if [ -z "$REGISTER_TOKEN" ]; then
  printf "Token rejestracji (REGISTER_TOKEN z server/.env): "
  read -r REGISTER_TOKEN || true
fi
if [ -z "$REGISTER_TOKEN" ]; then
  echo "[ERROR] Brak tokenu rejestracji - weź go z server/.env na serwerze DHM."
  exit 1
fi

# --- lokalne IP telefonu (jeśli `ip` jest dostępne) ---
detect_ip() {
  command -v ip >/dev/null 2>&1 && ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1
}

# --- brama (domyślna trasa) ---
detect_gateway() {
  command -v ip >/dev/null 2>&1 && ip -4 route show default 2>/dev/null | awk '/via /{print $3; exit}'
}

# --- sprawdź czy serwer DHM odpowiada na ip:port ---
dhm_probe() {
  curl -fsS -m 3 "http://$1:${2:-4000}/api/devices" -o /dev/null 2>/dev/null
}

# --- adres serwera (probe własne IP + brama, inaczej pytaj) ---
if [ -z "$SERVER_URL" ]; then
  LOCAL_IP="$(detect_ip)"
  GATEWAY_IP="$(detect_gateway)"
  for cand in "$LOCAL_IP" "$GATEWAY_IP"; do
    if [ -n "$cand" ] && dhm_probe "$cand" 4000; then
      SERVER_URL="http://$cand:4000"
      echo "Wykryto serwer DHM: $SERVER_URL"
      break
    fi
  done
fi
if [ -z "$SERVER_URL" ]; then
  DEFAULT_IP="${GATEWAY_IP:-$LOCAL_IP}"
  echo "Nie wykryto serwera DHM (sprawdzono IP telefonu i bramę)."
  echo "Można podać ręcznie: REGISTER_TOKEN=... SERVER_URL=http://<server-IP>:4000 sh /tmp/setup-dhm.sh"
  if [ -n "$DEFAULT_IP" ]; then
    printf "Adres serwera DHM (http://IP:4000) [http://%s:4000]: " "$DEFAULT_IP"
    read -r ANS || true
    SERVER_URL="${ANS:-http://$DEFAULT_IP:4000}"
  else
    printf "Adres serwera DHM (http://IP:4000): "
    read -r ANS || true
    SERVER_URL="${ANS:-http://192.168.0.10:4000}"
  fi
fi

echo "=== Agent DHM — Termux ==="
echo "Serwer:     $SERVER_URL"
echo "Urządzenie: $DEVICE_NAME (telefon)"

# --- interwał raportowania (s): env -> prompt (domyślnie 300 = 5 min) ---
if [ -z "$REPORT_INTERVAL" ]; then
  printf "Jak często agent ma raportować? (sekundy) [300]: "
  read -r ANS
  REPORT_INTERVAL="${ANS:-300}"
fi
case "$REPORT_INTERVAL" in
  ''|*[!0-9]*) echo "Nieprawidłowy REPORT_INTERVAL - ustawiam 300."; REPORT_INTERVAL=300 ;;
esac
echo "Raporty:    co ${REPORT_INTERVAL}s"

# --- zależności ---
command -v curl >/dev/null 2>&1 || pkg install -y curl
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Instaluję nodejs-lts..."
  pkg install -y nodejs-lts
fi

# --- pobierz agenta ---
mkdir -p "$INSTALL_DIR"
echo "Pobieram agenta..."
if ! curl -fsSL --max-time 120 "$GITHUB_URL" -o "$AGENT_TAR" 2>/dev/null; then
  echo "Nie udało się pobrać agenta z $GITHUB_URL"
  echo "Sprawdź połączenie / zmienną GITHUB_URL."
  exit 1
fi
tar xzf "$AGENT_TAR" -C "$INSTALL_DIR"
rm -f "$AGENT_TAR"

# --- zależności agenta ---
cd "$INSTALL_DIR"
echo "Instaluję zależności (npm install)..."
npm install --omit=dev

# --- pierwsza rejestracja ---
echo "Rejestruję z serwerem..."
SERVER_URL="$SERVER_URL" DEVICE_TYPE="$DEVICE_TYPE" DEVICE_NAME="$DEVICE_NAME" REPORT_INTERVAL="$REPORT_INTERVAL" REGISTER_TOKEN="$REGISTER_TOKEN" node index.js >/tmp/dhm-agent.log 2>&1 &
AGENT_PID=$!
sleep 12
kill "$AGENT_PID" 2>/dev/null || true
if [ -f "$INSTALL_DIR/.api_key" ]; then
  echo "[OK] Zarejestrowano"
else
  echo "[ERROR] Brak klucza — sprawdź log:"
  cat /tmp/dhm-agent.log
  exit 1
fi

# --- autostart (Termux:Boot) ---
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/dhm-agent.sh" <<SH
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd $HOME/dhm-agent
DEVICE_TYPE=phone SERVER_URL="$SERVER_URL" REPORT_INTERVAL="$REPORT_INTERVAL" node index.js &
SH
chmod +x "$HOME/.termux/boot/dhm-agent.sh"

# --- start teraz ---
nohup sh "$HOME/.termux/boot/dhm-agent.sh" >/dev/null 2>&1 &
sleep 3

echo
echo "=== GOTOWE ==="
echo "Agent działa (raporty co ${REPORT_INTERVAL}s). Dashboard: $SERVER_URL"
echo "Zainstaluj 'Termux:Boot' z F-Droid i otwórz go raz — autostart po restarcie."
