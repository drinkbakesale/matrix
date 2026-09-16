let ws = null;
let currentSession = null;
let notifSource = null;
let userScrolledUp = false;

let lastSessionList = [];
let deferredScreenUpdate = null;

const MAX_DOM_MESSAGES = 1000;

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

// ── Text Selection ──

function hasActiveSelection() {
  const sel = window.getSelection ? window.getSelection() : null;
  return !!sel && sel.rangeCount > 0 && !sel.isCollapsed;
}

function terminalSelectionActive() {
  if (!hasActiveSelection()) return false;
  const terminal = document.getElementById('terminal');
  const sel = window.getSelection();
  return !!terminal && (terminal.contains(sel.anchorNode) || terminal.contains(sel.focusNode));
}

// Apply a screen refresh that was held back while the user was selecting transcript text.
document.addEventListener('selectionchange', () => {
  if (deferredScreenUpdate && !terminalSelectionActive()) {
    const apply = deferredScreenUpdate;
    deferredScreenUpdate = null;
    apply();
  }
});

// ── Scroll Tracking ──

function isNearBottom(viewer) {
  return viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 100;
}

function autoScroll(viewer) {
  // Jumping to the bottom mid-selection would drag the selection handles away.
  if (!userScrolledUp && !terminalSelectionActive()) {
    viewer.scrollTop = viewer.scrollHeight;
  }
}

function pruneMessages(viewer) {
  const msgs = viewer.querySelectorAll('.msg');
  if (msgs.length <= MAX_DOM_MESSAGES) return;
  const toRemove = msgs.length - MAX_DOM_MESSAGES;
  const prevHeight = viewer.scrollHeight;
  for (let i = 0; i < toRemove; i++) msgs[i].remove();
  // Adjust scroll position so view doesn't jump
  if (userScrolledUp) {
    viewer.scrollTop -= (prevHeight - viewer.scrollHeight);
  }
}

// ── Notifications ──

function setupNotifications() {
  // SSE for in-app toasts
  notifSource = new EventSource('/api/notifications/stream');
  notifSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type !== 'notification') return;
      showToast(data);
    } catch {}
  };

  // Subscribe to Web Push
  subscribeToPush();
}

async function subscribeToPush() {
  const dbg = document.getElementById('push-debug');
  function setDebug(msg) { if (dbg) { dbg.textContent = msg; dbg.style.display = msg ? 'block' : 'none'; } }

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setDebug(`No push: SW=${'serviceWorker' in navigator} PM=${'PushManager' in window}`);
    return false;
  }
  try {
    setDebug(`Perm state: ${Notification.permission}, trying subscribe anyway...`);
    // Don't re-request permission — iOS can return 'denied' even when Settings says allowed
    // Just attempt the subscription directly
    setDebug('Waiting for SW ready...');
    const reg = await navigator.serviceWorker.ready;
    setDebug('Getting subscription...');
    let sub = await reg.pushManager.getSubscription();
    // Always unsubscribe and resubscribe to ensure VAPID key match
    if (sub) {
      setDebug('Clearing old subscription...');
      await sub.unsubscribe();
    }
    setDebug('Fetching VAPID key...');
    const res = await fetch('/api/push/vapid-key');
    const json = await res.json();
    const publicKey = json.publicKey;
    if (!publicKey) {
      setDebug('VAPID key not configured — run "npm run setup"');
      return false;
    }
    setDebug('Subscribing to push...');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    setDebug('Registering with server...');
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    setDebug('Push active!');
    setTimeout(() => { if (dbg) dbg.style.display = 'none'; }, 3000);
    return true;
  } catch (err) {
    setDebug(`Error: ${err.message}`);
    return false;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
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

function showToast(data) {
  if (!currentSession) loadSessions();
  const targetSession = typeof data.targetSession === 'string' ? data.targetSession : '';
  if (targetSession && currentSession === targetSession) return;
  document.querySelector('.notification-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'notification-toast';
  toast.innerHTML = `
    <div class="toast-dot"></div>
    <div class="toast-content">
      <div class="toast-project">${escapeHtml(data.project)}</div>
      <div class="toast-message">${escapeHtml(data.message)}</div>
    </div>
    <div class="toast-action">Open</div>`;
  toast.addEventListener('click', () => {
    toast.remove();
    openNotificationTarget(targetSession);
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 8000);
}

// ── Notification Permission Banner ──

async function checkNotificationBanner() {
  const banner = document.getElementById('push-setup');
  if (!banner) return;

  const isStandalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

  // Wait for SW to be ready before checking push support (iOS needs this)
  let hasPush = 'PushManager' in window;
  const hasSW = 'serviceWorker' in navigator;
  if (hasSW && !hasPush) {
    try {
      await navigator.serviceWorker.ready;
      hasPush = 'PushManager' in window;
    } catch {}
  }

  const hasNotif = 'Notification' in window;

  if (hasNotif && hasPush && Notification.permission === 'granted') {
    banner.style.display = 'none';
    subscribeToPush();
    return;
  }

  banner.style.display = 'block';
  const span = banner.querySelector('span');
  const btn = document.getElementById('push-enable-btn');

  if (!isStandalone) {
    span.textContent = 'Add to Home Screen first, then open from there to enable notifications';
    btn.textContent = 'OK';
    btn.onclick = () => { banner.style.display = 'none'; };
  } else if (!hasNotif || !hasPush) {
    // Web push needs HTTPS — ntfy handles notifications, just hide the banner
    banner.style.display = 'none';
    return;
  } else if (Notification.permission === 'denied') {
    span.textContent = 'Notifications blocked — go to Settings > this app to re-enable';
    btn.style.display = 'none';
  } else {
    span.textContent = 'Enable notifications to know when projects need input';
  }
}

async function enableNotifications() {
  const banner = document.getElementById('push-setup');
  const ok = await subscribeToPush();
  if (ok) {
    banner.style.display = 'none';
    // Send a test to confirm it works
    fetch('/api/test-notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Notifications enabled!' }),
    });
  } else {
    banner.innerHTML = '<span>Could not enable notifications. Open from Home Screen as PWA.</span>';
  }
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
    if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      swiping = true;
    }
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
      // Dismiss threshold reached
      inner.style.transform = 'translateX(-100%)';
      inner.style.opacity = '0';
      setTimeout(() => {
        dismissSession(card.dataset.session);
        loadSessions();
      }, 250);
    } else {
      // Snap back
      inner.style.transform = 'translateX(0)';
      inner.style.opacity = '1';
    }
  }, { passive: true });
}

// ── Project Picker ──

async function showPicker() {
  const modal = document.getElementById('picker-modal');
  const list = document.getElementById('picker-list');
  list.innerHTML = '<div style="padding:20px;color:var(--dim);text-align:center">Scanning...</div>';
  modal.style.display = 'block';

  const [inactiveRes, discoverRes] = await Promise.all([
    fetch('/api/projects/inactive').then(r => r.json()),
    fetch('/api/projects/discover').then(r => r.json()),
  ]);

  const items = [];
  for (const p of inactiveRes.projects) {
    items.push({ name: p.name, path: p.path, source: 'configured' });
  }
  for (const p of discoverRes.projects) {
    if (!items.find(i => i.path === p.path)) {
      items.push({ name: p.name, path: p.path, source: 'discovered' });
    }
  }

  if (items.length === 0) {
    list.innerHTML = '<div style="padding:20px;color:var(--dim);text-align:center">All projects are already running</div>';
    return;
  }

  list.innerHTML = items.map(p => `
    <div class="picker-item" data-name="${p.name}" data-path="${p.path}">
      <div class="picker-name">${p.name}</div>
      <div class="picker-path">${p.path.replace('/Users/williamkehler/', '~/')}</div>
      ${p.source === 'discovered' ? '<span class="picker-new">new</span>' : ''}
    </div>`).join('');

  list.querySelectorAll('.picker-item').forEach(item => {
    item.addEventListener('click', async () => {
      const name = item.dataset.name;
      const projectPath = item.dataset.path;
      item.style.opacity = '0.5';
      item.style.pointerEvents = 'none';
      await fetch('/api/projects/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, projectPath }),
      });
      closePicker();
      setTimeout(loadSessions, 2000);
    });
  });
}

function closePicker() {
  document.getElementById('picker-modal').style.display = 'none';
}

// ── Terminal ──

// Strip ANSI escape codes for plain-text display
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// Filter out Claude's status bar lines (model info, context %, debug mode, etc.)
function filterStatusLines(text) {
  return text.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true; // keep blank lines
    // Filter Claude status bar patterns
    if (trimmed.includes('/gsd:update')) return false;
    if (/Opus \d/.test(trimmed) && /context/.test(trimmed)) return false;
    if (/^\d+%\s/.test(trimmed) || /\s\d+%\s+Debug mode/.test(trimmed)) return false;
    if (/Debug mode\s*$/.test(trimmed)) return false;
    if (/bypass permissions on/.test(trimmed)) return false;
    if (/Update available.*brew upgrade/.test(trimmed)) return false;
    if (/^\d+\s+shells?\s*$/.test(trimmed)) return false;
    // Filter the horizontal separator lines (just dashes/box chars)
    if (/^[\u2500\u2501\u2502\u2503\u250c\u2510\u2514\u2518\u251c\u2524\u252c\u2534\u253c─━\-]{10,}$/.test(trimmed)) return false;
    return true;
  }).join('\n');
}

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

  const viewer = document.getElementById('terminal');

  // Track user scroll — detect when user scrolls up, re-enable when they scroll back down
  viewer.addEventListener('scroll', () => {
    userScrolledUp = !isNearBottom(viewer);
  }, { passive: true });

  ws.onopen = () => {
    console.log('[ws] connected to', session);
    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  };

  let screenLineCount = 0;
  let pendingText = '';

  function appendMessage(text, role) {
    const div = document.createElement('div');
    div.className = `msg msg-${role}`;
    div.textContent = text;
    viewer.appendChild(div);
    if (!terminalSelectionActive()) pruneMessages(viewer);
  }

  function flushPending() {
    if (!pendingText.trim()) { pendingText = ''; return; }
    const cleaned = pendingText.replace(/\n{3,}/g, '\n\n');
    const parts = cleaned.split(/^(> .+)$/m);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('> ')) {
        appendMessage(part.slice(2), 'human');
      } else if (part.trim()) {
        appendMessage(part, 'assistant');
      }
    }
    pendingText = '';
  }

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') {
        const clean = filterStatusLines(stripAnsi(msg.data).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
        pendingText += clean;
        flushPending();
        screenLineCount = 0;
        autoScroll(viewer);
      } else if (msg.type === 'screen') {
        const applyScreen = () => {
          const clean = filterStatusLines(stripAnsi(msg.data));
          const screenEl = viewer.querySelector('.msg-screen');
          if (screenEl) screenEl.remove();
          const screenLines = clean.split('\n').filter(l => l.trim());
          if (screenLines.length > 0) {
            const div = document.createElement('div');
            div.className = 'msg msg-screen msg-assistant';
            div.textContent = screenLines.join('\n');
            viewer.appendChild(div);
          }
          autoScroll(viewer);
        };
        // Replacing the live screen block destroys any selection inside it, so hold the
        // newest screen until the user finishes selecting.
        if (terminalSelectionActive()) {
          deferredScreenUpdate = applyScreen;
        } else {
          deferredScreenUpdate = null;
          applyScreen();
        }
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
  userScrolledUp = false;
  deferredScreenUpdate = null;
  document.getElementById('list-view').style.display = 'none';
  document.getElementById('build-inbox-view').style.display = 'none';
  document.getElementById('term-view').style.display = 'flex';
  const label = sessionLabel(lastSessionList.find(s => s.name === session)) || session;
  document.getElementById('term-title').textContent = windowName ? `${label} → ${windowName}` : label;
  document.querySelector('.notification-toast')?.remove();

  const viewer = document.getElementById('terminal');
  viewer.textContent = '';
  viewer.innerHTML = '';

  connectWebSocket(session, windowName);
}

function closeTerminal() {
  if (ws) { ws.close(); ws = null; }
  currentSession = null;
  deferredScreenUpdate = null;
  document.getElementById('terminal').textContent = '';
  document.getElementById('term-view').style.display = 'none';
  document.getElementById('build-inbox-view').style.display = 'none';
  document.getElementById('list-view').style.display = 'flex';
  loadSessions();
}

// ── Build Inbox (read-only controller summary) ──

let buildInboxLoading = false;

const BUILD_INBOX_GROUPS = [
  { key: 'needsYou', title: 'Needs you', className: 'needs-you', detail: item => item.reason },
  { key: 'running', title: 'Running', className: 'running', detail: item => item.stage },
  { key: 'finished', title: 'Recently finished', className: 'finished', detail: item => item.result },
];

function isBuildInboxOpen() {
  return document.getElementById('build-inbox-view').style.display !== 'none';
}

function openBuildInbox() {
  document.getElementById('list-view').style.display = 'none';
  document.getElementById('term-view').style.display = 'none';
  document.getElementById('build-inbox-view').style.display = 'flex';
  loadBuildInbox();
}

function closeBuildInbox() {
  document.getElementById('build-inbox-view').style.display = 'none';
  document.getElementById('list-view').style.display = 'flex';
  loadSessions();
}

// Controller-derived strings are only ever assigned through textContent.
function textEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = String(text ?? '');
  return el;
}

async function loadBuildInbox() {
  if (buildInboxLoading) return;
  buildInboxLoading = true;
  const status = document.getElementById('build-inbox-status');
  status.className = 'build-inbox-status';
  status.textContent = 'Loading…';
  try {
    const res = await fetch('/api/build-inbox', { cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok || !data || data.ok !== true) {
      const reason = data && typeof data.message === 'string' ? data.message : `HTTP ${res.status}`;
      renderBuildInboxError(`Build inbox unavailable: ${reason}`);
      return;
    }
    renderBuildInbox(data);
  } catch {
    renderBuildInboxError('Build inbox unavailable: could not reach Matrix');
  } finally {
    buildInboxLoading = false;
  }
}

function renderBuildInboxError(message) {
  const status = document.getElementById('build-inbox-status');
  status.className = 'build-inbox-status error';
  status.textContent = message;
  document.getElementById('build-inbox-content').replaceChildren();
}

function renderBuildInbox(data) {
  const fragment = document.createDocumentFragment();
  let total = 0;
  for (const group of BUILD_INBOX_GROUPS) {
    const items = Array.isArray(data[group.key]) ? data[group.key] : [];
    const count = Number.isInteger(data.counts?.[group.key]) ? data.counts[group.key] : items.length;
    total += count;
    const section = textEl('section', `inbox-group ${group.className}`);
    section.appendChild(textEl('h2', 'inbox-group-title', `${group.title} (${count})`));
    if (items.length === 0) section.appendChild(textEl('div', 'inbox-empty', 'None'));
    for (const item of items) {
      const row = textEl('div', 'inbox-item');
      const top = textEl('div', 'inbox-item-top');
      top.appendChild(textEl('span', 'inbox-project', item.project || 'unknown project'));
      top.appendChild(textEl('span', 'inbox-detail', group.detail(item) || ''));
      const meta = textEl('div', 'inbox-item-meta');
      meta.appendChild(textEl('span', 'inbox-task', item.taskId));
      if (item.updated) meta.appendChild(textEl('span', 'inbox-updated', item.updated));
      row.append(top, meta);
      section.appendChild(row);
    }
    fragment.appendChild(section);
  }
  document.getElementById('build-inbox-content').replaceChildren(fragment);
  const status = document.getElementById('build-inbox-status');
  status.className = 'build-inbox-status';
  status.textContent = total === 0
    ? 'Nothing needs you, running, or recently finished'
    : `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ── Text Input ──

function sendText() {
  const input = document.getElementById('text-input');
  const text = input.value.trim();
  if (!text || !currentSession) return;
  if (ws && ws.readyState === 1) {
    const viewer = document.getElementById('terminal');
    const div = document.createElement('div');
    div.className = 'msg msg-human';
    div.textContent = text;
    viewer.appendChild(div);
    userScrolledUp = false;
    viewer.scrollTop = viewer.scrollHeight;
    ws.send(JSON.stringify({ type: 'input', data: text + '\r' }));
    input.value = '';
  }
}

// ── TALK Button (press-and-hold voice input) ──

const talkBtn = document.getElementById('talk-btn');
let mediaRecorder = null;
let audioChunks = [];
let talkActive = false;

talkBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startTalking();
}, { passive: false });

talkBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  stopTalking();
}, { passive: false });

talkBtn.addEventListener('touchcancel', () => stopTalking());

// Mouse fallback for testing on desktop
talkBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startTalking(); });
talkBtn.addEventListener('mouseup', () => stopTalking());

async function startTalking() {
  if (talkActive) return;
  talkActive = true;
  talkBtn.classList.add('recording');
  talkBtn.textContent = 'REC';
  audioChunks = [];

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (audioChunks.length === 0) return;
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      transcribeAudio(blob);
    };
    mediaRecorder.start();
  } catch (err) {
    talkActive = false;
    talkBtn.classList.remove('recording');
    talkBtn.textContent = 'TALK';
    // Fallback: focus text input so user can type or use iOS dictation
    document.getElementById('text-input').focus();
  }
}

function stopTalking() {
  if (!talkActive) return;
  talkActive = false;
  talkBtn.classList.remove('recording');
  talkBtn.textContent = 'TALK';
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

async function transcribeAudio(blob) {
  try {
    talkBtn.textContent = '...';
    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');
    const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
    const { text } = await res.json();
    if (text && text.trim()) {
      const input = document.getElementById('text-input');
      input.value = (input.value ? input.value + ' ' : '') + text.trim();
      input.focus();
    }
  } catch {} finally {
    talkBtn.textContent = 'TALK';
  }
}

// ── Event Listeners ──

document.getElementById('back-btn').addEventListener('click', closeTerminal);
document.getElementById('refresh-btn').addEventListener('click', loadSessions);
document.getElementById('add-btn').addEventListener('click', showPicker);
document.getElementById('picker-close').addEventListener('click', closePicker);
document.getElementById('picker-overlay').addEventListener('click', closePicker);
document.getElementById('build-inbox-pin').addEventListener('click', openBuildInbox);
document.getElementById('build-inbox-back').addEventListener('click', closeBuildInbox);
document.getElementById('build-inbox-refresh').addEventListener('click', loadBuildInbox);

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
  touchStartedInTerminal = e.target instanceof Element && !!e.target.closest('#terminal');
}, { passive: true });
document.getElementById('term-view').addEventListener('touchend', (e) => {
  if (touchStartedInTerminal || hasActiveSelection()) return;
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
      const keyMap = {
        ArrowUp: '\x1b[A',
        ArrowDown: '\x1b[B',
        Enter: '\r',
        Escape: '\x1b',
      };
      const seq = keyMap[key];
      if (seq) ws.send(JSON.stringify({ type: 'input', data: seq }));
    } else if (btn.dataset.input) {
      const text = btn.dataset.input.replace(/\n/g, '\r');
      ws.send(JSON.stringify({ type: 'input', data: text }));
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
  // Check if there's a pending notification to auto-open
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
    if (!ws || ws.readyState > 1) connectWebSocket(currentSession);
  } else if (isBuildInboxOpen()) {
    loadBuildInbox();
  } else {
    loadSessions();
  }
});

window.visualViewport?.addEventListener('resize', () => {
  const viewer = document.getElementById('terminal');
  if (viewer) autoScroll(viewer);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => reg.update());
  // Handle notification click on an already-open app → open that exact session.
  // Only the server-resolved targetSession is trusted; without one, show the project list.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'open-session') return;
    openNotificationTarget(typeof e.data.targetSession === 'string' ? e.data.targetSession : '');
  });
  // Show setup button if permission not yet granted, auto-subscribe if already granted
  const isStandalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const pushSetup = document.getElementById('push-setup');
  if (isStandalone && 'PushManager' in window) {
    // Always try to subscribe — iOS permission state can be unreliable
    subscribeToPush().then(ok => {
      if (!ok && pushSetup) {
        pushSetup.style.display = 'block';
      }
    });
    if (Notification.permission === 'default' && pushSetup) {
      pushSetup.style.display = 'block';
      document.getElementById('push-enable-btn').addEventListener('click', async () => {
        const btn = document.getElementById('push-enable-btn');
        try {
          btn.textContent = 'Requesting permission...';
          const perm = await Notification.requestPermission();
          if (perm === 'granted') {
            btn.textContent = 'Subscribing...';
            const ok = await subscribeToPush();
            if (ok) {
              pushSetup.style.display = 'none';
            } else {
              btn.textContent = 'Subscribe failed — tap to retry';
              btn.style.background = 'var(--amber)';
            }
          } else {
            btn.textContent = `Permission: ${perm} — Check Settings`;
            btn.style.background = 'var(--dim)';
          }
        } catch (err) {
          btn.textContent = `Error: ${err.message}`;
          btn.style.background = 'var(--red)';
        }
      });
    }
  }
}

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
