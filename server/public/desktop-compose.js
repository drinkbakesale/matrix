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

// ── New Project ──

function showNewProject() {
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('chat-view').style.display = 'none';
  document.getElementById('new-project-view').style.display = 'flex';
  if (ws) { ws.close(); ws = null; }
  currentSession = null;
  renderSidebar();

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
      fetch('/api/projects/open-iterm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: name }),
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 2000));
      await loadSessions();
      document.getElementById('new-project-view').style.display = 'none';
      selectProject(name);

      if (prompt) {
        setTimeout(() => {
          if (ws && ws.readyState === 1) {
            transcript.echo(prompt);
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
