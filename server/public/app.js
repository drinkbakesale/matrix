// Matrix mobile client — session list, navigation intents, terminal stream and input.
// Notifications live in app-notifications.js, the picker/inbox/TALK panels in app-panels.js,
// and the transcript/copy/brief surfaces are shared with desktop (matrix-*.js).

let ws = null;
let currentSession = null;
let currentWindowName = '';
let lastSessionList = [];

const stripAnsi = MatrixTranscript.stripAnsi;
const filterStatusLines = MatrixTranscript.filterStatusLines;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Row label: canonical project name, plus an instance suffix when sessions share a project.
function sessionLabel(s) {
  if (!s) return '';
  if (s.projectName) return s.instanceSuffix ? `${s.projectName} · ${s.instanceSuffix}` : s.projectName;
  return s.displayName || s.name;
}

async function fetchSessions() {
  const res = await fetch('/api/sessions');
  const { sessions } = await res.json();
  lastSessionList = Array.isArray(sessions) ? sessions : [];
  return lastSessionList;
}

// A resolved targetSession is an opaque tmux routing name: match it exactly and
// case-sensitively. No project-label or case-folded fallback, because a stale target that
// happens to equal another session's project name (or its name in different case) would
// otherwise open a different terminal. Server ingestion owns any label resolution.
function findSessionForTarget(sessions, target) {
  if (!Array.isArray(sessions) || !target) return null;
  return sessions.find(s => s.name === target) || null;
}

// ── Navigation intents ──
// A notification tap (URL parameter or service-worker message) and the pending-alert
// auto-open can be in flight at once, each awaiting its own /api/sessions response. Ordering
// those responses decides nothing: every navigation claims a generation, a claim invalidates
// older ones, and each navigation re-checks its generation immediately before its final
// terminal action, so a slow loser can never overwrite the winner's terminal.
const INTENT_PRIORITY = { 'pending-alert': 1, explicit: 2 };
let activeNavigation = { generation: 0, priority: 0, settled: true };

// Claim the right to navigate, or return null when a newer or stronger intent owns it.
// `sinceGeneration` makes a claim conditional: the pending-alert path passes the generation it
// observed when its request started, so any tap that claimed while that request was
// outstanding refuses the claim — however late the pending response arrives.
function claimNavigation(source, sinceGeneration) {
  const priority = INTENT_PRIORITY[source] || INTENT_PRIORITY['pending-alert'];
  if (typeof sinceGeneration === 'number' && sinceGeneration !== activeNavigation.generation) return null;
  if (!activeNavigation.settled && priority < activeNavigation.priority) return null;
  activeNavigation = { generation: activeNavigation.generation + 1, priority, settled: false };
  return activeNavigation.generation;
}

function navigationIsCurrent(generation) {
  return generation === activeNavigation.generation;
}

function settleNavigation(generation) {
  if (navigationIsCurrent(generation)) activeNavigation.settled = true;
}

// Open the terminal a notification targets once session data is loaded; when the target is
// missing or no longer live, show the project list instead of any other terminal.
async function openNotificationTarget(target, generation) {
  const claim = typeof generation === 'number' ? generation : claimNavigation('explicit');
  if (claim === null) return;
  const wanted = typeof target === 'string' ? target.trim() : '';
  let match = null;
  if (wanted) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        match = findSessionForTarget(await fetchSessions(), wanted);
        break;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  // A newer intent claimed navigation while this one was waiting; leave its terminal alone.
  if (!navigationIsCurrent(claim)) return;
  if (match) openTerminal(match.name);
  else closeTerminal();
  settleNavigation(claim);
}

// ── Dismissed Sessions ──

function getDismissed() {
  try { return JSON.parse(localStorage.getItem('dismissed') || '{}'); } catch { return {}; }
}

function dismissSession(name) {
  const d = getDismissed();
  d[name] = Date.now();
  localStorage.setItem('dismissed', JSON.stringify(d));
  // Clear attention server-side so polling doesn't re-highlight
  fetch('/api/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: name }),
  }).catch(() => {});
}

function undismissSession(name) {
  const d = getDismissed();
  delete d[name];
  localStorage.setItem('dismissed', JSON.stringify(d));
}

// ── Session List ──

async function loadSessions() {
  try {
    const sessions = await fetchSessions();
    const container = document.getElementById('sessions');

    if (!sessions || sessions.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--dim)">
          <p style="font-size:48px;margin-bottom:16px">⬡</p>
          <p>No active projects</p>
          <p style="margin-top:8px;font-size:14px">Tap <strong>+</strong> to start one</p>
        </div>`;
      return;
    }

    // Sort: attention (not dismissed) first, then normal, then dismissed at bottom
    const dismissed = getDismissed();
    const sorted = [...sessions].sort((a, b) => {
      const aDismissed = !!dismissed[a.name];
      const bDismissed = !!dismissed[b.name];
      const aAttention = a.needsAttention && !aDismissed;
      const bAttention = b.needsAttention && !bDismissed;
      if (aAttention && !bAttention) return -1;
      if (!aAttention && bAttention) return 1;
      if (aDismissed && !bDismissed) return 1;
      if (!aDismissed && bDismissed) return -1;
      return 0;
    });

    container.innerHTML = sorted.map(s => {
      const isDismissed = !!dismissed[s.name];
      const showAttention = s.needsAttention && !isDismissed;
      const dotClass = showAttention ? 'attention' : (s.claudeRunning ? 'claude' : (s.attached ? 'running' : 'idle'));
      const badge = showAttention ? 'Waiting' : (isDismissed && s.needsAttention ? 'Snoozed' : (s.claudeRunning ? 'Claude' : (s.attached ? 'attached' : `${s.windows} win`)));
      const cardClass = showAttention ? 'session-card attention' : (isDismissed ? 'session-card dismissed' : 'session-card');
      const descHtml = s.description
        ? `<div class="session-desc">${escapeHtml(s.description)}</div>`
        : '';
      return `
        <div class="${cardClass}" data-session="${escapeHtml(s.name)}" data-attention="${s.needsAttention ? '1' : '0'}">
          <div class="session-inner">
            <div class="session-top">
              <span class="session-dot ${dotClass}"></span>
              <span class="session-name">${escapeHtml(sessionLabel(s))}</span>
              <span class="session-badge">${badge}</span>
            </div>
            ${descHtml}
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.session-card').forEach(card => {
      card.addEventListener('click', () => openTerminal(card.dataset.session));
      setupSwipeDismiss(card);
    });
  } catch (err) {
    console.error('loadSessions:', err);
  }
}

function setupSwipeDismiss(card) {
  let startX = 0, startY = 0, currentX = 0, swiping = false;
  const inner = card.querySelector('.session-inner');

  card.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    currentX = 0;
    swiping = false;
    inner.style.transition = 'none';
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    // Only swipe left, and only if horizontal movement dominates
    if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) swiping = true;
    if (swiping && dx < 0) {
      currentX = dx;
      inner.style.transform = `translateX(${dx}px)`;
      inner.style.opacity = Math.max(0.3, 1 + dx / 300);
    }
  }, { passive: true });

  card.addEventListener('touchend', () => {
    if (!swiping) return;
    inner.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    if (currentX < -80) {
      inner.style.transform = 'translateX(-100%)';
      inner.style.opacity = '0';
      setTimeout(() => {
        dismissSession(card.dataset.session);
        loadSessions();
      }, 250);
    } else {
      inner.style.transform = 'translateX(0)';
      inner.style.opacity = '1';
    }
  }, { passive: true });
}

// ── Terminal ──

let copyUi = null;
const transcript = MatrixTranscript.createTranscript({
  viewer: document.getElementById('terminal'),
  onStatus: () => { if (copyUi) copyUi.renderBar(); },
  // The staged buffer filled up while the user held a selection: rather than drop
  // conversation text, reconnect so Resume shows a fresh, complete snapshot.
  onRefreshNeeded: () => { if (currentSession) connectWebSocket(currentSession, currentWindowName); },
});
copyUi = MatrixCopy.install({ transcript });
const briefView = MatrixBrief.create({});

function connectWebSocket(session, windowName) {
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
    ws = null;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/?session=${encodeURIComponent(session)}${windowName ? `&window=${encodeURIComponent(windowName)}` : ''}`;
  ws = new WebSocket(wsUrl);

  // Callbacks from a superseded connection/session are dropped by this token.
  const token = transcript.epoch();

  ws.onopen = () => {
    console.log('[ws] connected to', session);
    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  };

  // The server sends the pane's full scrollback as the first output of every connection.
  // openTerminal() clears the viewer before a fresh open but an automatic reconnect does
  // not, so that dump replaces what is shown instead of appending a second copy.
  let awaitingScrollbackDump = true;

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') {
        const clean = filterStatusLines(stripAnsi(msg.data).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
        transcript.output(clean, awaitingScrollbackDump, token);
        awaitingScrollbackDump = false;
      } else if (msg.type === 'screen') {
        transcript.screen(filterStatusLines(stripAnsi(msg.data)), token);
      }
    } catch {}
  };

  ws.onerror = (err) => {
    console.log('[ws] error:', err);
  };

  ws.onclose = () => {
    console.log('[ws] disconnected from', session);
    if (currentSession === session) {
      setTimeout(() => {
        if (currentSession === session) connectWebSocket(session, windowName);
      }, 1500);
    }
  };
}

function openTerminal(session, windowName) {
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
    ws = null;
  }

  currentSession = session;
  currentWindowName = windowName || '';
  document.getElementById('list-view').style.display = 'none';
  document.getElementById('build-inbox-view').style.display = 'none';
  document.getElementById('term-view').style.display = 'flex';
  const label = sessionLabel(lastSessionList.find(s => s.name === session)) || session;
  document.getElementById('term-title').textContent = windowName ? `${label} → ${windowName}` : label;
  document.querySelector('.notification-toast')?.remove();

  // A fresh open is a new epoch: staged data and callbacks from the previous session die.
  transcript.clear();
  if (copyUi) copyUi.hide();
  // The brief must describe the window this terminal is streaming, not another one.
  if (briefView) briefView.open(session, currentWindowName);

  connectWebSocket(session, windowName);
}

function closeTerminal() {
  if (ws) { ws.close(); ws = null; }
  currentSession = null;
  currentWindowName = '';
  transcript.clear();
  if (copyUi) copyUi.hide();
  if (briefView) briefView.close();
  document.getElementById('term-view').style.display = 'none';
  document.getElementById('build-inbox-view').style.display = 'none';
  document.getElementById('list-view').style.display = 'flex';
  loadSessions();
}

// ── Text Input ──

function sendText() {
  const input = document.getElementById('text-input');
  const text = input.value.trim();
  if (!text || !currentSession) return;
  if (ws && ws.readyState === 1) {
    transcript.echo(text);
    ws.send(JSON.stringify({ type: 'input', data: text + '\r' }));
    input.value = '';
  }
}

// ── Event Listeners ──

document.getElementById('back-btn').addEventListener('click', closeTerminal);
document.getElementById('refresh-btn').addEventListener('click', loadSessions);

const textInput = document.getElementById('text-input');
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendText(); }
});
document.getElementById('send-btn').addEventListener('click', sendText);

// Swipe down to dismiss keyboard — only for gestures outside the transcript. Gestures that
// start in #terminal (long-press selection, handle drags, scrolling) and any active text
// selection are left to the browser so native select and Copy keep working.
let touchStartY = 0;
let touchStartedInTerminal = false;
document.getElementById('term-view').addEventListener('touchstart', (e) => {
  touchStartY = e.touches[0].clientY;
  touchStartedInTerminal = !!(e.target && e.target.closest && e.target.closest('#terminal, #copy-sheet, #brief'));
}, { passive: true });
document.getElementById('term-view').addEventListener('touchend', (e) => {
  if (touchStartedInTerminal || transcript.isProtected()) return;
  const deltaY = e.changedTouches[0].clientY - touchStartY;
  if (deltaY > 50) {
    textInput.blur();
    document.activeElement?.blur();
  }
}, { passive: true });

// Quick-action buttons
document.querySelectorAll('.qa-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (!ws || ws.readyState !== 1) return;
    const key = btn.dataset.key;
    if (key) {
      const keyMap = { ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', Enter: '\r', Escape: '\x1b' };
      const seq = keyMap[key];
      if (seq) ws.send(JSON.stringify({ type: 'input', data: seq }));
    } else if (btn.dataset.input) {
      ws.send(JSON.stringify({ type: 'input', data: btn.dataset.input.replace(/\n/g, '\r') }));
    }
  });
});

// Auto-refresh session list when app comes to foreground + check pending alerts
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  // Snapshot the navigation generation before asking for a pending alert: if a notification
  // tap claims navigation while this request is outstanding, this alert must not navigate,
  // no matter how late its response arrives.
  const startGeneration = activeNavigation.generation;
  try {
    const res = await fetch('/api/pending-alert');
    const { alert } = await res.json();
    if (alert && alert.targetSession) {
      const generation = claimNavigation('pending-alert', startGeneration);
      if (generation === null) return;
      await openNotificationTarget(alert.targetSession, generation);
      return;
    }
  } catch {}
  if (activeNavigation.generation !== startGeneration) return; // a tap owns navigation now
  if (currentSession) {
    if (!ws || ws.readyState > 1) connectWebSocket(currentSession, currentWindowName);
  } else if (isBuildInboxOpen()) {
    loadBuildInbox();
  } else {
    loadSessions();
  }
});

window.visualViewport?.addEventListener('resize', () => transcript.nudge());

// Check URL for ?open=<tmux session> (from notification click when app wasn't open).
// Consume the one-shot intent first so a reload never re-opens a stale alert.
const openParam = new URLSearchParams(location.search).get('open');
if (openParam !== null) {
  history.replaceState(null, '', location.pathname || '/');
  openNotificationTarget(openParam);
} else {
  loadSessions();
}
setupNotifications();
checkNotificationBanner();
