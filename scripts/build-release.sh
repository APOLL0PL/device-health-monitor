#!/usr/bin/env bash
# Budowanie artefaktów release DHM (dla GitHub Releases):
#   dhm-agent.tar.gz   - agent (płasko: index.js w root, wieloplatformowo)
#   dhm-bundle.tar.gz  - pełne repo (server + dashboard + agent + scripts)
#
# Oba to tylko ŹRÓDŁO - bez node_modules. Moduły natywne (better-sqlite3)
# budują się przy `npm install` na maszynie docelowej, więc archiwa działają
# na każdej platformie (x64/ARM, Linux/Windows).
#
# Użycie: ./build-release.sh [OUT_DIR]
# Domyślny OUT_DIR: ./release/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/release}"
mkdir -p "$OUT_DIR"
cd "$REPO_ROOT"

ok() { echo "[OK] $*"; }

# --- tarball agenta (płaski layout - index.js w root, jak na LAN) ---
tar czf "$OUT_DIR/dhm-agent.tar.gz" -C agent \
    --exclude=node_modules \
    --exclude=.api_key \
    --exclude=.env \
    --exclude='*.log' \
    .

# --- pełny bundle (wszystko do uruchomienia server + dashboard + agenty) ---
tar czf "$OUT_DIR/dhm-bundle.tar.gz" \
    --exclude=.git \
    --exclude=node_modules \
    --exclude=server/.env \
    --exclude=agent/.api_key \
    --exclude=dashboard/dist/config.js \
    --exclude='*.tar.gz' \
    --exclude='*.log' \
    --exclude=release \
    .

# --- sanity checks (grep -c, nie grep -q: SIGPIPE pod pipefail) ---
[ "$(tar tzf "$OUT_DIR/dhm-agent.tar.gz" | grep -c '\./index\.js')" -ge 1 ] \
    || { echo "ERROR: w dhm-agent.tar.gz brak agent/index.js"; exit 1; }
[ "$(tar tzf "$OUT_DIR/dhm-bundle.tar.gz" | grep -c '\./server/index\.js')" -ge 1 ] \
    || { echo "ERROR: w dhm-bundle.tar.gz brak server/index.js"; exit 1; }
[ "$(tar tzf "$OUT_DIR/dhm-bundle.tar.gz" | grep -c '\./dashboard/dist/index\.html')" -ge 1 ] \
    || { echo "ERROR: w dhm-bundle.tar.gz brak builda dashboard"; exit 1; }

ok "Zbudowano artefakty release w $OUT_DIR"
ls -lh "$OUT_DIR"/*.tar.gz
