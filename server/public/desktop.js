// Matrix desktop client — shared state, project selection, the tmux stream and input.
// The sidebar lives in desktop-sidebar.js, the output panel in desktop-output.js and the
// composer/PTT in desktop-compose.js; the transcript, copy and brief surfaces are shared
// with mobile (matrix-*.js).

let ws = null;
let currentSession = null;
let sessions = [];
let recentProjects = [];        // inactive projects shown as faded rows
let sessionAttention = {};      // which sessions need attention
let dismissed = {};             // dismissed sessions
let detectedPorts = [];
let switchToastTimer = null;
let switchToastSession = null;

const stripAnsi = MatrixTranscript.stripAnsi;
const filterStatusLines = MatrixTranscript.filterStatusLines;

let copyUi = null;
const transcript = MatrixTranscript.createTranscript({
  viewer: document.getElementById('terminal'),
  onStatus: () => { if (copyUi) copyUi.renderBar(); },
  onRefreshNeeded: () => { if (currentSession) connectWS(currentSession); },
});
copyUi = MatrixCopy.install({ transcript });
const briefView = MatrixBrief.create({});

// ── Project Selection ──

function selectProject(name) {
  if (currentSession === name) return;

  // Dismiss the alert on the session we're leaving
  if (currentSession && sessionAttention[currentSession]) {
    dismissSession(currentSession);
    delete sessionAttention[currentSession];
  }

  currentSession = name;
  detectedPorts = [];
  const session = sessions.find(s => s.name === name);

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('chat-view').style.display = 'flex';
  document.getElementById('chat-title').textContent = sessionLabel(session) || name;

  updateChatStatus();

  // A fresh open is a new epoch: staged data and callbacks from the previous session die.
  transcript.clear();
  if (copyUi) copyUi.hide();
  // Desktop always streams the session's auto-detected window, so it sends no override.
  if (briefView) briefView.open(name, '');

  connectWS(name);
  renderSidebar();
}

// ── WebSocket ──

function connectWS(session) {
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
    ws = null;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/?session=${encodeURIComponent(session)}`);
  const socket = ws;
  // ADVANCED, not merely read: nulling the dead socket's handlers above does not retire a
  // callback that was already dispatched, and an automatic reconnect never calls clear(),
  // so without this the new connection would share the old one's token. newEpoch() leaves
  // the DOM and any staged/protected state alone.
  const token = transcript.newEpoch();

  ws.onopen = () => { ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })); };

  // The server sends the pane's full scrollback as the first output of every connection, so
  // the first output of a reconnect replaces the view instead of appending a second copy.
  let awaitingScrollbackDump = true;

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') {
        const clean = filterStatusLines(stripAnsi(msg.data).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
        transcript.output(clean, awaitingScrollbackDump, token);
        awaitingScrollbackDump = false;
        scanTerminalForOutputs(clean);
      } else if (msg.type === 'screen') {
        transcript.screen(filterStatusLines(stripAnsi(msg.data)), token);
      } else if (msg.type === 'stream-target') {
        // Pin the brief to the pane this connection is actually streaming. A superseded
        // connection must not re-point the brief at its own old window.
        if (briefView && currentSession === session && transcript.isCurrent(token)) {
          briefView.bindWindow(session, msg.window || '');
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    // Only the live connection may schedule a reconnect, and only if it is still live when
    // the timer fires.
    if (ws !== socket || currentSession !== session) return;
    setTimeout(() => { if (ws === socket && currentSession === session) connectWS(session); }, 1500);
  };
}

// ── Text Input ──

function sendText() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !currentSession) return;
  if (ws && ws.readyState === 1) {
    transcript.echo(text);
    ws.send(JSON.stringify({ type: 'input', data: text + '\r' }));
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('slash-autocomplete').style.display = 'none';
    delete sessionAttention[currentSession];
    updateChatStatus();
    renderSidebar();
  }
}

function updateChatStatus() {
  if (!currentSession) return;
  const statusEl = document.getElementById('chat-status');
  if (sessionAttention[currentSession]) {
    statusEl.textContent = 'Waiting';
    statusEl.className = 'waiting';
  } else {
    statusEl.textContent = 'Processing';
    statusEl.className = 'processing';
  }
}

// ── SSE Notifications ──

function setupSSE() {
  const source = new EventSource('/api/notifications/stream');
  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type !== 'notification') return;

      // Only a server-resolved tmux session identifies a row; an unresolved alert never
      // highlights or switches to a different project.
      const session = typeof data.targetSession === 'string' ? data.targetSession : '';
      if (!session) return;
      const wasAlreadyWaiting = sessionAttention[session];
      sessionAttention[session] = true;
      // Only undismiss for genuinely NEW alerts — don't override the user's dismiss
      if (!wasAlreadyWaiting) undismissSession(session);
      renderSidebar();
      updateChatStatus();
      // Show the switch toast only for newly waiting projects
      if (!wasAlreadyWaiting && session !== currentSession) showSwitchToast(session, data.project);
    } catch {}
  };
}

// ── Keyboard Shortcuts ──

document.getElementById('chat-send').addEventListener('click', sendText);

// Ctrl+1-9 to switch projects
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key) - 1;
    if (sessions[idx]) {
      e.preventDefault();
      selectProject(sessions[idx].name);
    }
  }
});

// ── Init ──

loadSessions();
setupSSE();
setupPTT();
setInterval(loadSessions, 5000);
