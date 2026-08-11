#!/usr/bin/env bash
# ============================================================================
# DHM - build release artifacts (for GitHub Releases)
#
# Produces:
#   dhm-agent.tar.gz   - agent source (flat: index.js at root, cross-platform)
#   dhm-bundle.tar.gz  - full repo source (server + dashboard + agent + scripts)
#
# Both are SOURCE ONLY - no node_modules. Native modules (better-sqlite3)
# are built during `npm install` on the target machine, so the tarballs
# work on any platform (x64/ARM, Linux/Windows).
#
# Usage:  ./build-release.sh [OUT_DIR]
# Default OUT_DIR: ./release/
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/release}"
mkdir -p "$OUT_DIR"
cd "$REPO_ROOT"

ok() { echo "[OK] $*"; }

# --- agent tarball (flat layout - index.js at root, like the LAN one) ---
tar czf "$OUT_DIR/dhm-agent.tar.gz" -C agent \
    --exclude=node_modules \
    --exclude=.api_key \
    --exclude=.env \
    --exclude='*.log' \
    .

# --- full bundle (everything needed to run server + dashboard + agents) ---
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

# --- sanity checks (grep -c, not grep -q: SIGPIPE under pipefail) ---
[ "$(tar tzf "$OUT_DIR/dhm-agent.tar.gz" | grep -c '\./index\.js')" -ge 1 ] \
    || { echo "ERROR: dhm-agent.tar.gz is missing agent/index.js"; exit 1; }
[ "$(tar tzf "$OUT_DIR/dhm-bundle.tar.gz" | grep -c '\./server/index\.js')" -ge 1 ] \
    || { echo "ERROR: dhm-bundle.tar.gz is missing server/index.js"; exit 1; }
[ "$(tar tzf "$OUT_DIR/dhm-bundle.tar.gz" | grep -c '\./dashboard/dist/index\.html')" -ge 1 ] \
    || { echo "ERROR: dhm-bundle.tar.gz is missing the dashboard build"; exit 1; }

ok "Built release artifacts in $OUT_DIR"
ls -lh "$OUT_DIR"/*.tar.gz
