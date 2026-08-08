#!/usr/bin/env bash
# ============================================================================
# DHM SERVER - uninstall
# Stops the pm2 processes (dhm-server, dhm-serve) and disables the pm2
# systemd autostart service.
#
# By default the repo directory (with data.db - device history) is KEPT as a
# backup. Add --delete-files to remove it too (data is lost!).
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/device-health-monitor}"
DELETE_FILES=0
if [ "${1:-}" = "--delete-files" ]; then
    DELETE_FILES=1
fi

echo "=== DHM Server uninstall ==="

# ---- stop pm2 apps ----
command -v pm2 >/dev/null 2>&1 && {
    pm2 delete dhm-server 2>/dev/null || true
    pm2 delete dhm-serve 2>/dev/null || true
    pm2 save 2>/dev/null || true
    echo "[OK] pm2 processes stopped"
}

# ---- disable pm2 autostart ----
if [ -d /run/systemd/system ] || [ -d /etc/systemd ]; then
    pm2 unstartup 2>/dev/null | bash 2>/dev/null || \
        pm2 unstartup systemd 2>/dev/null | bash 2>/dev/null || \
        echo "No pm2 autostart service to remove (or run manually: pm2 unstartup)"
    echo "[OK] pm2 autostart disabled"
fi

# ---- firewall ----
if command -v ufw >/dev/null 2>&1; then
    sudo ufw delete allow 4000/tcp 2>/dev/null || true
    sudo ufw delete allow 9999/tcp 2>/dev/null || true
    echo "[OK] firewall rules removed (4000, 9999)"
fi

# ---- files ----
if [ "$DELETE_FILES" = "1" ]; then
    if [ -d "$INSTALL_DIR" ]; then
        echo "Removing $INSTALL_DIR ..."
        rm -rf "$INSTALL_DIR"
        echo "[OK] files removed"
    fi
else
    echo "[OK] files kept at $INSTALL_DIR (data.db has the device history)"
    echo "     Re-run with --delete-files to remove them."
fi

echo
echo "=== Removed ==="
