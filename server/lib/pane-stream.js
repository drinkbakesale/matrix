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
//   2. A name is never used AS a tmux target. tmux's target syntax is `session:window.pane`,
//      so `A:v2.1` addresses window `v2`, pane 1 — a pane the client never asked for. Names
//      are therefore only ever compared, by exact equality, against the names tmux itself
//      reported; what gets targeted is the `$id`/`@id` tmux issued for the match. Refusing
//      names containing `.` or `:` is NOT the protection — tmux allows both in a window
//      name, and refusing them would make real windows unreachable.
// So the only bound left is the one argv itself imposes, plus a sane length.
const SAFE_NAME = /^[^\u0000-\u001f]{1,200}$/;

function tmux(args, extra) {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...extra });
}

// Claude Code reads a burst of keystrokes that arrives in one write as a paste, and a return
// at the end of a paste is not a submit. Typing "message + \r" as one send-keys call left
// messages of roughly 90+ characters sitting fully typed in the input box (measured on a live
// session: 30/60 submitted, 90/120/800 stuck). So the text and the return go as two separate
// writes with a short gap — measured to submit at every length tried, up to 3000 characters.
const ENTER_GAP_MS = 80;
const hexKeys = text => Buffer.from(text).toString('hex').match(/.{2}/g).map(h => '0x' + h);

async function typeInto(target, data, { run = tmux, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const text = String(data);
  if (!text) return;
  const submits = text.length > 1 && text.endsWith('\r');
  const body = submits ? text.slice(0, -1) : text;
  run(['send-keys', '-t', target, '-H', ...hexKeys(body)]);
  if (submits) {
    await wait(ENTER_GAP_MS);
    run(['send-keys', '-t', target, '-H', '0x0d']);
  }
}

const isClaudeCmd = cmd => cmd.includes('claude') || /^\d+\.\d+\.\d+$/.test(cmd.trim());

// Listing rows put the NAME last, so a name containing `|` cannot shift the other columns.
function rows(out, fields) {
  return out.trim().split('\n').filter(Boolean).map(line => {
    const parts = [];
    let rest = line;
    for (let i = 0; i < fields; i += 1) {
      const at = rest.indexOf('|');
      if (at === -1) { parts.push(rest); rest = ''; continue; }
      parts.push(rest.slice(0, at));
      rest = rest.slice(at + 1);
    }
    return [...parts, rest];
  });
}

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

    // Resolve before using. The session name is matched by exact equality against the live
    // list, which answers "does this session exist" and yields the id everything below is
    // addressed by; the pane enumeration — which already had to happen to find the Claude
    // window — answers "is the requested window real" and yields its id. A client therefore
    // cannot name a pane into existence, and cannot name one it did not ask for either.
    let sessionId = '';
    try {
      const hit = rows(tmux(['list-sessions', '-F', '#{session_id}|#{session_name}']), 1)
        .find(([, name]) => name === session);
      if (hit) sessionId = hit[0];
    } catch { sessionId = ''; }
    if (!sessionId) {
      ws.close(1008, 'no such tmux session');
      return;
    }
    let panes = [];
    try {
      panes = rows(tmux(['list-panes', '-s', '-t', sessionId, '-F', '#{window_id}|#{pane_current_command}|#{window_name}']), 2);
    } catch { panes = []; }
    if (!panes.length) {
      ws.close(1008, 'no such tmux session');
      return;
    }
    let windowId = '';
    if (window) {
      const hit = panes.find(([, , name]) => name === window);
      if (!hit) {
        ws.close(1008, 'no such tmux window in that session');
        return;
      }
      windowId = hit[0];
    } else {
      const claudePane = panes.find(([, cmd]) => isClaudeCmd(cmd || ''));
      if (claudePane) { window = claudePane[2]; windowId = claudePane[0]; }
    }

    // The tmux identifier for the resolved window, or for the session when no window was
    // resolved — the same fallback as before, expressed unambiguously.
    const target = windowId || sessionId;
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

    // Inputs are typed strictly in order: a second message never interleaves with the first
    // one's text-then-return pair.
    let typing = Promise.resolve();
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'input') {
          typing = typing.then(() => typeInto(target, msg.data)).catch(err => {
            console.error(`[pane-stream] typing into ${session} failed: ${err.message}`);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input-error', message: err.message }));
          });
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

module.exports = { attach, typeInto, ENTER_GAP_MS };
