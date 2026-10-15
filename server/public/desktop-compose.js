// Desktop composer: slash-command autocomplete, the new-project form, and push-to-talk.
// Extracted from desktop.js; behaviour unchanged.

function autoResizeInput(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ── Slash Command Autocomplete ──

const slash = { skills: [], fetched: false, activeIdx: -1 };

async function fetchSkills() {
  if (slash.fetched) return slash.skills;
  try {
    const res = await fetch('/api/skills');
    slash.skills = await res.json();
  } catch { slash.skills = []; }
  slash.fetched = true;
  return slash.skills;
}

function updateSlashAutocomplete(input) {
  const menu = document.getElementById('slash-autocomplete');
  const val = input.value;

  // Only trigger when the entire input starts with /
  if (!val.startsWith('/') || val.includes('\n')) {
    menu.style.display = 'none';
    slash.activeIdx = -1;
    return;
  }

  const query = val.slice(1).toLowerCase();
  fetchSkills().then(skills => {
    const matches = skills.filter(s => s.includes(query)).slice(0, 15);
    if (matches.length === 0) {
      menu.style.display = 'none';
      slash.activeIdx = -1;
      return;
    }
    slash.activeIdx = -1;
    menu.innerHTML = matches.map((s, i) =>
      `<div class="slash-item" data-idx="${i}" data-skill="${s}"><span class="slash-prefix">/</span>${s}</div>`
    ).join('');
    menu.style.display = 'block';
    menu.querySelectorAll('.slash-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = '/' + el.dataset.skill + ' ';
        menu.style.display = 'none';
        autoResizeInput(input);
        input.focus();
      });
    });
  });
}

document.getElementById('chat-input').addEventListener('input', function () {
  autoResizeInput(this);
  updateSlashAutocomplete(this);
});

document.getElementById('chat-input').addEventListener('keydown', (e) => {
  const menu = document.getElementById('slash-autocomplete');
  const menuOpen = menu.style.display !== 'none';
  const items = menuOpen ? menu.querySelectorAll('.slash-item') : [];

  if (menuOpen && items.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slash.activeIdx = Math.min(slash.activeIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === slash.activeIdx));
      items[slash.activeIdx].scrollIntoView({ block: 'nearest' });
      return;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      slash.activeIdx = Math.max(slash.activeIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === slash.activeIdx));
      items[slash.activeIdx].scrollIntoView({ block: 'nearest' });
      return;
    } else if (e.key === 'Tab' || (e.key === 'Enter' && slash.activeIdx >= 0)) {
      e.preventDefault();
      const selected = items[slash.activeIdx >= 0 ? slash.activeIdx : 0];
      e.target.value = '/' + selected.dataset.skill + ' ';
      menu.style.display = 'none';
      slash.activeIdx = -1;
      autoResizeInput(e.target);
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      menu.style.display = 'none';
      slash.activeIdx = -1;
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  if (e.key === 'Escape') { document.getElementById('chat-input').blur(); }
});

// ── New Session ──
// The panel borrows the regular message bar (same box, Send button, slash menu and voice)
// while it is open, and hands it back to the chat view when it closes.

let sessionBeforeNew = null;
let newSessionStarting = false;
const chatBarHome = (() => {
  const bar = document.getElementById('chat-input-bar');
  return { parent: bar.parentNode, next: bar.nextSibling };
})();

function borrowChatBar() {
  document.getElementById('np-input-slot').appendChild(document.getElementById('chat-input-bar'));
  const input = document.getElementById('chat-input');
  input.placeholder = 'What do you want to work on?';
  input.value = '';
  autoResizeInput(input);
}

function returnChatBar() {
  chatBarHome.parent.insertBefore(document.getElementById('chat-input-bar'), chatBarHome.next);
  const input = document.getElementById('chat-input');
  input.placeholder = 'Type a message...';
  input.value = '';
  autoResizeInput(input);
  setNewSessionBusy(false);
}

function setNewSessionBusy(busy) {
  newSessionStarting = busy;
  const send = document.getElementById('chat-send');
  send.disabled = busy;
  send.textContent = busy ? 'Starting...' : 'Send';
}

function showNewProject() {
  if (newSessionOpen()) { document.getElementById('chat-input').focus(); return; }
  sessionBeforeNew = currentSession;
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('chat-view').style.display = 'none';
  document.getElementById('new-project-view').style.display = 'flex';
  if (ws) { ws.close(); ws = null; }
  currentSession = null;
  renderSidebar();

  const status = document.getElementById('np-status');
  status.textContent = '';
  status.classList.remove('error');
  borrowChatBar();
  document.getElementById('chat-input').focus();
}

function newSessionOpen() {
  return document.getElementById('new-project-view').style.display !== 'none';
}

// Back to whatever was on screen before the panel opened.
function closeNewProject() {
  if (newSessionStarting) return;
  document.getElementById('new-project-view').style.display = 'none';
  returnChatBar();
  const back = sessionBeforeNew && sessions.find(s => s.name === sessionBeforeNew) ? sessionBeforeNew : null;
  sessionBeforeNew = null;
  if (back) { selectProject(back); focusChatInput(); }
  else document.getElementById('empty-state').style.display = '';
}

// Called by sendText() while the panel is open.
async function startNewSession() {
  if (newSessionStarting) return;
  const input = document.getElementById('chat-input');
  const request = input.value.trim();
  if (!request) { input.focus(); return; }

  const status = document.getElementById('np-status');
  setNewSessionBusy(true);
  document.getElementById('slash-autocomplete').style.display = 'none';
  status.classList.remove('error');
  status.textContent = 'Picking the project and starting Claude…';

  try {
    const res = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request, parts: MatrixFiles.parts(input, request) || undefined }),
    });
    const data = await res.json().catch(() => ({ error: `server answered ${res.status}` }));
    if (!res.ok || !data.ok) throw new Error(data.error || `server answered ${res.status}`);
    await loadSessions();
    document.getElementById('new-project-view').style.display = 'none';
    MatrixFiles.reset(input);
    returnChatBar();
    sessionBeforeNew = null;
    selectProject(data.session);
    focusChatInput();
  } catch (err) {
    status.classList.add('error');
    status.textContent = err.message;
    setNewSessionBusy(false);
    input.focus();
  }
}

MatrixFiles.install(document.getElementById('chat-input'));
document.getElementById('new-project-btn').addEventListener('click', showNewProject);
document.getElementById('np-close').addEventListener('click', closeNewProject);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && newSessionOpen()) { e.preventDefault(); closeNewProject(); }
});

// ── PTT (Push-to-Talk) — Live SpeechRecognition + server-side sounds ──

const ptt = { active: false, recognition: null, finalTranscript: '' };

// Sounds play server-side through the USB mic speaker via sounddevice
function pttPlaySquelch(type) {
  fetch('/api/ptt/sound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
  }).catch(() => {});
}

// F2 keydown/keyup from the QX18A PTT button (direct — no SSE relay needed)
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
  // Nothing to set up — F2 key listeners handle everything
}

async function pttStart() {
  if (ptt.active) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.error('[PTT] SpeechRecognition not available');
    return;
  }

  ptt.active = true;
  ptt.finalTranscript = '';
  pttPlaySquelch('open');

  const input = document.getElementById('chat-input');
  input.value = '';
  input.dataset.origPlaceholder = input.placeholder;
  input.placeholder = '🎙 Listening...';
  input.style.borderColor = 'var(--green)';
  input.style.boxShadow = '0 0 8px var(--green-glow)';

  ptt.recognition = new SpeechRecognition();
  ptt.recognition.continuous = true;
  ptt.recognition.interimResults = true;
  ptt.recognition.lang = 'en-US';

  // Track where this session's results start so we don't repeat old ones
  let resultStartIdx = -1;

  ptt.recognition.onresult = (event) => {
    if (resultStartIdx < 0) resultStartIdx = event.resultIndex;
    let interim = '';
    let final = '';
    for (let i = resultStartIdx; i < event.results.length; i++) {
      if (event.results[i].isFinal) final += event.results[i][0].transcript;
      else interim += event.results[i][0].transcript;
    }
    ptt.finalTranscript = final;
    input.value = (final + interim).trim();
    autoResizeInput(input);
  };

  ptt.recognition.onerror = (event) => { console.log('[PTT] recognition error:', event.error); };

  ptt.recognition.onend = () => {
    // If the button is still held, restart (the browser auto-stops after silence)
    if (ptt.active) { try { ptt.recognition.start(); } catch {} }
  };

  try {
    ptt.recognition.start();
    console.log('[PTT] live recognition started');
  } catch (err) {
    console.error('[PTT] start error:', err);
    ptt.active = false;
  }
}

function pttStop() {
  if (!ptt.active) return;
  ptt.active = false;
  pttPlaySquelch('close');

  const input = document.getElementById('chat-input');
  input.style.borderColor = '';
  input.style.boxShadow = '';

  if (ptt.recognition) {
    ptt.recognition.onend = null;
    try { ptt.recognition.stop(); } catch {}
    ptt.recognition = null;
  }

  // Second pass: clean up the transcript
  const rawText = input.value.trim();
  if (rawText) {
    input.placeholder = 'Cleaning up...';
    pttCleanup(rawText).then(cleaned => {
      input.value = cleaned;
      input.placeholder = input.dataset.origPlaceholder || 'Type a message...';
      input.focus();
      console.log('[PTT] cleaned:', cleaned);
    });
  } else {
    input.placeholder = input.dataset.origPlaceholder || 'Type a message...';
  }
}

async function pttCleanup(rawText) {
  try {
    const res = await fetch('/api/ptt/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: rawText }),
    });
    const { text } = await res.json();
    return text || rawText;
  } catch {
    return rawText;
  }
}
