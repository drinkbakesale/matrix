// Core state of the e-ink workstation: concrete session identity, one
// authoritative selection, per-session drafts, the command journal, and the
// versioned snapshot/event stream shared by the RM2 and the iPad controller.
const crypto = require('crypto');
const { TmuxError, ALLOWED_KEYS } = require('./tmux');

const PROTOCOL = 1;
const MAX_DRAFT_CHARS = 65536;

class CommandError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const sessionKey = (p) => 's_' + crypto.createHash('sha256').update(`${p.serverPid}:${p.sessionId}:${p.sessionCreated}`).digest('hex').slice(0, 12);
const paneKey = (p) => `${p.serverPid}:${p.paneId}`;

function createService({ store, tmux, now = () => Date.now() }) {
  // Durable documents. A corrupt file throws here: the service refuses to
  // start on a looks-fine empty state.
  const persisted = store.readJson('state.json', {
    selection: { session_id: '', revision: 1 }, view: { digest_page: 0, row_page: 0, draft_page: -1 },
    bindings: {}, pane_choice: {}, known: {},
  });
  let drafts = store.readJson('drafts.json', {});
  const st = {
    epoch: crypto.randomBytes(8).toString('hex'),
    revision: 1,
    collector: { ok: false, error: 'session list not collected yet' },
    panes: [],
    sessions: new Map(), // key -> { id, label, present, panes: [] }
    worktrees: {}, // key -> worktree result
    ...persisted,
  };
  const clients = new Set();
  const journal = new Map(); // idempotency id -> last record

  for (const rec of store.readLines('commands.jsonl')) journal.set(rec.id, { ...(journal.get(rec.id) || {}), ...rec });
  // Recovery: a command that reached "sending" with no acknowledgement may or
  // may not have been delivered. It is marked uncertain and never retried.
  for (const rec of journal.values()) {
    if (rec.state === 'sending') {
      rec.state = 'uncertain';
      // Only the draft revision that was actually sent carries the mark: text
      // typed after the send began is a newer, unsent draft.
      const d = drafts[rec.session_id];
      if (d && rec.kind === 'submit' && d.revision === rec.draft_revision) d.status = 'uncertain';
    } else if (rec.state === 'pending') {
      rec.state = 'unsent';
    }
  }

  const saveState = () => store.writeJson('state.json', {
    selection: st.selection, view: st.view, bindings: st.bindings, pane_choice: st.pane_choice, known: st.known,
  });
  const saveDrafts = (next) => { store.writeJson('drafts.json', next); drafts = next; };

  function broadcast(type, data, { bump = true } = {}) {
    if (bump) st.revision += 1;
    const body = JSON.stringify({ ...data, epoch: st.epoch, revision: st.revision, protocol: PROTOCOL });
    for (const c of clients) c.send(type, body);
  }

  // A full snapshot event, built after the revision bump so it is self-consistent.
  function broadcastSnapshot(health) {
    st.revision += 1;
    const body = JSON.stringify({ snapshot: snapshot(health), epoch: st.epoch, revision: st.revision, protocol: PROTOCOL });
    for (const c of clients) c.send('snapshot', body);
  }

  // ----- identity ---------------------------------------------------------
  function boundPanes(sess) {
    return sess.panes.filter((p) => st.bindings[paneKey(p)]);
  }

  // Returns { pane, binding } or { reason } — never a guess.
  function agentPane(sess) {
    if (!sess.present) return { reason: 'session ended or is no longer listed' };
    const bound = boundPanes(sess);
    const choice = st.pane_choice[sess.id];
    if (choice) {
      const p = bound.find((x) => x.paneId === choice);
      if (p) return { pane: p, binding: st.bindings[paneKey(p)] };
    }
    if (bound.length === 1) return { pane: bound[0], binding: st.bindings[paneKey(bound[0])] };
    if (bound.length === 0) {
      return { reason: 'No Claude evidence is bound to this session yet. Start or continue Claude in it after installing the Matrix evidence hook (docs/RM2_SETUP.md).' };
    }
    return { reason: `${bound.length} Claude panes are active in this session (${bound.map((p) => p.paneId).join(', ')}); choose one in Control`, ambiguous: bound.map((p) => p.paneId) };
  }

  const labelOf = (p) => {
    const project = String(p.project || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 60);
    return project && project !== p.sessionName ? `${project} · ${p.sessionName}` : p.sessionName;
  };

  const shape = () => JSON.stringify([...st.sessions.values()].map((s) => [s.id, s.label, s.present, s.panes.map((p) => [p.paneId, p.dead])]));

  // Rebuilds the session list. Order is stable: sessions with Claude evidence
  // first, then by first-seen time. A row never moves because its state changed.
  function applyPanes(panes) {
    const seen = new Map();
    for (const p of panes) {
      const key = sessionKey(p);
      if (!seen.has(key)) seen.set(key, { id: key, label: labelOf(p), present: true, panes: [] });
      seen.get(key).panes.push(p);
      const k = st.known[key] || { first_seen: now() };
      st.known[key] = { ...k, label: labelOf(p), last_seen: now() };
    }
    // A session that vanished stays listed as missing while it matters (selected or holding a draft).
    for (const key of Object.keys(st.known)) {
      if (seen.has(key)) continue;
      if (st.selection.session_id === key || (drafts[key] && drafts[key].text)) {
        seen.set(key, { id: key, label: st.known[key].label, present: false, panes: [] });
      } else if (now() - st.known[key].last_seen > 7 * 24 * 3600 * 1000) {
        delete st.known[key];
      }
    }
    const before = shape();
    const rank = (s) => (s.panes.some((p) => st.bindings[paneKey(p)]) ? 0 : 1);
    const list = [...seen.values()].sort((a, b) => rank(a) - rank(b) || st.known[a.id].first_seen - st.known[b.id].first_seen || (a.id < b.id ? -1 : 1));
    st.sessions = new Map(list.map((s) => [s.id, s]));
    st.panes = panes;
    return before !== shape();
  }

  // ----- snapshot ---------------------------------------------------------
  function sessionView(sess) {
    const res = agentPane(sess);
    const draft = drafts[sess.id] || { text: '', revision: 0, status: '' };
    const base = { id: sess.id, label: sess.label, present: sess.present, draft: { text: draft.text, revision: draft.revision, status: draft.status || (draft.text ? 'unsent' : '') } };
    const wt = st.worktrees[sess.id];
    const worktree = wt
      ? { available: wt.available, reason: wt.reason, note: wt.note || '', entries: wt.entries }
      : { available: false, reason: 'working tree not collected yet', note: '', entries: [] };
    if (!res.binding) {
      const un = (what) => ({ available: false, text: '', reason: res.reason || what });
      return {
        ...base, state: 'unavailable', state_reason: res.reason, ambiguous_panes: res.ambiguous || [],
        prompt: un(), message: un(),
        question: { pending: false, id: '', kind: '', text: '', options: [], choices_available: false, reason: '' },
        files: { tool: { available: false, reason: res.reason, note: '', entries: [] }, worktree },
      };
    }
    const r = res.binding.reducer;
    const q = r.question;
    return {
      ...base,
      pane_id: res.pane.paneId,
      state: r.state,
      state_reason: [r.state_reason, res.binding.transcript_note].filter(Boolean).join(' · '),
      prompt: r.prompt,
      message: r.message,
      question: q
        ? { pending: true, id: q.id, kind: q.kind, text: q.text, options: q.options, questions: q.questions || [], choices_available: q.choices_available, reason: q.reason || '' }
        : { pending: false, id: '', kind: '', text: '', options: [], choices_available: false, reason: '' },
      files: {
        tool: r.turn > 0
          ? { available: true, reason: '', note: '', entries: r.tool_paths.map((p) => ({ status: 'W', path: p })) }
          : { available: false, reason: 'no turn observed yet', note: '', entries: [] },
        worktree,
      },
    };
  }

  function snapshot(health) {
    return {
      protocol: PROTOCOL, epoch: st.epoch, revision: st.revision,
      collector: st.collector, selection: st.selection, view: st.view,
      sessions: [...st.sessions.values()].map(sessionView),
      notifications: health ? health() : undefined,
      server_time: new Date(now()).toISOString(),
    };
  }

  function publishSession(key) {
    const sess = st.sessions.get(key);
    if (sess) broadcast('session', { session: sessionView(sess) });
  }

  // ----- commands ---------------------------------------------------------
  function requireSession(id) {
    if (typeof id !== 'string' || !/^s_[0-9a-f]{12}$/.test(id)) throw new CommandError(400, 'invalid session id');
    const sess = st.sessions.get(id);
    if (!sess) throw new CommandError(404, 'unknown session');
    return sess;
  }

  function select({ session_id, base_revision }) {
    const sess = requireSession(session_id);
    if (!sess.present) throw new CommandError(410, 'session ended or is no longer listed');
    if (base_revision !== st.selection.revision) throw new CommandError(409, 'selection changed; refresh and try again', { selection: st.selection });
    const next = { session_id, revision: st.selection.revision + 1 };
    const prev = st.selection;
    const prevView = st.view;
    st.selection = next;
    st.view = { ...st.view, digest_page: 0, draft_page: -1 };
    try { saveState(); } catch (err) { st.selection = prev; st.view = prevView; throw err; }
    broadcast('selection', { selection: st.selection });
    return { selection: st.selection };
  }

  function setView(v) {
    const int = (x, lo) => (Number.isInteger(x) && x >= lo && x < 100000 ? x : null);
    const next = { digest_page: int(v.digest_page, 0), row_page: int(v.row_page, 0), draft_page: int(v.draft_page, -1) };
    if (Object.values(next).some((x) => x === null)) throw new CommandError(400, 'invalid view');
    const prev = st.view;
    st.view = next;
    try { saveState(); } catch (err) { st.view = prev; throw err; }
    broadcast('view', { view: st.view });
    return { view: st.view };
  }

  function putDraft({ session_id, text, revision }) {
    requireSession(session_id);
    if (typeof text !== 'string') throw new CommandError(400, 'draft text must be a string');
    if (text.length > MAX_DRAFT_CHARS) throw new CommandError(413, `draft exceeds ${MAX_DRAFT_CHARS} characters`);
    if (!Number.isInteger(revision) || revision < 1) throw new CommandError(400, 'draft revision must be a positive integer');
    const cur = drafts[session_id] || { text: '', revision: 0, status: '' };
    if (revision <= cur.revision) throw new CommandError(409, 'stale draft revision', { draft: cur });
    const d = { text, revision, status: text ? 'unsent' : '' };
    saveDrafts({ ...drafts, [session_id]: d }); // throws on disk failure: the draft is not claimed as saved
    broadcast('draft', { session_id, draft: d });
    return { draft: d };
  }

  function journalWrite(rec) {
    store.append('commands.jsonl', rec);
    journal.set(rec.id, { ...(journal.get(rec.id) || {}), ...rec });
  }

  // Shared target resolution for submit/answer/key: the command must name the
  // currently selected session at the selection revision the user saw, and the
  // concrete pane must still be alive right now.
  async function resolveTarget({ session_id, selection_revision }) {
    const sess = requireSession(session_id);
    if (st.selection.session_id !== session_id || st.selection.revision !== selection_revision) {
      throw new CommandError(409, 'selection changed since this was typed; nothing was sent', { selection: st.selection });
    }
    const res = agentPane(sess);
    if (!res.pane) throw new CommandError(409, res.reason);
    let live;
    try {
      live = await tmux.listPanes();
    } catch (err) {
      throw new CommandError(503, `cannot verify the target pane: ${err.message}`);
    }
    const pane = live.find((p) => paneKey(p) === paneKey(res.pane) && sessionKey(p) === session_id);
    if (!pane || pane.dead) throw new CommandError(410, 'the target pane no longer exists; nothing was sent');
    return { sess, pane, binding: res.binding };
  }

  function replay(id) {
    const rec = journal.get(id);
    if (!rec) return null;
    if (rec.state === 'acknowledged') return { status: 200, body: { ok: true, state: 'acknowledged', replayed: true } };
    if (rec.state === 'uncertain') return { status: 409, body: { error: 'delivery uncertain: this was sent once without confirmation and will not be resent', state: 'uncertain' } };
    if (rec.state === 'failed' || rec.state === 'unsent') return null; // definitely not delivered: a new attempt is allowed
    return { status: 409, body: { error: 'command already in progress', state: rec.state } };
  }

  // Admission. Everything between a command's arrival and the start of its
  // delivery is asynchronous (tmux is asked whether the pane is alive, the
  // terminal is read for an answer), so two rules make it atomic:
  //  - the idempotency id is reserved synchronously, before the first await:
  //    a second request with the same id cannot also pass validation;
  //  - commitCheck() runs synchronously immediately before the journal write
  //    that starts delivery, against the state as it is at that instant.
  const inflight = new Set(); // idempotency ids admitted and not yet finished
  const delivering = new Map(); // session id -> idempotency id being delivered

  function admit(id) {
    if (!idOk(id)) throw new CommandError(400, 'idempotency_id required');
    if (inflight.has(id)) return { status: 409, body: { error: 'command already in progress', state: 'in_progress' } };
    const again = replay(id);
    if (again) return again;
    inflight.add(id);
    return null;
  }

  // Throws unless the command may be delivered right now: the selection is
  // still the one the user saw, the session still resolves to the same pane
  // and the same Claude conversation, the answered question (if any) is still
  // the pending one, and no other command is mid-delivery to this session.
  function commitCheck(target, { session_id, selection_revision, question_id }) {
    if (st.selection.session_id !== session_id || st.selection.revision !== selection_revision) {
      throw new CommandError(409, 'selection changed while this was being checked; nothing was sent', { selection: st.selection });
    }
    const sess = st.sessions.get(session_id);
    const res = sess ? agentPane(sess) : { reason: 'session ended or is no longer listed' };
    if (!res.pane) throw new CommandError(409, `${res.reason}; nothing was sent`);
    if (paneKey(res.pane) !== paneKey(target.pane) || res.binding.conversation_id !== target.binding.conversation_id) {
      throw new CommandError(409, 'the target pane or its Claude conversation changed while this was being checked; nothing was sent');
    }
    if (question_id !== undefined) {
      const q = res.binding.reducer.question;
      if (!q || q.id !== question_id) throw new CommandError(409, 'that question is no longer pending; nothing was sent');
    }
    if (delivering.has(session_id)) throw new CommandError(409, 'another command is being delivered to this session; nothing was sent');
  }

  async function deliver(kind, id, session_id, pane, fn, extra = {}) {
    delivering.set(session_id, id);
    try {
      await deliverJournaled(kind, id, session_id, pane, fn, extra);
    } finally {
      delivering.delete(session_id);
    }
  }

  async function deliverJournaled(kind, id, session_id, pane, fn, extra) {
    journalWrite({ id, kind, session_id, pane: paneKey(pane), ...extra, state: 'pending', at: now() });
    journalWrite({ id, state: 'sending', at: now() });
    try {
      await fn();
    } catch (err) {
      if (err instanceof TmuxError && err.notStarted) {
        journalWrite({ id, state: 'failed', error: err.message, at: now() });
        throw new CommandError(502, `not sent: ${err.message}`);
      }
      journalWrite({ id, state: 'uncertain', error: err.message, at: now() });
      throw new CommandError(502, `delivery uncertain: ${err.message}`, { state: 'uncertain' });
    }
    try {
      journalWrite({ id, state: 'acknowledged', at: now() });
    } catch (err) {
      journal.set(id, { ...(journal.get(id) || {}), state: 'uncertain' });
      throw new CommandError(500, `sent, but the acknowledgement could not be recorded (${err.message}); treat delivery as uncertain`, { state: 'uncertain' });
    }
  }

  const idOk = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);

  async function submit(cmd) {
    const again = admit(cmd.idempotency_id);
    if (again) return again;
    try {
      return await submitAdmitted(cmd);
    } finally {
      inflight.delete(cmd.idempotency_id);
    }
  }

  async function submitAdmitted({ session_id, selection_revision, draft_revision, idempotency_id }) {
    const target = await resolveTarget({ session_id, selection_revision });
    const { pane } = target;
    // No await from here to the journal write inside deliver().
    commitCheck(target, { session_id, selection_revision });
    const d = drafts[session_id];
    if (!d || !d.text) throw new CommandError(409, 'draft is empty; nothing to send');
    if (d.revision !== draft_revision) throw new CommandError(409, 'draft changed since submit was pressed; nothing was sent', { draft: d });
    if (d.status === 'uncertain') throw new CommandError(409, 'this draft was sent once without confirmation; edit it to send again');
    try {
      await deliver('submit', idempotency_id, session_id, pane, () => tmux.sendText(pane.paneId, d.text), { draft_revision: d.revision });
    } catch (err) {
      // The uncertainty belongs to the revision that was sent. A draft edited
      // while the send was in flight is newer unsent text and is left exactly
      // as it is; the journal still refuses to resend this command.
      const now_ = drafts[session_id];
      if (err.extra && err.extra.state === 'uncertain' && now_ && now_.revision === d.revision) {
        drafts = { ...drafts, [session_id]: { ...now_, status: 'uncertain' } };
        try { store.writeJson('drafts.json', drafts); } catch { /* status stays uncertain in memory; journal already says so */ }
        broadcast('draft', { session_id, draft: drafts[session_id] });
      }
      throw err;
    }
    const cleared = { text: '', revision: d.revision + 1, status: '' };
    const cur = drafts[session_id];
    // Clear only the draft that was submitted; anything typed since stays.
    if (cur && cur.revision === d.revision) {
      try { saveDrafts({ ...drafts, [session_id]: cleared }); } catch (err) {
        throw new CommandError(500, `sent and acknowledged, but the draft could not be cleared on disk: ${err.message}`);
      }
      broadcast('draft', { session_id, draft: cleared });
    }
    return { status: 200, body: { ok: true, state: 'acknowledged', submitted: { session_id, pane_id: pane.paneId, chars: d.text.length } } };
  }

  async function sendKeysCommand(kind, cmd, keysFor) {
    const again = admit(cmd.idempotency_id);
    if (again) return again;
    try {
      return await sendKeysAdmitted(kind, cmd, keysFor);
    } finally {
      inflight.delete(cmd.idempotency_id);
    }
  }

  async function sendKeysAdmitted(kind, { session_id, selection_revision, idempotency_id, question_id }, keysFor) {
    const target = await resolveTarget({ session_id, selection_revision });
    const keys = await keysFor(target);
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 12 || !keys.every((k) => ALLOWED_KEYS.has(k))) {
      throw new CommandError(400, 'key sequence not allowed; nothing was sent');
    }
    // No await from here to the journal write inside deliver().
    commitCheck(target, { session_id, selection_revision, question_id: kind === 'answer' ? String(question_id) : undefined });
    await deliver(kind, idempotency_id, session_id, target.pane, () => tmux.sendKeys(target.pane.paneId, keys));
    return { status: 200, body: { ok: true, state: 'acknowledged', keys } };
  }

  function bind({ session_id, pane_id }) {
    const sess = requireSession(session_id);
    if (!boundPanes(sess).some((p) => p.paneId === pane_id)) throw new CommandError(409, 'that pane has no Claude evidence bound');
    const prev = st.pane_choice[session_id];
    st.pane_choice[session_id] = pane_id;
    try { saveState(); } catch (err) { st.pane_choice[session_id] = prev; throw err; }
    publishSession(session_id);
    return { ok: true };
  }

  function addClient(send) {
    const c = { send };
    clients.add(c);
    return () => clients.delete(c);
  }

  return {
    st, PROTOCOL, snapshot, broadcast, broadcastSnapshot, publishSession, addClient, applyPanes, agentPane, sessionView,
    saveState, select, setView, putDraft, submit, sendKeysCommand, bind, resolveTarget,
    drafts: () => drafts, journal, clients,
  };
}

module.exports = { createService, CommandError, sessionKey, paneKey, PROTOCOL, MAX_DRAFT_CHARS };
