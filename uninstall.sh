#!/bin/bash
# ============================================================================
# BlitzProxy — Mac/Linux Uninstaller
# Removes ONLY BlitzProxy components:
#   - the `blitz` wrapper at /usr/local/bin/blitz
# Optional: -p / --purge also removes ~/.blitzproxy (stored keys, stats)
# Your project files are never touched.
# ============================================================================

TARGET="/usr/local/bin/blitz"
PURGE=0
for arg in "$@"; do
  case "$arg" in
    -p|--purge) PURGE=1 ;;
  esac
done

echo ""
echo "  BlitzProxy — Uninstaller"
echo "  ========================"
echo ""

# ── Remove wrapper only if it is ours ────────────────────────────────────────
if [ -f "$TARGET" ]; then
  if grep -q "cli.js" "$TARGET" 2>/dev/null; then
    if [ -w "$TARGET" ]; then
      rm -f "$TARGET"
    else
      sudo rm -f "$TARGET"
    fi
    echo "  [OK] Removed $TARGET"
  else
    echo "  [WARN] $TARGET exists but is not a BlitzProxy wrapper — leaving it alone."
  fi
else
  echo "  [INFO] No wrapper found at $TARGET"
fi

# ── Optional purge of stored keys / stats ────────────────────────────────────
BLITZ_HOME="${BLITZ_HOME:-$HOME/.blitzproxy}"
if [ "$PURGE" -eq 1 ] && [ -d "$BLITZ_HOME" ]; then
  printf "  Remove ALL stored API keys and stats (%s)? [y/N] " "$BLITZ_HOME"
  read -r answer
  if echo "$answer" | grep -qi '^y'; then
    rm -rf "$BLITZ_HOME"
    echo "  [OK] Removed $BLITZ_HOME"
  else
    echo "  [INFO] Kept $BLITZ_HOME"
  fi
fi

echo ""
echo "  Uninstalled. Project files in this folder were NOT deleted."
echo "  Close and reopen terminals for PATH/shell changes to apply."
echo ""
