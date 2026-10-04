'use strict';
// WebSocket: tmux pane streaming via capture-pane polling.
//
// The phone is a LOG VIEWER, not a screen mirror: the full scrollback is sent on every
// connection and growth is sent as `output`; a same-length change is sent as `screen`, which
// the client treats as a replaceable block. Extracted from server.js with no behaviour
// change — including the fact that a failed capture is flattened into an empty string. That
// is a real defect (the terminal silently stops updating), but fixing it is audit
// improvement 3, a separate build, not something this extraction may change.

const { execFileSync } = require('child_process');
const attention = require('./attention');

const POLL_MS = 100;
const MAX_CAPTURE_ERRORS = 20;

// `session` and `window` arrive in the WebSocket query string, so they are attacker-shaped
// input. Two separate protections, because they stop two different things:
//   1. Every tmux call below is an argument vector, never a shell string. A name containing
//      a quote or a semicolon is one argument, not a command.
//   2. tmux's own target syntax is `session:window.pane`, so a name carrying `:` or `.`
//      could still address a pane the client never asked for even through argv. Names that
//      could do that are refused outright rather than sanitised.
const SAFE_NAME = /^[^\u0000-\u001f:.]{1,200}$/;

function tmux(args, extra) {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...extra });
}

const isClaudeCmd = cmd => cmd.includes('claude') || /^\d+\.\d+\.\d+$/.test(cmd.trim());

function attach(wss, { port }) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const session = url.searchParams.get('session');
    let window = url.searchParams.get('window') || '';

    if (!session) {
      ws.close(1008, 'session parameter required');
      return;
    }
    if (!SAFE_NAME.test(session) || (window && !SAFE_NAME.test(window))) {
      ws.close(1008, 'invalid session or window name');
      return;
    }

    // Resolve the target before using it. This enumeration already had to happen to find the
    // Claude window; doing it unconditionally also answers "does this session exist" and
    // "is the requested window real" from data we were fetching anyway, so a client cannot
    // name a pane into existence. An empty or failed listing means we cannot resolve
    // anything, and the connection is refused rather than pointed somewhere arbitrary.
    let panes = [];
    try {
      panes = tmux(['list-panes', '-s', '-t', session, '-F', '#{window_name}|#{pane_current_command}'])
        .trim().split('\n').filter(Boolean);
    } catch { panes = []; }
    if (!panes.length) {
      ws.close(1008, 'no such tmux session');
      return;
    }
    const names = panes.map(p => p.split('|')[0]);
    if (window && !names.includes(window)) {
      ws.close(1008, 'no such tmux window in that session');
      return;
    }
    if (!window) {
      const claudePane = panes.find(p => isClaudeCmd(p.split('|')[1] || ''));
      if (claudePane) window = claudePane.split('|')[0];
    }

    const target = window ? `${session}:${window}` : session;
    console.log(`[ws] streaming tmux target: ${target}`);

    // This connection's target is now fixed for its lifetime, but the window Claude runs in
    // is not: the user can quit it in one window and start it in another without the stream
    // noticing. Anything else that describes "this session" has to be told which pane is
    // actually on screen, or it drifts off to whichever window Claude moved to. Announced on
    // every connection, so an automatic reconnect re-synchronises the binding.
    function sendStreamTarget() {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stream-target', session, window, target }));
    }

    let pollInterval = null;
    let captureErrors = 0;
    let lastLineCount = 0;
    let lastFullText = '';

    // Never resize the pane — the local iTerm2 owns its size.
    function getPaneSize() {
      try {
        const info = tmux(['display-message', '-t', target, '-p', '#{pane_width}|#{pane_height}']).trim();
        const [w, h] = info.split('|');
        return { cols: parseInt(w) || 80, rows: parseInt(h) || 24 };
      } catch {
        return { cols: 80, rows: 24 };
      }
    }

    // maxBuffer must be large — a long Claude session's scrollback easily exceeds Node's
    // 1 MB execSync default and would otherwise fail with ENOBUFS (the empty-terminal
    // symptom: pane-size sent, output never sent).
    function captureAll() {
      try {
        return tmux(['capture-pane', '-t', target, '-p', '-S', '-'], { maxBuffer: 64 * 1024 * 1024 });
      } catch {
        return '';
      }
    }

    function initStreaming() {
      sendStreamTarget();
      const size = getPaneSize();
      ws.send(JSON.stringify({ type: 'pane-size', cols: size.cols, rows: size.rows }));

      // Always send the full scrollback on connect — the client replaces its viewer with
      // this first output, for a fresh open and an automatic reconnect alike.
      const all = captureAll();
      if (all.trim()) ws.send(JSON.stringify({ type: 'output', data: all.replace(/\n/g, '\r\n') }));
      lastLineCount = all.split('\n').length;
      lastFullText = all;

      let lastVisibleText = '';
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(() => {
        if (ws.readyState !== 1) { clearInterval(pollInterval); return; }
        try {
          const current = captureAll();
          captureErrors = 0;
          if (current === lastFullText) return;

          const currentLines = current.split('\n');
          if (currentLines.length > lastLineCount) {
            // Scrollback grew — send genuinely new lines
            ws.send(JSON.stringify({ type: 'output', data: currentLines.slice(lastLineCount).join('\r\n') + '\r\n' }));
            lastVisibleText = '';
          } else if (currentLines.length === lastLineCount) {
            // Same line count, changed content — a visible screen update
            const size = getPaneSize();
            const visibleText = currentLines.slice(-size.rows).join('\n');
            if (visibleText !== lastVisibleText) {
              ws.send(JSON.stringify({ type: 'screen', data: visibleText }));
              lastVisibleText = visibleText;
            }
          }
          lastLineCount = currentLines.length;
          lastFullText = current;
        } catch {
          captureErrors++;
          if (captureErrors > MAX_CAPTURE_ERRORS) {
            clearInterval(pollInterval);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'exit', code: 0 }));
              ws.close();
            }
          }
        }
      }, POLL_MS);
    }

    initStreaming();

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'input') {
          const hex = Buffer.from(msg.data).toString('hex').match(/.{2}/g).map(h => '0x' + h);
          tmux(['send-keys', '-t', target, '-H', ...hex]);
          attention.clearForSession(session);   // the user just answered
        } else if (msg.type === 'resize') {
          const size = getPaneSize();
          ws.send(JSON.stringify({ type: 'pane-size', cols: size.cols, rows: size.rows }));
        }
      } catch {}
    });

    // Ping keepalive every 15s to prevent mobile timeout
    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) { try { ws.ping(); } catch {} }
      else clearInterval(pingInterval);
    }, 15000);

    ws.on('close', () => {
      console.log(`[ws] client disconnected from ${target}`);
      clearInterval(pollInterval);
      clearInterval(pingInterval);
    });
  });
}

module.exports = { attach };
