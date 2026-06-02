#!/usr/bin/env bash
# rebuild.sh — deploy Motion Detector static frontend to /var/www/html/motion-detector
#
# What it does:
#   • Copies every static frontend file (HTML, CSS, JS) to DEST
#   • Skips .git, src/, tests/, *.sh, *.md, *.toml, *.lock
#   • Never deletes manually-added server-side files in DEST
#
# Usage:
#   ./rebuild.sh              — deploy to default target
#   ./rebuild.sh /other/path  — deploy to a custom target

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-/var/www/html/motion-detector}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}==> motion-detector rebuild${NC}"
echo    "    src : $SRC"
echo    "    dest: $DEST"
echo

# ── Preflight ──────────────────────────────────────────────────────────────────
if [[ ! -f "$SRC/index.html" ]]; then
    echo -e "${RED}ERROR: run this script from the repo root (index.html not found)${NC}"
    exit 1
fi

# Create dest if needed
if [[ ! -d "$DEST" ]]; then
    echo -e "${YELLOW}  creating $DEST${NC}"
    mkdir -p "$DEST"
fi

# ── Copy static files with rsync ───────────────────────────────────────────────
# --checksum        only copy when content differs
# No --delete: never remove manually-added server-side files

rsync -av --checksum \
    --exclude='.git/'         \
    --exclude='src/'          \
    --exclude='tests/'        \
    --exclude='*.sh'          \
    --exclude='*.md'          \
    --exclude='*.toml'        \
    --exclude='*.lock'        \
    --exclude='*.bak'         \
    --exclude='*.py'          \
    --exclude='LICENSE*'      \
    "$SRC/" "$DEST/"

echo
echo -e "${GREEN}==> Done.${NC}"
echo    "    Deployed to $DEST"
echo    "    Served at  https://motion-detector.denizsincar.ru"
