#!/usr/bin/env bash
# Usuwanie agenta DHM (Linux): zatrzymuje systemd user service,
# usuwa pliki agenta i autostart. Urządzenie zostaje widoczne
# na dashboardzie jako offline.
#
# --delete-key usuwa też klucz (.api_key) - tylko jeśli chcesz
# zapomnieć tożsamość urządzenia na serwerze.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/dhm-agent}"
DELETE_KEY=0
if [ "${1:-}" = "--delete-key" ]; then
    DELETE_KEY=1
fi

echo "=== Usuwanie agenta DHM (Linux) ==="

# ---- zatrzymaj + wyłącz systemd user service ----
if [ -d /run/systemd/system ] || [ -d /etc/systemd ]; then
    systemctl --user stop dhm-agent 2>/dev/null || true
    systemctl --user disable dhm-agent 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/dhm-agent.service"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "[OK] systemd service usunięty"
fi

# ---- zatrzymaj ewentualny proces node z agenta ----
pkill -f "$INSTALL_DIR/index.js" 2>/dev/null || true

# ---- usuń pliki ----
if [ -d "$INSTALL_DIR" ]; then
    if [ "$DELETE_KEY" = "1" ]; then
        rm -rf "$INSTALL_DIR"
    else
        # klucz zostaje, żeby ponowna instalacja zachowała tożsamość urządzenia
        if [ -f "$INSTALL_DIR/.api_key" ]; then
            mv "$INSTALL_DIR/.api_key" "$HOME/dhm-agent.api_key.bak"
            echo "[OK] klucz zapisany w $HOME/dhm-agent.api_key.bak"
        fi
        rm -rf "$INSTALL_DIR"
    fi
fi
echo "[OK] pliki agenta usunięte"

echo
echo "=== Usunięto ==="
echo "Urządzenie pozostaje widoczne na dashboardzie (offline)."
echo "Aby je usunąć, zrób to w interfejsie dashboard (wymaga AUTH_TOKEN)."
