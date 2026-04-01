#!/usr/bin/env bash
set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

MATRIX_HOME="${MATRIX_HOME:-$HOME/.matrix}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$REPO_DIR/bin"

echo -e "${BOLD}"
echo '  ╔══════════════════════════════════╗'
echo '  ║   MATRIX — Uninstall             ║'
echo '  ╚══════════════════════════════════╝'
echo -e "${NC}"
echo -e "${YELLOW}This will remove Matrix configuration and hooks from your system.${NC}"
echo -e "${DIM}The repo directory itself will not be deleted.${NC}"
echo ""

# Step 1: Stop running server if active
echo -e "${BOLD}Stopping Matrix server (if running)...${NC}"
if command -v "$BIN_DIR/matrix-app" &>/dev/null 2>&1; then
  "$BIN_DIR/matrix-app" stop 2>/dev/null || true
  echo -e "  ${GREEN}✓${NC} Server stopped"
else
  echo -e "  ${DIM}Server binary not found, skipping${NC}"
fi
echo ""

# Step 2: Remove ~/.matrix directory
echo -e "${BOLD}Remove $MATRIX_HOME?${NC}"
echo -e "  ${DIM}This contains your projects.conf, project-paths.conf, VAPID keys, and logs.${NC}"
echo -e "  ${YELLOW}This cannot be undone.${NC} [y/N] "
read -r confirm_data
if [[ "$confirm_data" == "y" || "$confirm_data" == "Y" ]]; then
  if [ -d "$MATRIX_HOME" ]; then
    rm -rf "$MATRIX_HOME"
    echo -e "  ${GREEN}✓${NC} Removed $MATRIX_HOME"
  else
    echo -e "  ${DIM}$MATRIX_HOME does not exist, skipping${NC}"
  fi
else
  echo -e "  ${DIM}Skipped — $MATRIX_HOME preserved${NC}"
fi
echo ""

# Step 3: Remove macOS LaunchAgent
if [[ "$(uname)" == "Darwin" ]]; then
  echo -e "${BOLD}Removing LaunchAgent...${NC}"
  PLIST_FILE="$HOME/Library/LaunchAgents/com.matrix-console.autostart.plist"
  if [ -f "$PLIST_FILE" ]; then
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
    rm -f "$PLIST_FILE"
    echo -e "  ${GREEN}✓${NC} LaunchAgent removed"
  else
    echo -e "  ${DIM}LaunchAgent not installed, skipping${NC}"
  fi
  echo ""
fi

# Step 4: Remove PATH entry from shell rc
echo -e "${BOLD}Removing PATH entry from shell config...${NC}"
for rc_file in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [ -f "$rc_file" ] && grep -q "matrix/bin" "$rc_file" 2>/dev/null; then
    # Remove the comment line and the export PATH line together
    # Use a temp file for safe in-place editing
    tmpfile=$(mktemp)
    grep -v "# Matrix — Claude Console" "$rc_file" | grep -v "matrix/bin" > "$tmpfile"
    # Remove any blank lines left at EOF that were inserted during install
    mv "$tmpfile" "$rc_file"
    echo -e "  ${GREEN}✓${NC} Removed PATH entry from $rc_file"
  fi
done
echo ""

# Step 5: Remove hooks from ~/.claude/settings.json
echo -e "${BOLD}Removing hooks from ~/.claude/settings.json...${NC}"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

if [ -f "$CLAUDE_SETTINGS" ]; then
  node -e "
    const fs = require('fs');
    let raw;
    try {
      raw = fs.readFileSync('$CLAUDE_SETTINGS', 'utf8');
    } catch (e) {
      console.log('  Could not read settings.json:', e.message);
      process.exit(0);
    }

    let settings;
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      console.log('  settings.json is not valid JSON — skipping hook removal');
      process.exit(0);
    }

    if (!settings.hooks) {
      console.log('  No hooks found, nothing to remove');
      process.exit(0);
    }

    let changed = false;

    // Filter helper: remove any hook entry whose command references matrix
    const removeMatrixHooks = (hookArray) => {
      if (!Array.isArray(hookArray)) return hookArray;
      return hookArray.filter(entry => {
        if (!entry.hooks || !Array.isArray(entry.hooks)) return true;
        const hasMatrix = entry.hooks.some(h =>
          h.command && (
            h.command.includes('matrix-project-tag') ||
            h.command.includes('matrix-notify')
          )
        );
        if (hasMatrix) changed = true;
        return !hasMatrix;
      });
    };

    ['PostToolUse', 'Notification', 'Stop'].forEach(event => {
      if (settings.hooks[event]) {
        settings.hooks[event] = removeMatrixHooks(settings.hooks[event]);
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
    });

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    if (changed) {
      fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(settings, null, 2));
      console.log('  Hooks removed from ~/.claude/settings.json');
    } else {
      console.log('  No Matrix hooks found in settings.json');
    }
  "
else
  echo -e "  ${DIM}~/.claude/settings.json not found, skipping${NC}"
fi

echo ""
echo -e "${GREEN}${BOLD}Uninstall complete.${NC}"
echo ""
echo -e "  ${DIM}The repo at ${REPO_DIR} was not removed.${NC}"
echo -e "  ${DIM}Delete it manually if you no longer need it.${NC}"
echo ""
echo -e "  ${DIM}Restart your shell to apply PATH changes.${NC}"
