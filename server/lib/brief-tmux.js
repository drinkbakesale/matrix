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
//   4. Unambiguous about WHICH pane. A display name is only ever compared, by exact
//      equality, against the names tmux itself reported; what is then targeted is the
//      `$id`/`@id` tmux issued for the match. tmux target syntax is `session:window.pane`,
//      so a target built out of names makes a window legitimately called `v2.1` mean
//      "window v2, pane 1" — a different pane, belonging to different work.
//
// Window selection deliberately mirrors server/lib/pane-stream.js exactly: an explicitly
// requested window wins, otherwise the window running Claude, otherwise the session with no
// window. The brief must describe the pane the user is actually looking at.

const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

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

// Every listing puts the NAME last, because a name is the one field that can contain the
// separator: tmux happily holds a window called `a|b`, and splitting such a row on `|`
// would silently mis-read it. Everything before the name is an id, an index or a flag.
const SESSION_FORMAT = '#{session_id}|#{session_created}|#{session_name}';
const PANE_FORMAT = '#{window_index}|#{window_id}|#{window_active}|#{pane_current_command}|#{window_name}';

// Splits a listing row into `fields` fixed leading columns plus the trailing name.
function splitRow(line, fields) {
  const parts = [];
  let rest = line;
  for (let i = 0; i < fields; i += 1) {
    const at = rest.indexOf('|');
    if (at === -1) { parts.push(rest); rest = ''; continue; }
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return parts;
}

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
    const [sessionId, createdAt, name] = splitRow(line, 2);
    return { name, sessionId: sessionId || '', createdAt: parseInt(createdAt, 10) || null };
  });
}

function parseWindows(raw) {
  return raw.split('\n').filter(Boolean).map(line => {
    const [index, windowId, active, command, name] = splitRow(line, 4);
    return {
      index: parseInt(index, 10),
      windowId: windowId || '',
      name: name || '',
      active: active === '1',
      command: command || '',
    };
  });
}

// Resolves the exact live incarnation plus the exact window the client is streaming.
// Resolution caches NOTHING across calls. Two separate things are mutable here and both
// have already produced a leak when assumed stable:
//
//   1. A tmux name is not an identity. Kill `41` and start another `41` a second later and
//      it is a different session with different private content, so a name-keyed cache with
//      any time-to-live can serve the dead session's brief and let an edit address it.
//   2. An incarnation does not freeze its windows. The user quits Claude in one window and
//      starts it in another; pane-stream follows it, and a window list cached against the
//      incarnation does not — so the brief would keep describing, and keep serving, the
//      window the user is no longer looking at.
//
// So every resolve re-reads both. The only sharing is in-flight coalescing, which cannot
// return anything older than the call it joins: two awaited, bounded tmux calls per resolve.
function createSessionResolver({ tmux } = {}) {
  const inFlight = new Map();

  // Joins an identical probe that is already running; never returns a completed past result.
  function coalesce(key, run) {
    if (inFlight.has(key)) return inFlight.get(key);
    const job = run().finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  }

  function liveSessions() {
    return coalesce('sessions', () => tmux
      .run(['list-sessions', '-F', SESSION_FORMAT])
      .then(parseSessions)
      .catch(() => []));
  }

  // Enumerated through the session's own tmux id, never through the display name the client
  // sent. The name has already done its only job by this point — matching a live session —
  // and a name is not a safe target: tmux reads `:` and `.` in one as target syntax.
  function liveWindows(sessionId) {
    return coalesce(`windows\u0000${sessionId}`, () => tmux
      .run(['list-panes', '-s', '-t', sessionId, '-F', PANE_FORMAT])
      .then(parseWindows)
      .catch(() => []));
  }

  return {
    // `options.authoritative` means the caller is reporting a binding an open stream
    // already resolved, not asking for one. The distinction only matters for an EMPTY
    // window, and there it is the whole game: a connection that found no Claude keeps the
    // bare session as its target, and "" from that connection means "the session itself",
    // not "please go and find Claude". Rediscovering for it would point the brief at a
    // window the transcript is not showing the moment Claude starts somewhere else.
    async resolve(name, windowName, options) {
      const authoritative = !!(options && options.authoritative);
      if (typeof name !== 'string' || name === '') return null;
      // Exact equality against the names tmux itself reported. Nothing is pattern-matched,
      // escaped or sanitised: a name that is not live simply has nowhere to resolve to, and
      // a session with no id cannot be addressed unambiguously, so neither resolves.
      const hit = (await liveSessions()).find(s => s.name === name);
      if (!hit || !hit.sessionId) return null;
      const windows = await liveWindows(hit.sessionId);

      // Identical to pane-stream: requested window, else the Claude window, else no window
      // — except that an authoritative empty window skips the discovery step, exactly as
      // the already-connected stream does.
      let window = '';
      if (windowName) {
        window = windowName;
      } else if (!authoritative) {
        const claude = windows.find(w => isClaudeCmd(w.command));
        if (claude) window = claude.name;
      }
      const chosen = window === '' ? null : windows.find(w => w.name === window);
      // The target is a tmux IDENTIFIER, never a name. `A:v2.1` is not an unusual name that
      // needs escaping — tmux reads it as window `v2`, pane 1, which is somebody else's
      // work — whereas `@7` and `$3` mean exactly one thing and are what tmux just told us
      // this window and session are. The session id is the no-window fallback, matching the
      // old bare-session target. A window we could not resolve an id for yields no target
      // at all; the service reports that rather than guessing a readable one.
      const target = chosen ? (chosen.windowId || null) : (window === '' ? hit.sessionId : null);
      return {
        name: hit.name,
        sessionId: hit.sessionId,
        createdAt: hit.createdAt,
        window,
        windowId: chosen ? chosen.windowId : '',
        windowIndex: chosen ? chosen.index : null,
        // A client streaming a window that has since been closed or renamed is asking about
        // a pane that no longer exists. Saying so is better than capturing something else
        // and reporting whatever tmux does with it.
        windowKnown: window === '' ? true : !!chosen,
        // Carried so a later re-resolve for the same open stream repeats this decision
        // rather than falling back to discovery.
        bound: authoritative,
        target,
      };
    },
    // Nothing persists between resolves, so there is nothing to invalidate. Kept as a no-op
    // so no caller can come to depend on manual invalidation for correctness.
    invalidate() {},
  };
}

// Two bounded captures per refresh: the tail (what is happening now) and, when the pane has
// scrolled past it, a slice of the very start of the history (what the session set out to
// do). Without the second one a long session loses its broad goal as soon as the opening
// turns roll out of the tail window.
function createPaneCapture({ tmux, recentLines = 400, earlyLines = 120 }) {
  return {
    async capture(identity) {
      // No fallback to the session name: the only thing this may capture is the identifier
      // the resolver produced from the live listing.
      const target = identity.target;
      if (!target) throw new TmuxError('unresolved_target', 'that pane has no resolved tmux identifier');
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
  parseSessions, parseWindows, isClaudeCmd, splitRow,
  SESSION_FORMAT, PANE_FORMAT, DEFAULT_TIMEOUT_MS,
};
