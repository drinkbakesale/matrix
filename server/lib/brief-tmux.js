'use strict';
// The process boundary the brief feature talks to tmux through.
//
// Three properties the rest of the brief code depends on:
//   1. Shell-free. Fixed executable, array argv, `shell: false`. A session named
//      `a'; rm -rf ~` is an argument, never a command fragment.
//   2. Asynchronous and bounded. Every call has a timeout and a maxBuffer, so a wedged or
//      enormous tmux can never block the event loop or the HTTP response.
//   3. Explicit about failure. A failed capture throws; it is never flattened into an
//      empty string that would read as "this session has nothing to say".
//
// Window selection deliberately mirrors server/lib/pane-stream.js exactly: an explicitly
// requested window wins, otherwise the window running Claude, otherwise the session with no
// window. The brief must describe the pane the user is actually looking at.

const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_WINDOW_CACHE_ENTRIES = 256;

class TmuxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TmuxError';
    this.code = code;
  }
}

// Claude shows up as `claude` or as a bare version number like `2.1.85` — the same
// predicate pane-stream uses to pick a window.
const isClaudeCmd = cmd => cmd.includes('claude') || /^\d+\.\d+\.\d+$/.test(cmd.trim());

function createTmux({ execFileImpl = execFile, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, binary = 'tmux' } = {}) {
  return {
    binary,
    run(args) {
      return new Promise((resolve, reject) => {
        execFileImpl(binary, args, { timeout: timeoutMs, maxBuffer, encoding: 'utf8', windowsHide: true },
          (err, stdout) => {
            if (err) {
              const code = err.killed || err.signal ? 'tmux_timeout' : 'tmux_failed';
              // The command is safe to name; its output may contain private pane text.
              reject(new TmuxError(code, `tmux ${args[0]} ${code === 'tmux_timeout' ? 'timed out' : 'failed'}`));
              return;
            }
            resolve(String(stdout || ''));
          });
      });
    },
  };
}

function parseSessions(raw) {
  return raw.split('\n').filter(Boolean).map(line => {
    const [name, sessionId, createdAt] = line.split('|');
    return { name, sessionId: sessionId || '', createdAt: parseInt(createdAt, 10) || null };
  });
}

function parseWindows(raw) {
  return raw.split('\n').filter(Boolean).map(line => {
    const [index, windowName, active, command] = line.split('|');
    return {
      index: parseInt(index, 10),
      name: windowName || '',
      active: active === '1',
      command: command || '',
    };
  });
}

// Resolves the exact live incarnation plus the exact window the client is streaming.
// Resolution ALWAYS revalidates the live incarnation. A tmux name is not an identity: kill
// `41` and start another `41` a second later and it is a different session with different
// private content, so a name-keyed cache with any time-to-live can serve the dead session's
// brief and let an edit address its record. The incarnation probe therefore has no TTL —
// concurrent callers share one in-flight process call, and that is the only sharing.
//
// What IS cached is the per-window enumeration, keyed by the incarnation it belongs to. That
// key changes the moment the session is recreated, so the cache cannot outlive its subject.
function createSessionResolver({ tmux, maxWindowEntries = MAX_WINDOW_CACHE_ENTRIES } = {}) {
  const windowCache = new Map();   // `${name}|${sessionId}|${createdAt}` -> windows[]
  let sessionsInFlight = null;

  // No TTL: every resolve confirms the session still exists and is still this incarnation.
  function liveSessions() {
    if (sessionsInFlight) return sessionsInFlight;
    sessionsInFlight = tmux.run(['list-sessions', '-F', '#{session_name}|#{session_id}|#{session_created}'])
      .then(parseSessions)
      .catch(() => [])
      .finally(() => { sessionsInFlight = null; });
    return sessionsInFlight;
  }

  async function windowsFor(name, incarnationKey) {
    if (windowCache.has(incarnationKey)) return windowCache.get(incarnationKey);
    let windows = [];
    try {
      windows = parseWindows(await tmux.run([
        'list-panes', '-s', '-t', name, '-F', '#{window_index}|#{window_name}|#{window_active}|#{pane_current_command}',
      ]));
    } catch {
      windows = [];
    }
    if (windowCache.size >= maxWindowEntries) windowCache.delete(windowCache.keys().next().value);
    windowCache.set(incarnationKey, windows);
    return windows;
  }

  return {
    async resolve(name, windowName) {
      const hit = (await liveSessions()).find(s => s.name === name);
      if (!hit) return null;
      const incarnationKey = `${hit.name}\u0000${hit.sessionId}\u0000${hit.createdAt}`;
      const windows = await windowsFor(name, incarnationKey);

      // Identical to pane-stream: requested window, else the Claude window, else no window.
      let window = '';
      if (windowName) {
        window = windowName;
      } else {
        const claude = windows.find(w => isClaudeCmd(w.command));
        if (claude) window = claude.name;
      }
      const chosen = windows.find(w => w.name === window);
      return {
        name: hit.name,
        sessionId: hit.sessionId,
        createdAt: hit.createdAt,
        window,
        windowIndex: chosen ? chosen.index : null,
        target: window ? `${hit.name}:${window}` : hit.name,
      };
    },
    invalidate() { windowCache.clear(); },
  };
}

// Two bounded captures per refresh: the tail (what is happening now) and, when the pane has
// scrolled past it, a slice of the very start of the history (what the session set out to
// do). Without the second one a long session loses its broad goal as soon as the opening
// turns roll out of the tail window.
function createPaneCapture({ tmux, recentLines = 400, earlyLines = 120 }) {
  return {
    async capture(identity) {
      const target = identity.target || identity.name;
      const recent = await tmux.run(['capture-pane', '-t', target, '-p', '-S', `-${recentLines}`]);
      let early = '';
      let historySize = 0;
      try {
        historySize = parseInt((await tmux.run(['display-message', '-p', '-t', target, '#{history_size}'])).trim(), 10) || 0;
      } catch {
        historySize = 0;
      }
      if (historySize > recentLines) {
        const end = -(historySize - earlyLines);
        early = await tmux.run(['capture-pane', '-t', target, '-p', '-S', `-${historySize}`, '-E', `${end}`]);
      }
      return { recent, early, historySize, target };
    },
  };
}

module.exports = {
  TmuxError, createTmux, createSessionResolver, createPaneCapture,
  parseSessions, parseWindows, isClaudeCmd,
  DEFAULT_TIMEOUT_MS, MAX_WINDOW_CACHE_ENTRIES,
};
