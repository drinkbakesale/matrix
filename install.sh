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

echo -e "${GREEN}${BOLD}"
echo '  ╔══════════════════════════════════╗'
echo '  ║     MATRIX — Claude Console      ║'
echo '  ╚══════════════════════════════════╝'
echo -e "${NC}"

# Step 1: Check dependencies
echo -e "${BOLD}Checking dependencies...${NC}"

check_dep() {
  if command -v "$1" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $1 $(command -v "$1")"
    return 0
  else
    echo -e "  ${RED}✗${NC} $1 not found"
    return 1
  fi
}

missing=()
check_dep node || missing+=(node)
check_dep tmux || missing+=(tmux)
check_dep claude || missing+=(claude)

# Optional deps
if command -v ffmpeg &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} ffmpeg (voice input enabled)"
else
  echo -e "  ${YELLOW}○${NC} ffmpeg not found (voice input disabled — install with: brew install ffmpeg)"
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}Missing required dependencies: ${missing[*]}${NC}"

  # Offer to install via brew on macOS
  if [[ "$(uname)" == "Darwin" ]] && command -v brew &>/dev/null; then
    # Only install what brew can provide (not claude)
    brew_installable=()
    for dep in "${missing[@]}"; do
      [[ "$dep" != "claude" ]] && brew_installable+=("$dep")
    done

    if [ ${#brew_installable[@]} -gt 0 ]; then
      echo -e "Install ${brew_installable[*]} via brew? [Y/n] "
      read -r confirm
      if [[ "$confirm" != "n" && "$confirm" != "N" ]]; then
        brew install "${brew_installable[@]}"
      fi
    fi

    # Check for Claude separately
    for dep in "${missing[@]}"; do
      if [[ "$dep" == "claude" ]]; then
        echo ""
        echo -e "${YELLOW}Claude Code CLI is required.${NC}"
        echo "  Install: https://docs.anthropic.com/en/docs/claude-code"
        echo "  Or: npm install -g @anthropic-ai/claude-code"
      fi
    done
  else
    echo ""
    echo "Please install the missing dependencies and run install.sh again."
    [[ " ${missing[*]} " =~ " claude " ]] && echo "  Claude Code: https://docs.anthropic.com/en/docs/claude-code"
    [[ " ${missing[*]} " =~ " node " ]] && echo "  Node.js: https://nodejs.org/"
    [[ " ${missing[*]} " =~ " tmux " ]] && echo "  tmux: apt install tmux (Linux) or brew install tmux (macOS)"
  fi

  # Re-check after potential install
  still_missing=false
  for dep in "${missing[@]}"; do
    command -v "$dep" &>/dev/null || still_missing=true
  done
  if $still_missing; then
    exit 1
  fi
fi

echo ""

# Step 2: Create MATRIX_HOME directory structure
echo -e "${BOLD}Setting up ~/.matrix...${NC}"
mkdir -p "$MATRIX_HOME/logs"

# Step 3: Install npm dependencies
echo -e "${BOLD}Installing dependencies...${NC}"
cd "$REPO_DIR" && npm install --production 2>&1 | tail -1
echo ""

# Step 4: Generate VAPID keys for Web Push notifications
if [ ! -f "$MATRIX_HOME/vapid.json" ]; then
  echo -e "${BOLD}Generating push notification keys...${NC}"
  node -e "
    const wp = require('web-push');
    const keys = wp.generateVAPIDKeys();
    const fs = require('fs');
    fs.writeFileSync('$MATRIX_HOME/vapid.json', JSON.stringify(keys, null, 2));
    console.log('  VAPID keys saved to $MATRIX_HOME/vapid.json');
  "
else
  echo -e "  ${DIM}VAPID keys already exist${NC}"
fi

# Step 5: Create default config files if they don't exist
if [ ! -f "$MATRIX_HOME/projects.conf" ]; then
  cp "$REPO_DIR/config/projects.conf.example" "$MATRIX_HOME/projects.conf"
  echo -e "  Created ${BOLD}$MATRIX_HOME/projects.conf${NC}"
else
  echo -e "  ${DIM}projects.conf already exists${NC}"
fi

if [ ! -f "$MATRIX_HOME/project-paths.conf" ]; then
  cp "$REPO_DIR/config/project-paths.conf.example" "$MATRIX_HOME/project-paths.conf"
  echo -e "  Created ${BOLD}$MATRIX_HOME/project-paths.conf${NC}"
else
  echo -e "  ${DIM}project-paths.conf already exists${NC}"
fi

# Initialize empty push subscriptions
[ ! -f "$MATRIX_HOME/push-subscriptions.json" ] && echo '[]' > "$MATRIX_HOME/push-subscriptions.json"

echo ""

# Step 6: Add bin/ to PATH
BIN_DIR="$REPO_DIR/bin"
SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
  if ! grep -q "matrix/bin" "$SHELL_RC" 2>/dev/null; then
    echo "" >> "$SHELL_RC"
    echo "# Matrix — Claude Console" >> "$SHELL_RC"
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
    echo -e "  Added ${BOLD}$BIN_DIR${NC} to PATH in $SHELL_RC"
  else
    echo -e "  ${DIM}PATH already configured${NC}"
  fi
fi

# Step 7: Install Claude Code hook for project auto-tagging
echo -e "${BOLD}Installing Claude Code hook...${NC}"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
HOOK_CMD="node \"$REPO_DIR/hooks/matrix-project-tag.js\""

if [ -f "$CLAUDE_SETTINGS" ]; then
  # Check if hook is already installed
  if grep -q "matrix-project-tag" "$CLAUDE_SETTINGS" 2>/dev/null; then
    echo -e "  ${DIM}Hook already installed${NC}"
  else
    # Use node to safely inject the hook into settings.json
    node -e "
      const fs = require('fs');
      const settings = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS', 'utf8'));
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
      settings.hooks.PostToolUse.unshift({
        hooks: [{
          type: 'command',
          command: '$HOOK_CMD',
          timeout: 2000,
          async: true
        }]
      });
      // Also add notification hook
      if (!settings.hooks.Notification) settings.hooks.Notification = [];
      if (!settings.hooks.Notification.some(h => h.hooks?.some(hh => hh.command?.includes('matrix-notify')))) {
        settings.hooks.Notification.push({
          hooks: [{
            type: 'command',
            command: '$BIN_DIR/matrix-notify'
          }]
        });
      }
      // Add stop hook
      if (!settings.hooks.Stop) settings.hooks.Stop = [];
      if (!settings.hooks.Stop.some(h => h.hooks?.some(hh => hh.command?.includes('matrix-notify')))) {
        settings.hooks.Stop.push({
          hooks: [{
            type: 'command',
            command: '$BIN_DIR/matrix-notify \"Task finished\"'
          }]
        });
      }
      fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(settings, null, 2));
      console.log('  Hooks installed in ~/.claude/settings.json');
    "
  fi
else
  # Create settings.json with hooks
  mkdir -p "$HOME/.claude"
  node -e "
    const fs = require('fs');
    const settings = {
      hooks: {
        PostToolUse: [{
          hooks: [{
            type: 'command',
            command: '$HOOK_CMD',
            timeout: 2000,
            async: true
          }]
        }],
        Notification: [{
          hooks: [{
            type: 'command',
            command: '$BIN_DIR/matrix-notify'
          }]
        }],
        Stop: [{
          hooks: [{
            type: 'command',
            command: '$BIN_DIR/matrix-notify \"Task finished\"'
          }]
        }]
      }
    };
    fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(settings, null, 2));
    console.log('  Created ~/.claude/settings.json with hooks');
  "
fi

echo ""

# Step 8: Optional — macOS LaunchAgent for autostart
if [[ "$(uname)" == "Darwin" ]]; then
  echo -e "Start Matrix automatically on login? [y/N] "
  read -r autostart
  if [[ "$autostart" == "y" || "$autostart" == "Y" ]]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST_FILE="$PLIST_DIR/com.matrix-console.autostart.plist"
    mkdir -p "$PLIST_DIR"

    cat > "$PLIST_FILE" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.matrix-console.autostart</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_DIR/matrix-app</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>MATRIX_HOME</key>
    <string>$MATRIX_HOME</string>
  </dict>
</dict>
</plist>
PLIST
    echo -e "  ${GREEN}✓${NC} LaunchAgent installed"
  fi
fi

echo ""

# Step 9: Start Matrix
echo -e "${BOLD}Starting Matrix...${NC}"
export PATH="$BIN_DIR:$PATH"
"$BIN_DIR/matrix-app" start

echo ""
echo -e "${GREEN}${BOLD}Matrix is ready!${NC}"
echo ""
echo -e "  Desktop:  ${BOLD}http://localhost:${MATRIX_PORT:-7778}/desktop.html${NC}"
echo -e "  Mobile:   ${BOLD}http://localhost:${MATRIX_PORT:-7778}/${NC}"
echo ""

# Detect LAN IP for phone access
LAN_IP=""
if [[ "$(uname)" == "Darwin" ]]; then
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || true)
elif command -v hostname &>/dev/null; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
if [ -n "$LAN_IP" ]; then
  echo -e "  Phone (same WiFi): ${BOLD}http://${LAN_IP}:${MATRIX_PORT:-7778}/${NC}"
fi

echo ""
echo -e "  ${DIM}Commands:${NC}"
echo -e "    matrix add <name> <path>   — Add a project"
echo -e "    matrix up                  — Start all Claude sessions"
echo -e "    matrix list                — Show all sessions"
echo -e "    matrix-app stop            — Stop the web server"
echo ""
echo -e "  ${DIM}Restart your shell or run:${NC} source $SHELL_RC"
