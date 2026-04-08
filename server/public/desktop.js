let ws = null;
let currentSession = null;
let sessions = [];
let recentProjects = []; // inactive projects shown as faded rows
let sessionAttention = {}; // track which sessions need attention
let dismissed = {}; // dismissed sessions
let switchToastTimer = null;
let switchToastSession = null;

// ── ANSI / Filter ──

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function filterStatusLines(text) {
  return text.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (trimmed.includes('/gsd:update')) return false;
    if (/Opus \d/.test(trimmed) && /context/.test(trimmed)) return false;
    if (/^\d+%\s/.test(trimmed) || /\s\d+%\s+Debug mode/.test(trimmed)) return false;
    if (/Debug mode\s*$/.test(trimmed)) return false;
    if (/bypass permissions on/.test(trimmed)) return false;
    if (/Update available.*brew upgrade/.test(trimmed)) return false;
    if (/^\d+\s+shells?\s*$/.test(trimmed)) return false;
    if (/^[\u2500\u2501\u2502\u2503\u250c\u2510\u2514\u2518\u251c\u2524\u252c\u2534\u253c\u2500\u2501\-]{10,}$/.test(trimmed)) return false;
    return true;
  }).join('\n');
}

// ── Dismissed ──

function getDismissed() { return dismissed; }

function dismissSession(name) {
  dismissed[name] = Date.now();
  renderSidebar();
}

function undismissSession(name) {
  delete dismissed[name];
}

// ── Session List ──

async function loadSessions() {
  try {
    const [sessRes, recentRes] = await Promise.all([
      fetch('/api/sessions'),
      fetch('/api/projects/inactive'),
    ]);
    const sessData = await sessRes.json();
    const recentData = await recentRes.json();
    sessions = sessData.sessions || [];
    // Sync attention from server's tmux detection + SSE notifications
    sessions.forEach(s => {
      if (s.needsAttention) {
        sessionAttention[s.name] = true;
      } else {
        delete sessionAttention[s.name];
      }
    });

    // Filter recent projects: not already visible, active within 14 days
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const activeNames = new Set(sessions.map(s => s.name.toLowerCase()));
    const activeDisplayNames = new Set(sessions.map(s => (s.displayName || s.name).toLowerCase()));
    recentProjects = (recentData.projects || []).filter(p =>
      p.lastActivity > fourteenDaysAgo &&
      !activeNames.has(p.name.toLowerCase()) &&
      !activeDisplayNames.has(p.name.toLowerCase())
    );
    // Sort by most recent first
    recentProjects.sort((a, b) => b.lastActivity - a.lastActivity);

    renderSidebar();
  } catch (err) {
    console.error('loadSessions:', err);
  }
}

function renderSidebar() {
  const list = document.getElementById('project-list');

  // Sort: attention (not dismissed) first, then normal, then dismissed
  const sorted = [...sessions].sort((a, b) => {
    const aAtt = !!sessionAttention[a.name] && !dismissed[a.name];
    const bAtt = !!sessionAttention[b.name] && !dismissed[b.name];
    const aDis = !!dismissed[a.name];
    const bDis = !!dismissed[b.name];
    if (aAtt && !bAtt) return -1;
    if (!aAtt && bAtt) return 1;
    if (aDis && !bDis) return 1;
    if (!aDis && bDis) return -1;
    return 0;
  });

  let html = sorted.map(s => {
    const isDismissed = !!dismissed[s.name];
    const needsAtt = !!sessionAttention[s.name] && !isDismissed;
    const dotClass = needsAtt ? 'attention' : (s.claudeRunning ? 'claude' : (s.attached ? 'running' : 'idle'));
    const badge = needsAtt ? 'Waiting' : (isDismissed && sessionAttention[s.name] ? 'Snoozed' : (s.claudeRunning ? 'Claude' : (s.attached ? 'attached' : `${s.windows} win`)));
    const selected = s.name === currentSession ? ' selected' : '';
    const attention = needsAtt ? ' attention' : '';
    const dimmed = isDismissed ? ' dismissed' : '';
    const descHtml = s.description ? `<div class="project-desc">${s.description}</div>` : '';
    const dismissHtml = needsAtt ? `<button class="dismiss-btn" data-dismiss="${s.name}">dismiss</button>` : '';

    return `
      <div class="project-item${selected}${attention}${dimmed}" data-session="${s.name}">
        <div class="project-content">
          <div class="project-top">
            <span class="project-dot ${dotClass}"></span>
            <span class="project-name">${s.displayName || s.name}</span>
            <span class="project-badge">${badge}</span>
          </div>
          ${descHtml}
        </div>
        ${dismissHtml}
      </div>`;
  }).join('');

  // Append recent (inactive) projects as semi-transparent rows
  if (recentProjects.length > 0) {
    html += '<div class="recent-divider">Recent</div>';
    html += recentProjects.map(p => {
      const ago = recentTimeAgo(p.lastActivity);
      const descHtml = p.description ? `<div class="project-desc">${p.description}</div>` : '';
      return `
        <div class="project-item recent" data-recent-name="${p.name}" data-recent-path="${p.path}">
          <div class="project-content">
            <div class="project-top">
              <span class="project-dot idle"></span>
              <span class="project-name">${p.name}</span>
              <span class="project-badge">${ago}</span>
            </div>
            ${descHtml}
          </div>
        </div>`;
    }).join('');
  }

  list.innerHTML = html;

  list.querySelectorAll('.project-item:not(.recent) .project-content').forEach(content => {
    content.addEventListener('click', () => {
      selectProject(content.closest('.project-item').dataset.session);
    });
  });

  // Click on recent project starts it
  list.querySelectorAll('.project-item.recent .project-content').forEach(content => {
    content.addEventListener('click', async () => {
      const item = content.closest('.project-item');
      const name = item.dataset.recentName;
      const projectPath = item.dataset.recentPath;
      item.querySelector('.project-badge').textContent = 'Starting...';
      try {
        await fetch('/api/projects/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, projectPath }),
        });
        setTimeout(async () => {
          await loadSessions();
          selectProject(name);
        }, 2000);
      } catch {}
    });
  });

  list.querySelectorAll('.dismiss-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissSession(btn.dataset.dismiss);
    });
  });
}

function recentTimeAgo(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

// ── Switch Toast (top-right popup) ──

function showSwitchToast(session) {
  removeSwitchToast();
  switchToastSession = session;

  const toast = document.createElement('div');
  toast.id = 'switch-toast';
  toast.innerHTML = `
    <span class="switch-toast-dot"></span>
    <span class="switch-toast-text"><strong>${session}</strong> needs your input</span>
    <span class="switch-toast-hint">Enter to switch</span>
  `;
  toast.addEventListener('click', () => {
    selectProject(switchToastSession);
    removeSwitchToast();
  });
  document.body.appendChild(toast);

  switchToastTimer = setTimeout(removeSwitchToast, 5000);
}

function removeSwitchToast() {
  const toast = document.getElementById('switch-toast');
  if (toast) toast.remove();
  if (switchToastTimer) { clearTimeout(switchToastTimer); switchToastTimer = null; }
  switchToastSession = null;
}

// Enter key on toast switches project
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && switchToastSession && document.activeElement !== document.getElementById('chat-input')) {
    e.preventDefault();
    selectProject(switchToastSession);
    removeSwitchToast();
  }
});

// ── Project Selection ──

function selectProject(name) {
  if (currentSession === name) return;

  currentSession = name;
  detectedPorts = [];
  const session = sessions.find(s => s.name === name);

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('chat-view').style.display = 'flex';
  document.getElementById('chat-title').textContent = session?.displayName || name;

  updateChatStatus();

  document.getElementById('terminal').textContent = '';
  document.getElementById('terminal').innerHTML = '';

  connectWS(name);
  renderSidebar();
  // showOutputPanel(); // disabled for now
}

// ── WebSocket ──

function connectWS(session) {
  if (ws) { ws.close(); ws = null; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/?session=${encodeURIComponent(session)}`;
  ws = new WebSocket(url);

  const viewer = document.getElementById('terminal');
  let screenLineCount = 0;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  };

  function isNearBottom() {
    return viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 100;
  }

  let pendingText = '';

  function appendMessage(text, role) {
    const div = document.createElement('div');
    div.className = `msg msg-${role}`;
    div.textContent = text;
    viewer.appendChild(div);
  }

  function flushPending() {
    if (!pendingText.trim()) { pendingText = ''; return; }
    // Collapse excessive blank lines
    const cleaned = pendingText.replace(/\n{3,}/g, '\n\n');
    // Split on user input markers ("> " at start of line)
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
      const wasNearBottom = isNearBottom();
      if (msg.type === 'output') {
        const clean = filterStatusLines(stripAnsi(msg.data).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
        pendingText += clean;
        flushPending();
        screenLineCount = 0;
        if (wasNearBottom) viewer.scrollTop = viewer.scrollHeight;
        scanTerminalForOutputs(clean);
      } else if (msg.type === 'screen') {
        const clean = filterStatusLines(stripAnsi(msg.data));
        // Remove previous screen overlay
        const screenEl = viewer.querySelector('.msg-screen');
        if (screenEl) screenEl.remove();
        const screenLines = clean.split('\n').filter(l => l.trim());
        if (screenLines.length > 0) {
          const div = document.createElement('div');
          div.className = 'msg msg-screen msg-assistant';
          div.textContent = screenLines.join('\n');
          viewer.appendChild(div);
        }
        if (wasNearBottom) viewer.scrollTop = viewer.scrollHeight;
      }
    } catch {}
  };

  ws.onclose = () => {
    if (currentSession === session) {
      setTimeout(() => {
        if (currentSession === session) connectWS(session);
      }, 1500);
    }
  };
}

// ── Text Input ──

function sendText() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !currentSession) return;
  if (ws && ws.readyState === 1) {
    const viewer = document.getElementById('terminal');
    const div = document.createElement('div');
    div.className = 'msg msg-human';
    div.textContent = text;
    viewer.appendChild(div);
    viewer.scrollTop = viewer.scrollHeight;
    ws.send(JSON.stringify({ type: 'input', data: text + '\r' }));
    input.value = '';
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

      const session = data.session || data.project;
      if (session && session !== 'matrix') {
        const wasAlreadyWaiting = sessionAttention[session];
        sessionAttention[session] = true;
        undismissSession(session);
        renderSidebar();
        updateChatStatus();

        // Show switch toast only for NEWLY waiting projects
        if (!wasAlreadyWaiting && session !== currentSession) {
          showSwitchToast(session);
        }
      }
    } catch {}
  };
}

// ── Keyboard Shortcuts ──

document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendText(); }
  if (e.key === 'Escape') { document.getElementById('chat-input').blur(); }
});

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

document.getElementById('chat-send').addEventListener('click', sendText);

// ── Output Panel ──

let detectedOutputDir = null;
let detectedPorts = [];
let currentOutputTab = 'files';
let outputPollInterval = null;

// Parse terminal output to detect file writes and localhost URLs
const outputPatterns = {
  file: /(?:wrote|created|saved|output|generated|exported)\s+(?:to\s+)?[`'"]?([^\s`'"]+\.\w+)/gi,
  localhost: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/gi,
  port: /(?:listening|running|started|serving)\s+(?:on|at)\s+(?:port\s+)?:?(\d{4,5})/gi,
};

function scanTerminalForOutputs(text) {
  const newPorts = new Set(detectedPorts.map(p => p.port));
  let foundNew = false;

  // Detect localhost URLs
  for (const match of text.matchAll(outputPatterns.localhost)) {
    const port = parseInt(match[1]);
    if (!newPorts.has(port)) {
      newPorts.add(port);
      detectedPorts.push({ port, url: match[0] });
      foundNew = true;
    }
  }

  // Detect port mentions
  for (const match of text.matchAll(outputPatterns.port)) {
    const port = parseInt(match[1]);
    if (port >= 1024 && port <= 65535 && !newPorts.has(port)) {
      newPorts.add(port);
      detectedPorts.push({ port, url: `http://localhost:${port}` });
      foundNew = true;
    }
  }

  if (foundNew) updateBrowserTab();
}

function showOutputPanel() {
  document.getElementById('output-panel').style.display = 'flex';
  loadOutputFiles();
  loadPorts();
  if (outputPollInterval) clearInterval(outputPollInterval);
  outputPollInterval = setInterval(() => {
    loadOutputFiles();
    loadPorts();
  }, 5000);
}

function hideOutputPanel() {
  document.getElementById('output-panel').style.display = 'none';
  if (outputPollInterval) { clearInterval(outputPollInterval); outputPollInterval = null; }
}

async function loadOutputFiles() {
  if (!currentSession) return;
  try {
    const res = await fetch(`/api/outputs/${encodeURIComponent(currentSession)}`);
    const { files, images } = await res.json();
    renderFilesTab(files);
    renderImagesTab(images);
  } catch {}
}

async function loadPorts() {
  if (!currentSession) return;
  try {
    const res = await fetch(`/api/ports/${encodeURIComponent(currentSession)}`);
    const { ports } = await res.json();
    // Merge with terminal-detected ports
    const known = new Set(detectedPorts.map(p => p.port));
    for (const p of ports) {
      if (!known.has(p.port)) {
        detectedPorts.push(p);
      }
    }
    updateBrowserTab();
  } catch {}
}

function renderFilesTab(files) {
  const list = document.getElementById('files-list');
  if (!files || files.length === 0) {
    list.innerHTML = '<div class="no-browser"><span class="no-browser-icon">📁</span><span>No output files yet</span></div>';
    return;
  }

  const iconMap = {
    '.png': '🖼', '.jpg': '🖼', '.jpeg': '🖼', '.gif': '🖼', '.svg': '🖼', '.webp': '🖼',
    '.json': '📋', '.csv': '📊', '.txt': '📄', '.md': '📝', '.html': '🌐',
    '.py': '🐍', '.js': '📦', '.ts': '📦', '.log': '📃',
  };

  list.innerHTML = files.map(f => {
    const icon = iconMap[f.ext] || '📄';
    const ago = timeAgo(f.mtime);
    const isNew = Date.now() - f.mtime < 30000;
    return `
      <div class="file-item${isNew ? ' new' : ''}">
        <span class="file-icon">${icon}</span>
        <span class="file-name" title="${f.name}">${f.name}</span>
        <span class="file-time">${ago}</span>
      </div>`;
  }).join('');
}

function renderImagesTab(images) {
  const grid = document.getElementById('images-grid');
  if (!images || images.length === 0) {
    grid.innerHTML = '<div class="no-browser"><span class="no-browser-icon">🖼</span><span>No images yet</span></div>';
    return;
  }
  grid.innerHTML = images.map(img => `
    <div class="image-thumb" data-src="${img.path}">
      <img src="${img.path}" loading="lazy" alt="${img.name}">
    </div>`).join('');

  grid.querySelectorAll('.image-thumb').forEach(thumb => {
    thumb.addEventListener('click', () => {
      document.getElementById('lightbox-img').src = thumb.dataset.src;
      document.getElementById('image-lightbox').style.display = 'flex';
    });
  });
}

function updateBrowserTab() {
  const urlEl = document.getElementById('browser-url');
  const frame = document.getElementById('browser-frame');
  const pane = document.getElementById('tab-browser');

  if (detectedPorts.length === 0) {
    pane.innerHTML = '<div class="no-browser"><span class="no-browser-icon">🌐</span><span>No localhost detected</span></div>';
    return;
  }

  // Use the first detected port
  const { url } = detectedPorts[0];
  if (!pane.querySelector('#browser-bar')) {
    pane.innerHTML = `
      <div id="browser-bar">
        <span id="browser-url"></span>
        <button id="browser-refresh" title="Refresh">↻</button>
      </div>
      <iframe id="browser-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`;
    pane.querySelector('#browser-refresh').addEventListener('click', () => {
      pane.querySelector('#browser-frame').src = url;
    });
  }
  pane.querySelector('#browser-url').textContent = url;
  const currentSrc = pane.querySelector('#browser-frame').src;
  if (!currentSrc || currentSrc === 'about:blank') {
    pane.querySelector('#browser-frame').src = url;
  }
}

function timeAgo(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

// Tab switching (output panel may be commented out in HTML)
const outputTabsEl = document.getElementById('output-tabs');
if (outputTabsEl) {
  outputTabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.output-tab');
    if (!tab) return;
    const tabName = tab.dataset.tab;
    currentOutputTab = tabName;

    document.querySelectorAll('.output-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
    document.getElementById(`tab-${tabName}`).style.display = tabName === 'browser' ? 'flex' : 'block';
  });
}

// Lightbox close (may be commented out in HTML)
const lightboxCloseEl = document.getElementById('lightbox-close');
const lightboxEl = document.getElementById('image-lightbox');
if (lightboxCloseEl) {
  lightboxCloseEl.addEventListener('click', () => {
    document.getElementById('image-lightbox').style.display = 'none';
  });
}
if (lightboxEl) {
  lightboxEl.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('image-lightbox').style.display = 'none';
    }
  });
}

// ── New Project ──

function showNewProject() {
  // Hide other views, show new project form
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('chat-view').style.display = 'none';
  document.getElementById('new-project-view').style.display = 'flex';
  if (ws) { ws.close(); ws = null; }
  currentSession = null;
  renderSidebar();

  // Auto-fill name from path as user types
  const nameInput = document.getElementById('np-name');
  const pathInput = document.getElementById('np-path');
  nameInput.value = '';
  pathInput.value = '~/Projects/';
  document.getElementById('np-prompt').value = '';
  nameInput.focus();

  nameInput.oninput = () => {
    const name = nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    pathInput.value = `~/Projects/${name}`;
  };
}

async function startNewProject() {
  const name = document.getElementById('np-name').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const projectPath = document.getElementById('np-path').value.trim();
  const prompt = document.getElementById('np-prompt').value.trim();

  if (!name) { document.getElementById('np-name').focus(); return; }
  if (!projectPath) { document.getElementById('np-path').focus(); return; }

  const sendBtn = document.getElementById('np-send');
  sendBtn.textContent = 'Starting...';
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/projects/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, projectPath }),
    });
    const data = await res.json();
    if (data.ok) {
      // Open in iTerm2
      fetch('/api/projects/open-iterm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: name }),
      }).catch(() => {});

      // Wait for session to be ready, then switch to it
      await new Promise(r => setTimeout(r, 2000));
      await loadSessions();

      // Hide new project view, select the new session
      document.getElementById('new-project-view').style.display = 'none';
      selectProject(name);

      // Send the initial prompt if provided
      if (prompt) {
        setTimeout(() => {
          if (ws && ws.readyState === 1) {
            const viewer = document.getElementById('terminal');
            const div = document.createElement('div');
            div.className = 'msg msg-human';
            div.textContent = prompt;
            viewer.appendChild(div);
            viewer.scrollTop = viewer.scrollHeight;
            ws.send(JSON.stringify({ type: 'input', data: prompt + '\r' }));
          }
        }, 1000);
      }
    }
  } catch (err) {
    sendBtn.textContent = 'Start';
    sendBtn.disabled = false;
  }
}

document.getElementById('new-project-btn').addEventListener('click', showNewProject);
document.getElementById('np-send').addEventListener('click', startNewProject);
document.getElementById('np-prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startNewProject(); }
});

// ── PTT (Push-to-Talk) via MediaRecorder + server-side Apple STT ──

const ptt = {
  active: false,
  mediaRecorder: null,
  audioChunks: [],
  micDeviceId: null,
  speakerDeviceId: null,
};

// Find the UACDemoV1.0 mic and speaker device IDs
async function pttFindDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const d of devices) {
      if (d.label.includes('UACDemoV1.0') || d.label.includes('Jieli')) {
        if (d.kind === 'audioinput') ptt.micDeviceId = d.deviceId;
        if (d.kind === 'audiooutput') ptt.speakerDeviceId = d.deviceId;
      }
    }
    console.log('[PTT] mic:', ptt.micDeviceId ? 'found' : 'not found',
                'speaker:', ptt.speakerDeviceId ? 'found' : 'not found');
    pttRouteSpeaker();
  } catch (err) {
    console.error('[PTT] device enumeration failed:', err);
  }
}

// Preload squelch sounds
const squelchOpenEl = new Audio('/audio/squelch-open.wav');
const squelchCloseEl = new Audio('/audio/squelch-close.wav');
squelchOpenEl.preload = 'auto';
squelchCloseEl.preload = 'auto';

let squelchAudioCtx = null;
let squelchOpenBuf = null;
let squelchCloseBuf = null;

async function pttPreloadSquelch() {
  try {
    squelchAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const [openResp, closeResp] = await Promise.all([
      fetch('/audio/squelch-open.wav'),
      fetch('/audio/squelch-close.wav'),
    ]);
    squelchOpenBuf = await squelchAudioCtx.decodeAudioData(await openResp.arrayBuffer());
    squelchCloseBuf = await squelchAudioCtx.decodeAudioData(await closeResp.arrayBuffer());
    console.log('[PTT] squelch sounds preloaded');
  } catch (e) {
    console.error('[PTT] squelch preload failed:', e);
  }
}

async function pttRouteSpeaker() {
  if (ptt.speakerDeviceId) {
    try {
      if (squelchOpenEl.setSinkId) await squelchOpenEl.setSinkId(ptt.speakerDeviceId);
      if (squelchCloseEl.setSinkId) await squelchCloseEl.setSinkId(ptt.speakerDeviceId);
      console.log('[PTT] squelch routed to USB speaker');
    } catch (e) {
      console.warn('[PTT] setSinkId failed, using default output:', e);
    }
  }
}

function pttPlaySquelch(type) {
  // Web Audio API (instant, bypasses autoplay restrictions)
  if (squelchAudioCtx && (type === 'open' ? squelchOpenBuf : squelchCloseBuf)) {
    if (squelchAudioCtx.state === 'suspended') squelchAudioCtx.resume();
    const source = squelchAudioCtx.createBufferSource();
    source.buffer = type === 'open' ? squelchOpenBuf : squelchCloseBuf;
    source.connect(squelchAudioCtx.destination);
    source.start();
  }
  // Audio element fallback (for setSinkId routing to USB speaker)
  const el = type === 'open' ? squelchOpenEl : squelchCloseEl;
  el.currentTime = 0;
  el.play().catch(() => {});
}

pttPreloadSquelch();

// F2 keydown/keyup from QX18A PTT button (direct — no SSE relay needed)
document.addEventListener('keydown', (e) => {
  if (e.key === 'F2' || e.code === 'F2') {
    e.preventDefault();
    e.stopPropagation();
    if (!ptt.active) pttStart();
  }
}, true);

document.addEventListener('keyup', (e) => {
  if (e.key === 'F2' || e.code === 'F2') {
    e.preventDefault();
    e.stopPropagation();
    if (ptt.active) pttStop();
  }
}, true);

function setupPTT() {
  // Request mic permission on load and find USB mic device
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => { stream.getTracks().forEach(t => t.stop()); pttFindDevices(); })
    .catch(() => console.warn('[PTT] mic permission denied'));
}

async function pttStart() {
  if (ptt.active) return;
  ptt.active = true;
  ptt.audioChunks = [];

  pttPlaySquelch('open');

  // Visual indicator
  const input = document.getElementById('chat-input');
  input.dataset.origPlaceholder = input.placeholder;
  input.placeholder = '🎙 Listening...';
  input.style.borderColor = 'var(--green)';
  input.style.boxShadow = '0 0 8px var(--green-glow)';

  // Start recording from USB mic
  try {
    const constraints = { audio: ptt.micDeviceId ? { deviceId: { exact: ptt.micDeviceId } } : true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    ptt.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    ptt.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) ptt.audioChunks.push(e.data);
    };
    ptt.mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (ptt.audioChunks.length === 0) return;
      const blob = new Blob(ptt.audioChunks, { type: 'audio/webm' });
      pttTranscribe(blob);
    };
    ptt.mediaRecorder.start();
    console.log('[PTT] recording started');
  } catch (err) {
    console.error('[PTT] mic error:', err);
    ptt.active = false;
    input.placeholder = input.dataset.origPlaceholder || 'Type a message...';
    input.style.borderColor = '';
    input.style.boxShadow = '';
  }
}

function pttStop() {
  if (!ptt.active) return;
  ptt.active = false;

  pttPlaySquelch('close');

  const input = document.getElementById('chat-input');
  input.placeholder = input.dataset.origPlaceholder || 'Type a message...';
  input.style.borderColor = '';
  input.style.boxShadow = '';

  // 500ms tail buffer so the end of speech isn't cut off
  setTimeout(() => {
    if (ptt.mediaRecorder && ptt.mediaRecorder.state === 'recording') {
      ptt.mediaRecorder.stop();
      console.log('[PTT] recording stopped (with tail buffer)');
    }
  }, 500);
}

async function pttTranscribe(blob) {
  const input = document.getElementById('chat-input');
  input.placeholder = 'Transcribing...';
  try {
    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');
    const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
    const { text } = await res.json();
    if (text && text.trim()) {
      input.value = (input.value ? input.value + ' ' : '') + text.trim();
      input.focus();
      console.log('[PTT] transcribed:', text.trim());
    }
  } catch (err) {
    console.error('[PTT] transcribe error:', err);
  } finally {
    input.placeholder = input.dataset.origPlaceholder || 'Type a message...';
  }
}

// ── Init ──

loadSessions();
setupSSE();
setupPTT();
setInterval(loadSessions, 5000);
