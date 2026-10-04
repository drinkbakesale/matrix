// Matrix Control: the iPad side of the e-ink workstation. The keyboard and
// mouse stay here; the RM2 only displays. All text from sessions is rendered
// with textContent, never as HTML.
(() => {
  'use strict';
  const API = '../api/eink/v1';
  const TOKEN_KEY = 'matrix-control-token';
  const $ = (id) => document.getElementById(id);
  const S = { token: null, snap: null, epoch: null, revision: 0, conn: 'starting', lastBeat: 0, lastConfirmed: '', composing: false, pushTimer: null, pushing: null, abort: null, retry: 1000, pendingOpen: null, multi: new Set() };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { notice(`Cannot save on this device: ${e.message}`); } },
    del(k) { try { localStorage.removeItem(k); } catch { /* nothing stored */ } },
  };

  function notice(text) { $('notice').textContent = text || ''; }
  const selected = () => (S.snap && S.snap.sessions.find((s) => s.id === S.snap.selection.session_id)) || null;
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

  async function api(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${S.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401) { unpair('This device is no longer paired.'); }
    return { status: res.status, data };
  }

  // ---- connection -------------------------------------------------------
  function setConn(status, detail) {
    S.conn = status;
    const el = $('conn');
    el.className = `conn ${status}`;
    const last = S.lastConfirmed ? ` — last confirmed ${S.lastConfirmed}` : '';
    el.textContent = { fresh: 'Live', stale: `STALE${last}`, disconnected: `DISCONNECTED${last} — retrying`, error: `ERROR: ${detail || ''}`, connecting: 'Connecting…', starting: 'Starting…' }[status] || status;
    renderDraftControls();
  }

  function beat() {
    S.lastBeat = performance.now();
    S.lastConfirmed = new Date().toLocaleTimeString();
  }

  setInterval(() => {
    if (S.conn === 'fresh' && performance.now() - S.lastBeat > 6000) setConn('stale');
  }, 500);

  async function connect() {
    if (!S.token) return;
    if (S.abort) S.abort.abort();
    const abort = new AbortController();
    S.abort = abort;
    if (S.conn !== 'stale' && S.conn !== 'disconnected') setConn('connecting');
    try {
      const res = await fetch(`${API}/events`, { headers: { Authorization: `Bearer ${S.token}` }, signal: abort.signal });
      if (res.status === 401) return unpair('This device is no longer paired.');
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = (/^event: (.*)$/m.exec(frame) || [])[1];
          const data = (/^data: (.*)$/m.exec(frame) || [])[1];
          if (type && data) onEvent(type, JSON.parse(data));
        }
      }
      throw new Error('stream ended');
    } catch (err) {
      if (abort.signal.aborted) return;
      setConn('disconnected');
      setTimeout(connect, S.retry + Math.random() * 300);
      S.retry = Math.min(S.retry * 2, 30000);
    }
  }

  function onEvent(type, d) {
    if (d.protocol !== 1) { setConn('error', `server speaks protocol ${d.protocol}; this page understands 1. Reload.`); return; }
    if (type === 'snapshot') {
      S.snap = d.snapshot; S.epoch = d.epoch; S.revision = d.revision; S.retry = 1000;
      beat(); setConn('fresh'); renderAll(); flushUnsynced();
      if (S.pendingOpen !== null) { const t = S.pendingOpen; S.pendingOpen = null; openSession(t); }
      return;
    }
    if (!S.snap) return;
    const counted = type !== 'heartbeat' && type !== 'progress';
    if (d.epoch !== S.epoch || d.revision !== S.revision + (counted ? 1 : 0)) {
      if (d.epoch === S.epoch && d.revision <= S.revision) return; // old, already covered by the snapshot
      return connect(); // gap or server restart: resync from an authoritative snapshot
    }
    S.revision = d.revision;
    beat();
    if (S.conn !== 'fresh') setConn('fresh');
    if (type === 'session') {
      const i = S.snap.sessions.findIndex((s) => s.id === d.session.id);
      if (i >= 0) { d.session.draft = S.snap.sessions[i].draft; S.snap.sessions[i] = d.session; } else S.snap.sessions.push(d.session);
      renderAll();
    } else if (type === 'draft') {
      const s = S.snap.sessions.find((x) => x.id === d.session_id);
      if (s) { s.draft = d.draft; adoptServerDraft(s); renderDraftControls(); }
    } else if (type === 'selection') {
      S.snap.selection = d.selection; S.multi.clear(); renderAll(true);
    } else if (type === 'view') {
      S.snap.view = d.view;
    }
  }

  // ---- drafts -----------------------------------------------------------
  const draftKey = (sid) => `matrix-control-draft:${sid}`;
  function localDraft(sid) {
    try { return JSON.parse(store.get(draftKey(sid))) || null; } catch { return null; }
  }
  function saveLocal(sid, d) { store.set(draftKey(sid), JSON.stringify(d)); }

  // The server copy wins only when it is newer than what this iPad holds. Text
  // typed here and not yet saved on the Mac is never replaced by a server copy
  // of the same revision (for example the cleared draft of a submit that was
  // still in flight while the user kept typing).
  function adoptServerDraft(s) {
    const local = localDraft(s.id);
    if (!local || s.draft.revision > local.revision || (s.draft.revision === local.revision && local.synced !== false)) {
      saveLocal(s.id, { text: s.draft.text, revision: s.draft.revision, synced: true });
      const sel = selected();
      if (sel && sel.id === s.id && $('draft').value !== s.draft.text && !S.composing) $('draft').value = s.draft.text;
    }
  }

  function draftChanged() {
    const s = selected();
    if (!s) return;
    const local = localDraft(s.id) || { text: '', revision: 0 };
    const d = { text: $('draft').value, revision: Math.max(local.revision, s.draft.revision) + 1, synced: false };
    saveLocal(s.id, d);
    clearTimeout(S.pushTimer);
    S.pushTimer = setTimeout(() => pushDraft(s.id), 40);
    renderDraftControls();
  }

  function pushDraft(sid) {
    clearTimeout(S.pushTimer);
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const d = localDraft(sid);
        if (!d || d.synced) return true;
        let r;
        try { r = await api('PUT', '/draft', { session_id: sid, text: d.text, revision: d.revision }); } catch { return false; } // offline: kept locally
        const now = localDraft(sid);
        if (r.status === 200) {
          if (now && now.revision === d.revision) saveLocal(sid, { ...now, synced: true });
          continue; // loop again in case more was typed meanwhile
        }
        if (r.status === 409 && r.data.draft) { saveLocal(sid, { ...now, revision: r.data.draft.revision + 1 }); continue; }
        notice(`Draft not saved on the Mac: ${r.data.error || r.status}`);
        return false;
      }
      return !!(localDraft(sid) || {}).synced;
    };
    S.pushing = (S.pushing || Promise.resolve()).then(run).then((ok) => { renderDraftControls(); return ok; });
    return S.pushing;
  }

  function flushUnsynced() {
    if (!S.snap) return;
    for (const s of S.snap.sessions) {
      const d = localDraft(s.id);
      if (d && !d.synced) pushDraft(s.id);
    }
  }

  async function submit() {
    const s = selected();
    if (!s || S.composing || S.conn !== 'fresh' || $('submit').disabled) return;
    $('submit').disabled = true;
    try {
      const ok = await pushDraft(s.id);
      const d = localDraft(s.id);
      if (!ok || !d || !d.text) { notice('Not sent: the draft is not saved on the Mac yet.'); return; }
      const r = await api('POST', '/submit', { session_id: s.id, selection_revision: S.snap.selection.revision, draft_revision: d.revision, idempotency_id: uid() });
      if (r.status === 200) {
        notice('');
        // Clear only the draft that was sent. Anything typed while it was being delivered is a newer draft and stays.
        const now = localDraft(s.id);
        if (now && now.revision === d.revision) {
          saveLocal(s.id, { text: '', revision: d.revision + 1, synced: true });
          if ((selected() || {}).id === s.id) $('draft').value = '';
        } else if (now && !now.synced) pushDraft(s.id);
      } else notice(`Not sent: ${r.data.error || r.status}`);
    } catch (err) {
      notice('Not sent: the connection dropped. Your draft is kept; nothing is retried automatically.');
    } finally { renderDraftControls(); }
  }

  // ---- commands ---------------------------------------------------------
  async function selectSession(id) {
    if (!S.snap) return;
    try {
      const r = await api('POST', '/select', { session_id: id, base_revision: S.snap.selection.revision });
      if (r.status === 409 && r.data.selection) notice('Selection changed on another device; showing the current one.');
      else if (r.status !== 200) notice(`Cannot select: ${r.data.error || r.status}`);
      else notice('');
    } catch { notice('Cannot select: disconnected.'); }
  }

  async function command(path, extra) {
    const s = selected();
    if (!s) return;
    try {
      const r = await api('POST', path, { session_id: s.id, selection_revision: S.snap.selection.revision, idempotency_id: uid(), ...extra });
      notice(r.status === 200 ? '' : `Not sent: ${r.data.error || r.status}`);
    } catch { notice('Not sent: disconnected.'); }
  }

  async function page(field, delta) {
    if (!S.snap) return;
    const v = { ...S.snap.view };
    if (field === 'draft_page') v.draft_page = delta > 0 ? -1 : Math.max(0, (v.draft_page < 0 ? 0 : v.draft_page) - 1);
    else v[field] = Math.max(0, v[field] + delta);
    try { const r = await api('POST', '/view', v); if (r.status !== 200) notice(`Paging failed: ${r.data.error || r.status}`); } catch { notice('Paging failed: disconnected.'); }
  }

  function openSession(target) {
    if (!S.snap) { S.pendingOpen = target; return; }
    const s = S.snap.sessions.find((x) => x.id === target);
    if (!s || !s.present) { notice('The session for that notification is missing: it ended or is no longer listed.'); return; }
    if (S.snap.selection.session_id !== target) selectSession(target);
    $('draft').focus();
  }

  // ---- rendering --------------------------------------------------------
  const STATE = { working: 'working', needs_input: 'NEEDS INPUT', done: 'done', stuck: 'STUCK', unavailable: 'unavailable' };
  const fieldText = (f) => (f.available ? f.text : `Unavailable: ${f.reason || 'no reason recorded'}`);
  const setText = (id, t) => { $(id).textContent = t; };

  function fileText(title, fs) {
    if (!fs.available) return `${title}\n  Unavailable: ${fs.reason || 'no reason recorded'}`;
    const lines = fs.entries.length ? fs.entries.map((e) => `  ${e.status.padEnd(2)} ${e.path}`) : ['  none'];
    return [title, ...(fs.note ? [`  (${fs.note})`] : []), ...lines].join('\n');
  }

  function renderAll(selectionChanged) {
    const snap = S.snap;
    $('collector').hidden = snap.collector.ok;
    $('collector').textContent = snap.collector.ok ? '' : `Collector error: ${snap.collector.error} — the list may be incomplete.`;
    const ul = $('sessions');
    ul.replaceChildren(...snap.sessions.map((s) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.session = s.id;
      li.setAttribute('aria-selected', String(s.id === snap.selection.session_id));
      const name = document.createElement('span'); name.textContent = s.label;
      const st = document.createElement('span');
      st.className = `state ${s.present ? s.state : 'missing'}`;
      st.textContent = s.present ? STATE[s.state] || s.state : 'MISSING';
      li.append(name, st);
      li.addEventListener('click', () => selectSession(s.id));
      return li;
    }));
    const s = selected();
    if (!s) {
      setText('sel-title', snap.selection.session_id ? 'Selected session is missing' : 'No session selected');
      ['sel-state', 'prompt', 'message', 'files'].forEach((id) => setText(id, ''));
      $('question').hidden = true; $('binding').hidden = true;
      $('draft').value = '';
      renderDraftControls();
      return;
    }
    setText('sel-title', s.label);
    setText('sel-state', `${s.present ? STATE[s.state] || s.state : 'MISSING'}${s.state_reason ? ` — ${s.state_reason}` : ''}`);
    setText('prompt', fieldText(s.prompt));
    setText('message', fieldText(s.message));
    setText('files', `${fileText('Written by this turn\'s tools:', s.files.tool)}\n${fileText('Working tree (not attributed to this session):', s.files.worktree)}`);
    const amb = s.ambiguous_panes || [];
    $('binding').hidden = amb.length === 0;
    $('binding-options').replaceChildren(...amb.map((p) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = `Follow pane ${p}`;
      b.addEventListener('click', async () => { const r = await api('POST', '/bind', { session_id: s.id, pane_id: p }); notice(r.status === 200 ? '' : `Cannot bind: ${r.data.error}`); });
      return b;
    }));
    renderQuestion(s);
    if (selectionChanged || document.activeElement !== $('draft')) {
      const local = localDraft(s.id);
      const text = local && local.revision >= s.draft.revision ? local.text : s.draft.text;
      if ($('draft').value !== text && !S.composing) $('draft').value = text;
    }
    renderDraftControls();
  }

  function renderQuestion(s) {
    const q = s.question;
    $('question').hidden = !q.pending;
    if (!q.pending) return;
    setText('question-text', q.text);
    setText('question-note', q.choices_available ? '' : `${q.reason || 'Choices unavailable'} — use the key buttons below if you can see the prompt in the terminal.`);
    const one = q.kind === 'question' && q.questions && q.questions.length === 1 ? q.questions[0] : null;
    const multi = !!(one && one.multi);
    const opts = q.kind === 'permission' ? q.options : one ? one.options : [];
    if (q.kind === 'question' && !one && q.choices_available) setText('question-note', 'This prompt has several questions; answer it with the key buttons below.');
    $('question-send').hidden = !multi;
    $('question-options').replaceChildren(...opts.map((o) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.option = o.key; b.textContent = `[${o.key}] ${o.label}`;
      if (multi) {
        b.setAttribute('aria-pressed', String(S.multi.has(o.key)));
        b.addEventListener('click', () => { if (S.multi.has(o.key)) S.multi.delete(o.key); else S.multi.add(o.key); b.setAttribute('aria-pressed', String(S.multi.has(o.key))); });
      } else {
        b.addEventListener('click', () => command('/answer', { question_id: q.id, keys: [o.key] }));
      }
      return b;
    }));
    $('question-send').onclick = () => command('/answer', { question_id: q.id, keys: [...S.multi].sort() }).then(() => S.multi.clear());
  }

  function renderDraftControls() {
    const s = selected();
    const local = s ? localDraft(s.id) : null;
    const text = $('draft').value;
    let status = '';
    if (s && s.draft.status === 'uncertain') status = 'DELIVERY UNCERTAIN — sent once, not confirmed, not resent. Edit the text to send again.';
    else if (local && !local.synced) status = S.conn === 'fresh' ? 'saving…' : 'NOT SENT — offline, kept on this device';
    else if (text) status = 'not sent';
    setText('draft-status', status);
    $('draft').disabled = !s;
    $('submit').disabled = !s || !text || S.conn !== 'fresh' || (s && !s.present);
  }

  // ---- notifications ----------------------------------------------------
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function notifyStatus(extra) {
    const parts = [];
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      parts.push(standalone() ? 'This device cannot receive web push.' : 'Push is unavailable in this tab. On iPad: Share → Add to Home Screen, then open Control from the Home Screen.');
    } else {
      parts.push(`Permission: ${Notification.permission}${Notification.permission === 'denied' ? ' (enable in Settings → Notifications → Matrix Control)' : ''}`);
    }
    parts.push(standalone() ? 'installed' : 'not installed to Home Screen');
    if (S.snap && S.snap.notifications && S.snap.notifications.detail) parts.push(`Mac: ${S.snap.notifications.detail}`);
    if (extra) parts.push(extra);
    setText('notify-status', parts.join(' · '));
  }

  function b64ToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  }

  async function enableNotifications() { // only ever called from a click
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return notifyStatus();
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return notifyStatus('not enabled');
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
      await navigator.serviceWorker.ready;
      const k = await api('GET', '/push/vapid-key');
      if (k.status !== 200) return notifyStatus(`Mac: ${k.data.error}`);
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.data.publicKey) });
      const r = await api('POST', '/push/subscribe', { subscription: sub.toJSON() });
      notifyStatus(r.status === 200 ? 'enabled on this device' : `Mac refused the subscription: ${r.data.error}`);
    } catch (err) { notifyStatus(`failed: ${err.message}`); }
  }

  // ---- pairing and startup ---------------------------------------------
  function unpair(msg) {
    store.del(TOKEN_KEY);
    S.token = null; S.snap = null;
    if (S.abort) S.abort.abort();
    $('app').hidden = true; $('pairing').hidden = false;
    $('pair-error').textContent = msg || '';
  }

  function start() {
    $('pairing').hidden = true; $('app').hidden = false;
    connect();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch((err) => notifyStatus(`worker failed: ${err.message}`));
      navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'control-open-session') openSession(e.data.target); });
    }
    notifyStatus();
  }

  $('pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('pair-code').value, label: navigator.platform || 'browser' }) });
      const data = await res.json();
      if (res.status !== 200) { $('pair-error').textContent = `Pairing failed: ${data.error}`; return; }
      store.set(TOKEN_KEY, data.token); S.token = data.token; $('pair-code').value = '';
      start();
    } catch (err) { $('pair-error').textContent = `Pairing failed: ${err.message}`; }
  });

  const ta = $('draft');
  ta.addEventListener('compositionstart', () => { S.composing = true; });
  ta.addEventListener('compositionend', () => { S.composing = false; draftChanged(); });
  ta.addEventListener('input', (e) => { if (!S.composing && !e.isComposing) draftChanged(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing && !S.composing) { e.preventDefault(); submit(); }
  });
  $('submit').addEventListener('click', submit);
  document.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => command('/key', { keys: [b.dataset.key] })));
  $('row-prev').addEventListener('click', () => page('row_page', -1));
  $('row-next').addEventListener('click', () => page('row_page', 1));
  $('digest-prev').addEventListener('click', () => page('digest_page', -1));
  $('digest-next').addEventListener('click', () => page('digest_page', 1));
  $('draft-prev').addEventListener('click', () => page('draft_page', -1));
  $('draft-next').addEventListener('click', () => page('draft_page', 1));
  $('notify-enable').addEventListener('click', enableNotifications);
  $('unpair').addEventListener('click', () => unpair(''));
  window.addEventListener('online', connect);

  const want = new URLSearchParams(location.search).get('session');
  if (want) { S.pendingOpen = want; history.replaceState(null, '', location.pathname); }
  S.token = store.get(TOKEN_KEY);
  if (S.token) start(); else unpair('');
})();
