let ws = null;
let currentSession = null;
let notifSource = null;
let userScrolledUp = false;

const MAX_DOM_MESSAGES = 1000;

// ── Scroll Tracking ──

function isNearBottom(viewer) {
  return viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 100;
}

function autoScroll(viewer) {
  if (!userScrolledUp) {
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

// Resolve a session name or project name to an actual tmux session
async function resolveSession(nameOrProject) {
  try {
    const res = await fetch('/api/sessions');
    const { sessions } = await res.json();
    if (!sessions || !sessions.length) return nameOrProject;
    // Exact tmux session name match
    const exact = sessions.find(s => s.name === nameOrProject);
    if (exact) return exact.name;
    // Match by displayName (case-insensitive)
    const byDisplay = sessions.find(s =>
      s.displayName && s.displayName.toLowerCase() === nameOrProject.toLowerCase()
    );
    if (byDisplay) return byDisplay.name;
    // Partial match on displayName or path
    const partial = sessions.find(s =>
      (s.displayName && s.displayName.toLowerCase().includes(nameOrProject.toLowerCase())) ||
      (s.path && s.path.toLowerCase().includes(nameOrProject.toLowerCase()))
    );
    if (partial) return partial.name;
  } catch {}
  return nameOrProject;
}

function showToast(data) {
  if (!currentSession) loadSessions();
  if (currentSession === data.session) return;
  document.querySelector('.notification-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'notification-toast';
  toast.innerHTML = `
    <div class="toast-dot"></div>
    <div class="toast-content">
      <div class="toast-project">${data.project}</div>
      <div class="toast-message">${data.message}</div>
    </div>
    <div class="toast-action">Open</div>`;
  toast.addEventListener('click', async () => {
    toast.remove();
    const resolved = await resolveSession(data.session);
    openTerminal(resolved);
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
    const res = await fetch('/api/sessions');
    const { sessions } = await res.json();
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
        ? `<div class="session-desc">${s.description}</div>`
        : '';
      return `
        <div class="${cardClass}" data-session="${s.name}" data-attention="${s.needsAttention ? '1' : '0'}">
          <div class="session-inner">
            <div class="session-top">
              <span class="session-dot ${dotClass}"></span>
              <span class="session-name">${s.displayName || s.name}</span>
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
    pruneMessages(viewer);
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
  document.getElementById('list-view').style.display = 'none';
  document.getElementById('term-view').style.display = 'flex';
  document.getElementById('term-title').textContent = windowName ? `${session} → ${windowName}` : session;
  document.querySelector('.notification-toast')?.remove();

  const viewer = document.getElementById('terminal');
  viewer.textContent = '';
  viewer.innerHTML = '';

  connectWebSocket(session, windowName);
}

function closeTerminal() {
  if (ws) { ws.close(); ws = null; }
  currentSession = null;
  document.getElementById('terminal').textContent = '';
  document.getElementById('term-view').style.display = 'none';
  document.getElementById('list-view').style.display = 'flex';
  loadSessions();
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

const textInput = document.getElementById('text-input');
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendText(); }
});
document.getElementById('send-btn').addEventListener('click', sendText);

// Swipe down to dismiss keyboard
let touchStartY = 0;
document.getElementById('term-view').addEventListener('touchstart', (e) => {
  touchStartY = e.touches[0].clientY;
}, { passive: true });
document.getElementById('term-view').addEventListener('touchend', (e) => {
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
  if (!document.hidden) {
    // Check if there's a pending notification to auto-open
    try {
      const res = await fetch('/api/pending-alert');
      const { alert } = await res.json();
      if (alert && alert.session) {
        const resolved = await resolveSession(alert.session);
        openTerminal(resolved);
        return;
      }
    } catch {}
    if (currentSession) {
      if (!ws || ws.readyState > 1) connectWebSocket(currentSession);
    } else {
      loadSessions();
    }
  }
});

window.visualViewport?.addEventListener('resize', () => {
  const viewer = document.getElementById('terminal');
  if (viewer) autoScroll(viewer);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => reg.update());
  // Handle notification click → open session
  navigator.serviceWorker.addEventListener('message', async (e) => {
    if (e.data?.type === 'open-session' && e.data.session) {
      const resolved = await resolveSession(e.data.session);
      openTerminal(resolved);
    }
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

// Check URL for ?open=session (from notification click when app wasn't open)
const openParam = new URLSearchParams(location.search).get('open');
if (openParam) {
  history.replaceState(null, '', '/');
  resolveSession(openParam).then(resolved => openTerminal(resolved));
} else {
  loadSessions();
}
setupNotifications();
checkNotificationBanner();
