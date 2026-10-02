// Mobile panels: the project picker, the read-only build inbox, and the TALK button.
// Extracted from app.js; behaviour unchanged.

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
      top.appendChild(textEl('span', 'inbox-project', item.project));
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
      transcribeAudio(new Blob(audioChunks, { type: 'audio/webm' }));
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
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
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

document.getElementById('add-btn').addEventListener('click', showPicker);
document.getElementById('picker-close').addEventListener('click', closePicker);
document.getElementById('picker-overlay').addEventListener('click', closePicker);
document.getElementById('build-inbox-pin').addEventListener('click', openBuildInbox);
document.getElementById('build-inbox-back').addEventListener('click', closeBuildInbox);
document.getElementById('build-inbox-refresh').addEventListener('click', loadBuildInbox);
