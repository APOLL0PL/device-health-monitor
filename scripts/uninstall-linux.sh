#!/usr/bin/env bash
# ============================================================================
# DHM AGENT - uninstall (Linux)
# Stops the systemd user service, removes the agent files and the autostart
# unit. The device stays visible on the dashboard as offline.
#
# Use --delete-key to also remove the agent key (.api_key) - only needed if
# you want to forget this device's identity on the server.
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/dhm-agent}"
DELETE_KEY=0
if [ "${1:-}" = "--delete-key" ]; then
    DELETE_KEY=1
fi

echo "=== DHM Agent uninstall (Linux) ==="

# ---- stop + disable systemd user service ----
if [ -d /run/systemd/system ] || [ -d /etc/systemd ]; then
    systemctl --user stop dhm-agent 2>/dev/null || true
    systemctl --user disable dhm-agent 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/dhm-agent.service"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "[OK] systemd service removed"
fi

# ---- stop any stray node process from the agent ----
pkill -f "$INSTALL_DIR/index.js" 2>/dev/null || true

# ---- remove files ----
if [ -d "$INSTALL_DIR" ]; then
    if [ "$DELETE_KEY" = "1" ]; then
        rm -rf "$INSTALL_DIR"
    else
        # keep the key so a future re-install keeps the same device identity
        if [ -f "$INSTALL_DIR/.api_key" ]; then
            mv "$INSTALL_DIR/.api_key" "$HOME/dhm-agent.api_key.bak"
            echo "[OK] key kept at $HOME/dhm-agent.api_key.bak"
        fi
        rm -rf "$INSTALL_DIR"
    fi
fi
echo "[OK] agent files removed"

echo
echo "=== Removed ==="
echo "The device remains visible on the dashboard (offline)."
echo "To remove it there, delete it from the dashboard UI (needs AUTH_TOKEN)."
