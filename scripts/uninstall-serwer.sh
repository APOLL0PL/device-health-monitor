#!/usr/bin/env bash
# Usuwanie serwera DHM: zatrzymuje procesy pm2 (dhm-server, dhm-serve)
# i wyłącza autostart pm2 (systemd).
#
# Domyślnie katalog repo (z data.db - historia urządzeń) ZOSTAJE jako
# backup. Dodaj --delete-files żeby usunąć też pliki (dane przepadną!).
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/device-health-monitor}"
DELETE_FILES=0
if [ "${1:-}" = "--delete-files" ]; then
    DELETE_FILES=1
fi

echo "=== Usuwanie serwera DHM ==="

# ---- zatrzymaj apki pm2 ----
command -v pm2 >/dev/null 2>&1 && {
    pm2 delete dhm-server 2>/dev/null || true
    pm2 delete dhm-serve 2>/dev/null || true
    pm2 save 2>/dev/null || true
    echo "[OK] procesy pm2 zatrzymane"
}

# ---- wyłącz autostart pm2 ----
if [ -d /run/systemd/system ] || [ -d /etc/systemd ]; then
    pm2 unstartup 2>/dev/null | bash 2>/dev/null || \
        pm2 unstartup systemd 2>/dev/null | bash 2>/dev/null || \
        echo "Brak usługi autostartu pm2 do usunięcia (lub uruchom ręcznie: pm2 unstartup)"
    echo "[OK] autostart pm2 wyłączony"
fi

# ---- firewall ----
if command -v ufw >/dev/null 2>&1; then
    sudo ufw delete allow 4000/tcp 2>/dev/null || true
    sudo ufw delete allow 9999/tcp 2>/dev/null || true
    echo "[OK] reguły firewall usunięte (4000, 9999)"
fi

# ---- pliki ----
if [ "$DELETE_FILES" = "1" ]; then
    if [ -d "$INSTALL_DIR" ]; then
        echo "Usuwam $INSTALL_DIR ..."
        rm -rf "$INSTALL_DIR"
        echo "[OK] pliki usunięte"
    fi
else
    echo "[OK] pliki zostały w $INSTALL_DIR (data.db zawiera historię urządzeń)"
    echo "     Uruchom ponownie z --delete-files żeby je usunąć."
fi

echo
echo "=== Usunięto ==="
