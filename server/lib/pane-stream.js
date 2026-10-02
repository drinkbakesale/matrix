'use strict';
// WebSocket: tmux pane streaming via capture-pane polling.
//
// The phone is a LOG VIEWER, not a screen mirror: the full scrollback is sent on every
// connection and growth is sent as `output`; a same-length change is sent as `screen`, which
// the client treats as a replaceable block. Extracted from server.js with no behaviour
// change — including the fact that a failed capture is flattened into an empty string. That
// is a real defect (the terminal silently stops updating), but fixing it is audit
// improvement 3, a separate build, not something this extraction may change.

const { execSync } = require('child_process');
const attention = require('./attention');

const POLL_MS = 100;
const MAX_CAPTURE_ERRORS = 20;

function attach(wss, { port }) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const session = url.searchParams.get('session');
    let window = url.searchParams.get('window') || '';

    if (!session) {
      ws.close(1008, 'session parameter required');
      return;
    }

    // Auto-detect the window with claude running
    if (!window) {
      try {
        const panes = execSync(
          `tmux list-panes -s -t '${session}' -F '#{window_name}|#{pane_current_command}' 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim().split('\n');
        const claudePane = panes.find(p => {
          const cmd = p.split('|')[1] || '';
          return cmd.includes('claude') || /^\d+\.\d+\.\d+$/.test(cmd.trim());
        });
        if (claudePane) window = claudePane.split('|')[0];
      } catch {}
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
        const info = execSync(
          `tmux display-message -t '${target}' -p '#{pane_width}|#{pane_height}' 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();
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
        return execSync(`tmux capture-pane -t '${target}' -p -S - 2>/dev/null`, {
          encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        });
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
          const hex = Buffer.from(msg.data).toString('hex').match(/.{2}/g).map(h => '0x' + h).join(' ');
          execSync(`tmux send-keys -t '${target}' -H ${hex} 2>/dev/null`);
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
