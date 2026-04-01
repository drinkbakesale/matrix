# Matrix

Multi-session Claude Code manager. Monitor, control, and switch between Claude sessions from your browser or phone.

![Matrix Desktop](https://github.com/user-attachments/assets/placeholder.png)

## What it does

Matrix gives you a single dashboard to manage all your Claude Code sessions:

- **See all sessions at once** — every tmux session with Claude running appears in the sidebar
- **Smart project detection** — automatically identifies which project each session is working on, even when Claude starts from `~`
- **Send input from the browser** — type responses without switching terminal windows
- **Push notifications** — get alerted on your phone when Claude needs input (Web Push, no third-party services)
- **Mobile PWA** — add to your phone's home screen for native app-like access
- **Recent projects** — inactive projects appear as faded rows at the bottom for quick relaunch

## Requirements

- **Claude Code CLI** — requires a Claude subscription ([install](https://docs.anthropic.com/en/docs/claude-code))
- **Node.js** 18+
- **tmux**
- **ffmpeg** (optional, for voice input)

## Install

```bash
git clone https://github.com/thebilllabs/matrix.git
cd matrix
./install.sh
```

The installer will:
1. Check and install dependencies (via brew on macOS)
2. Generate push notification keys (VAPID)
3. Set up config files in `~/.matrix/`
4. Install Claude Code hooks for project auto-detection
5. Add CLI tools to your PATH
6. Optionally set up autostart on login (macOS)
7. Start Matrix

## Usage

### Desktop

Open **http://localhost:7778/desktop.html** in your browser.

### Phone

Open **http://YOUR_LAN_IP:7778/** on your phone (same WiFi network). Add to Home Screen for PWA experience.

### CLI

```bash
# Add a project
matrix add myproject ~/Projects/myproject
matrix describe myproject "My awesome project"

# Start Claude sessions for all configured projects
matrix up

# Start one specific project
matrix up myproject

# List all sessions
matrix list

# Attach to a session in your terminal
matrix attach myproject

# Stop a session
matrix down myproject

# Stop the web server
matrix-app stop

# Start the web server
matrix-app start
```

## How it works

Matrix runs a lightweight Node.js server that:

1. **Monitors tmux sessions** — polls for sessions running Claude Code
2. **Detects projects** — uses a priority chain to identify what each session is working on:
   - `@matrix_project` tmux variable (set automatically by the PostToolUse hook)
   - Path registry matching against file paths in recent scrollback
   - Pane working directory
   - Scrollback heuristics
   - tmux session name
3. **Streams output** — captures tmux pane content via polling and sends it to the browser over WebSocket
4. **Sends notifications** — Web Push alerts when Claude asks a question or finishes a task

## Configuration

### Projects

Edit `~/.matrix/projects.conf`:

```
# name|path|mode|roles|description
myproject|~/Projects/myproject|server||My web app
another|~/Desktop/another|server||CLI tool
```

Or use the CLI: `matrix add myproject ~/Projects/myproject`

### Path registry

Edit `~/.matrix/project-paths.conf` to map file paths to project names. This helps Matrix identify sessions that work on files outside their tmux working directory:

```
~/Projects/my-app/src|my-app
~/.my-tool|my-tool
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MATRIX_HOME` | `~/.matrix` | Config and data directory |
| `MATRIX_PORT` | `7778` | Web server port |
| `PYTHON_PATH` | `python3` | Python binary for Whisper transcription |

## Uninstall

```bash
./uninstall.sh
```

Removes hooks, configs, LaunchAgent, and PATH entries. Does not delete the repo.

## License

MIT
