#!/usr/bin/env bash
# sync-extension.sh — mirror .context/extension-v2/ → cffbrw-extension-page-controller-public-repo/
#
# .context/extension-v2/ is the dev location (locally-excluded via .git/info/exclude).
# cffbrw-extension-page-controller-public-repo/ is the tracked public ship surface.
#
# Run this after editing any extension file. Idempotent — copies only files
# that differ. Exits 0 on success, non-zero on any failure.
#
# Usage:
#   ./scripts/sync-extension.sh         # copy + report
#   ./scripts/sync-extension.sh --check # report diffs only, no copy
#   ./scripts/sync-extension.sh --commit # copy + auto-commit in public repo

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/.context/extension-v2"
PUB="$ROOT/cffbrw-extension-page-controller-public-repo"

if [ ! -d "$DEV" ]; then
  echo "ERROR: $DEV missing" >&2
  exit 1
fi
if [ ! -d "$PUB" ]; then
  echo "ERROR: $PUB missing" >&2
  exit 1
fi

CHECK_ONLY=0
AUTO_COMMIT=0
for arg in "$@"; do
  case "$arg" in
    --check)  CHECK_ONLY=1 ;;
    --commit) AUTO_COMMIT=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Files that live in BOTH dev and public repo. Add new shared files here.
# Exclude: node_modules, package.json (pub has its own shape), vitest.config.js,
# bun.lock (pub has its own lockfile), __tests__/ (tests stay dev-side only
# unless we decide to ship them too — currently dev-only so vitest run works).
FILES=(
  manifest.json
  background.js
  content.js
  overlay.js
  popup.html
  popup.js
  recorder.js
  selectors.js
  PACKAGING.md
)

# Tests do NOT sync to pub repo. Chrome MV3 rejects any top-level dir
# starting with "_" (reserved for system use). __tests__/ would block
# `Load unpacked` with: "Cannot load extension with file or directory
# name __tests__". Tests stay dev-only.
TEST_FILES=()

copied=0
diffs=()
missing_pub=()

sync_one() {
  local rel="$1"
  local src="$DEV/$rel"
  local dst="$PUB/$rel"
  if [ ! -f "$src" ]; then
    return 0  # source doesn't exist, skip
  fi
  if [ ! -f "$dst" ] || ! diff -q "$src" "$dst" >/dev/null 2>&1; then
    if [ "$CHECK_ONLY" = "1" ]; then
      if [ ! -f "$dst" ]; then
        missing_pub+=("$rel")
      else
        diffs+=("$rel")
      fi
    else
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      copied=$((copied + 1))
      echo "  synced: $rel"
    fi
  fi
}

echo "=== sync-extension ==="
for f in "${FILES[@]}" ${TEST_FILES[@]+"${TEST_FILES[@]}"}; do
  sync_one "$f"
done

if [ "$CHECK_ONLY" = "1" ]; then
  if [ ${#diffs[@]} -eq 0 ] && [ ${#missing_pub[@]} -eq 0 ]; then
    echo "  clean — public repo in sync"
    exit 0
  fi
  [ ${#diffs[@]} -gt 0 ] && printf '  diff: %s\n' "${diffs[@]}"
  [ ${#missing_pub[@]} -gt 0 ] && printf '  missing in pub: %s\n' "${missing_pub[@]}"
  echo "  (run without --check to copy)"
  exit 1
fi

if [ "$copied" = "0" ]; then
  echo "  already in sync"
  exit 0
fi

echo ""
echo "synced $copied file(s) → $PUB"

if [ "$AUTO_COMMIT" = "1" ]; then
  cd "$PUB"
  if [ -z "$(git status --porcelain)" ]; then
    echo "  pub repo: no git changes (files written but hashes identical)"
    exit 0
  fi
  git add -A
  msg="chore(ext): sync from dev ($(date -u +%Y-%m-%dT%H:%MZ))"
  git commit -m "$msg"
  echo "  pub repo: committed — $msg"
fi
