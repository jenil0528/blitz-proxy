#!/bin/bash
# ============================================================================
# BlitzProxy — Mac/Linux Setup (safe)
# Installs a small wrapper script so `blitz` works from anywhere.
# Does NOT touch your shell rc files and does NOT permanently set
# ANTHROPIC_*/OPENAI_* variables — use `blitz run claude` instead.
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"

echo ""
echo "  BlitzProxy — Setup"
echo "  =================="
echo ""

# ── Node.js check ─────────────────────────────────────────────────────────────
if [ -z "$NODE_BIN" ]; then
  echo "  [FAIL] Node.js is not installed. Install 18+ from https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  [FAIL] Node.js 18+ required (found $(node -v))"
  exit 1
fi
echo "  [OK] Node.js $(node -v)"

# ── Make entry point executable ─────────────────────────────────────────────
chmod +x "$SCRIPT_DIR/blitz.sh" 2>/dev/null || true
echo "  [OK] blitz.sh is executable"

# ── Install wrapper (absolute path — reliable from any directory) ─────────────
# A symlink would break $0 resolution in blitz.sh; a wrapper is robust.
TARGET="/usr/local/bin/blitz"
do_install() {
  mkdir -p "$(dirname "$TARGET")"
  cat > "$TARGET" <<WRAPPER
#!/bin/sh
exec node "$SCRIPT_DIR/cli.js" "\$@"
WRAPPER
  chmod +x "$TARGET"
}

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if grep -q "BlitzProxy\|$SCRIPT_DIR/cli.js" "$TARGET" 2>/dev/null || head -1 "$TARGET" | grep -q '^#!/bin/sh' 2>/dev/null; then
    if [ -w "$TARGET" ]; then do_install; else sudo sh -c "echo ok >/dev/null" && sudo cp /dev/stdin "$TARGET" <<WRAPPER 2>/dev/null || { sudo rm -f "$TARGET" && do_install; }
#!/bin/sh
exec node "$SCRIPT_DIR/cli.js" "\$@"
WRAPPER
    fi
    echo "  [OK] Updated existing wrapper: $TARGET"
  else
    echo "  [WARN] $TARGET exists and does not look like a BlitzProxy wrapper."
    echo "         Not overwriting. Use it directly: $SCRIPT_DIR/blitz.sh <command>"
    TARGET=""
  fi
else
  if [ -w "$(dirname "$TARGET")" ]; then
    do_install
  else
    sudo true 2>/dev/null && sudo tee "$TARGET" >/dev/null <<WRAPPER
#!/bin/sh
exec node "$SCRIPT_DIR/cli.js" "\$@"
WRAPPER
    sudo chmod +x "$TARGET"
  fi
  echo "  [OK] Installed: $TARGET → $SCRIPT_DIR/cli.js"
fi

# ── Backup config if present ─────────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/config.json" ]; then
  BACKUP="$SCRIPT_DIR/config.json.bak.$(date +%Y-%m-%d-%H%M%S)"
  cp "$SCRIPT_DIR/config.json" "$BACKUP"
  chmod 600 "$BACKUP"
  echo "  [OK] Backed up config.json → $(basename "$BACKUP")"
fi

echo ""
echo "  Next steps:"
echo "    1. blitz add YOUR_API_KEY     # stored in the OS keychain (macOS Keychain / secret-tool)"
echo "    2. blitz run claude           # Claude Code through BlitzProxy"
echo "    3. blitz run codex            # Codex CLI through BlitzProxy"
echo ""
echo "  No global environment variables were modified."
echo "  Uninstall: bash $(dirname "$0")/uninstall.sh"
echo ""
