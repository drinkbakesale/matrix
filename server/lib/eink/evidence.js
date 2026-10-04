// Evidence collection: typed hook events (HTTP or the offline spool), the
// tmux session list, transcript progress, the no-progress timer, the terminal
// prompt adapter and the working-tree change set. Every failure is recorded
// as collector/field state; none of it empties the screen.
const path = require('path');
const os = require('os');
const { initial, reduce, NO_PROGRESS_MS_DEFAULT } = require('./reducer');
const { createTranscriptReader } = require('./transcript');
const { parsePermissionPrompt } = require('./prompt-adapter');
const { CommandError, sessionKey, paneKey } = require('./service');

const HOOK_KINDS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact']);
const MAX_TEXT = 200000;

function createEvidence({ service, store, tmux, git, push, fs = require('fs'), now = () => Date.now(),
  transcriptRoot = process.env.MATRIX_EINK_TRANSCRIPT_ROOT || path.join(os.homedir(), '.claude', 'projects'),
  noProgressMs = NO_PROGRESS_MS_DEFAULT }) {
  const { st } = service;
  const readers = new Map(); // transcript path -> reader
  const spoolDir = path.join(store.dir, 'spool');
  fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  let ignored = 0;

  const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : undefined);

  // The transcript must be a .jsonl file inside the Claude projects root.
  function safeTranscript(p) {
    if (typeof p !== 'string' || !p.endsWith('.jsonl')) return null;
    const norm = path.resolve(p);
    const root = path.resolve(transcriptRoot) + path.sep;
    return norm.startsWith(root) ? norm : null;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') throw new CommandError(400, 'evidence must be an object');
    const kind = raw.hook_event_name;
    if (!HOOK_KINDS.has(kind)) throw new CommandError(400, `unsupported hook event ${JSON.stringify(kind)}`);
    const pane = raw.pane || {};
    if (!/^\d+$/.test(String(pane.server_pid || '')) || !/^%\d+$/.test(String(pane.pane_id || ''))) {
      throw new CommandError(400, 'evidence carries no tmux pane identity');
    }
    if (typeof raw.session_id !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(raw.session_id)) throw new CommandError(400, 'invalid conversation id');
    if (typeof raw.event_id !== 'string' || !/^[A-Za-z0-9_.:-]{8,120}$/.test(raw.event_id)) throw new CommandError(400, 'invalid event id');
    if (typeof raw.seq !== 'number' || !Number.isFinite(raw.seq) || raw.seq <= 0) throw new CommandError(400, 'invalid event sequence');
    if (raw.transcript_path !== undefined && raw.transcript_path !== null && !safeTranscript(raw.transcript_path)) {
      throw new CommandError(400, 'transcript path is outside the Claude projects directory');
    }
    const ti = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
    return {
      event_id: raw.event_id, seq: raw.seq, kind,
      conversation_id: raw.session_id,
      pane_key: `${pane.server_pid}:${pane.pane_id}`,
      transcript_path: raw.transcript_path ? safeTranscript(raw.transcript_path) : null,
      cwd: str(raw.cwd, 4096),
      source: str(raw.source, 40),
      prompt: str(raw.prompt),
      tool_name: str(raw.tool_name, 200),
      tool_use_id: str(raw.tool_use_id, 200),
      tool_input: Array.isArray(ti.questions) ? { questions: ti.questions.slice(0, 8) } : {},
      file_path: str(ti.file_path || ti.notebook_path, 4096),
      notification_type: str(raw.notification_type, 80),
      message: str(raw.message, 2000),
      last_assistant_message: str(raw.last_assistant_message),
      error: str(raw.error, 2000),
      background_tasks: Number.isInteger(raw.background_tasks) && raw.background_tasks > 0 ? raw.background_tasks : 0,
    };
  }

  function reader(file) {
    if (!readers.has(file)) readers.set(file, createTranscriptReader({ path: file, fs }));
    return readers.get(file);
  }

  function completeMessage(binding, ev) {
    let note = '';
    let fromTranscript = null;
    if (binding.transcript_path) {
      const r = reader(binding.transcript_path);
      r.poll();
      const v = r.view();
      if (v.error) note = `Transcript problem: ${v.error}`;
      else if (v.assistantText) fromTranscript = v.assistantText;
    } else {
      note = 'Transcript problem: no transcript path reported by the hook';
    }
    binding.transcript_note = note;
    if (ev.last_assistant_message) return { available: true, text: ev.last_assistant_message, reason: '' };
    if (note) return { available: false, text: '', reason: note };
    if (fromTranscript) return { available: true, text: fromTranscript, reason: '' };
    return { available: false, text: '', reason: 'Claude produced no text message this turn' };
  }

  const sessionsOfPane = (pk) => [...st.sessions.values()].filter((s) => s.panes.some((p) => paneKey(p) === pk)).map((s) => s.id);

  // Transitions whose durable enqueue failed are kept and retried; the failure
  // is visible in notification health and is never reported as delivered.
  const owed = [];
  function flushOwed() {
    while (owed.length) {
      try {
        if (push.enqueue(owed[0])) queuePump();
        owed.shift();
        push.reportError('');
      } catch (err) {
        push.reportError(`cannot save ${owed.length} notification(s) to disk: ${err.message}`);
        return;
      }
    }
  }
  function notify(pk, transitions) {
    for (const t of transitions) {
      for (const sid of sessionsOfPane(pk)) {
        owed.push({ id: `${sid}:${t.id}`, kind: t.kind, session_id: sid, label: st.sessions.get(sid).label });
      }
    }
    flushOwed();
  }

  let pumping = Promise.resolve();
  function queuePump() {
    pumping = pumping.then(() => push.pump()).catch((err) => { st.collector = { ok: false, error: `notification outbox: ${err.message}` }; });
    return pumping;
  }

  function commit(pk, binding) {
    const prev = st.bindings[pk];
    st.bindings = { ...st.bindings, [pk]: binding };
    try {
      service.saveState();
    } catch (err) {
      if (prev) st.bindings = { ...st.bindings, [pk]: prev }; else { const { [pk]: _drop, ...rest } = st.bindings; st.bindings = rest; }
      throw err;
    }
  }

  async function refreshWorktree(sid) {
    const sess = st.sessions.get(sid);
    if (!sess) return;
    const res = service.agentPane(sess);
    const cwd = (res.binding && res.binding.cwd) || (sess.panes[0] && sess.panes[0].cwd);
    const wt = await git.worktree(cwd);
    if (wt.available) {
      const sharers = [...st.sessions.values()].filter((o) => o.id !== sid && st.worktrees[o.id] && st.worktrees[o.id].toplevel === wt.toplevel).map((o) => o.label);
      wt.note = sharers.length
        ? `shared with ${sharers.join(', ')}: these changes cannot be attributed to one session`
        : 'whole working tree, including changes made before this turn';
    }
    const before = JSON.stringify(st.worktrees[sid]);
    st.worktrees[sid] = wt;
    if (before !== JSON.stringify(wt)) service.publishSession(sid);
  }

  async function readPrompt(pk) {
    const b = st.bindings[pk];
    const q = b && b.reducer.question;
    if (!q || q.kind !== 'permission' || q.choices_available) return;
    let parsed;
    try {
      parsed = parsePermissionPrompt(await tmux.capturePane(pk.split(':')[1]));
    } catch (err) {
      parsed = { ok: false, reason: `terminal could not be read: ${err.message}` };
    }
    const cur = st.bindings[pk];
    if (!cur || !cur.reducer.question || cur.reducer.question.id !== q.id) return; // resolved meanwhile
    const nq = parsed.ok
      ? { ...cur.reducer.question, text: `${q.text.split(' — ')[0]} — ${parsed.question}`, options: parsed.options, choices_available: true, reason: '', adapter: parsed.version }
      : { ...cur.reducer.question, choices_available: false, options: [], reason: `Choices unavailable: ${parsed.reason}` };
    if (JSON.stringify(nq) === JSON.stringify(cur.reducer.question)) return;
    commit(pk, { ...cur, reducer: { ...cur.reducer, question: nq } });
    sessionsOfPane(pk).forEach(service.publishSession);
  }

  // Ingests one hook event. Throws CommandError on invalid input or a failed
  // durable write (the hook keeps the event in its spool and retries).
  async function ingest(raw) {
    const ev = normalize(raw);
    const pk = ev.pane_key;
    if (!st.panes.some((p) => paneKey(p) === pk)) await collect();
    let b = st.bindings[pk];
    const newlyBound = !b;
    if (b && b.conversation_id !== ev.conversation_id && ev.seq <= b.bound_seq) { ignored += 1; return { ignored: 'older conversation' }; }
    if (!b || b.conversation_id !== ev.conversation_id) {
      b = { pane_key: pk, conversation_id: ev.conversation_id, transcript_path: ev.transcript_path, cwd: ev.cwd || null, bound_seq: ev.seq, transcript_note: '', reducer: initial(ev.conversation_id) };
    } else {
      b = { ...b, transcript_path: ev.transcript_path || b.transcript_path, cwd: ev.cwd || b.cwd };
    }
    const ctx = { now: now(), noProgressMs };
    if (ev.kind === 'Stop' && ev.seq > b.reducer.last_seq) ctx.completeMessage = completeMessage(b, ev);
    const { state, transitions, changed } = reduce(b.reducer, ev, ctx);
    commit(pk, { ...b, reducer: state });
    const sids = sessionsOfPane(pk);
    if (newlyBound && service.applyPanes(st.panes)) {
      service.broadcastSnapshot(push.health); // a newly bound session moves up once
    } else if (changed || newlyBound) {
      sids.forEach(service.publishSession);
    }
    notify(pk, transitions);
    if (state.question && state.question.kind === 'permission') await readPrompt(pk);
    if (['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionStart'].includes(ev.kind)) await Promise.all(sids.map(refreshWorktree));
    return { ok: true, state: state.state };
  }

  // Events written while Matrix was offline. Processed in sequence order; a
  // file is removed only after its event is durably applied or is invalid.
  async function drainSpool() {
    let names;
    try { names = fs.readdirSync(spoolDir).filter((n) => n.endsWith('.json')).sort(); } catch (err) {
      st.collector = { ok: false, error: `evidence spool unreadable: ${err.message}` };
      return 0;
    }
    let n = 0;
    for (const name of names) {
      const file = path.join(spoolDir, name);
      let raw;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; } // still being written
      try {
        await ingest(raw);
      } catch (err) {
        if (!(err instanceof CommandError)) throw err;
        fs.renameSync(file, file + '.rejected');
        continue;
      }
      fs.unlinkSync(file);
      n += 1;
    }
    return n;
  }

  async function collect() {
    let panes;
    try {
      panes = await tmux.listPanes();
    } catch (err) {
      const was = JSON.stringify(st.collector);
      st.collector = { ok: false, error: err.message };
      if (was !== JSON.stringify(st.collector)) service.broadcastSnapshot(push.health);
      return false;
    }
    const wasOk = st.collector.ok;
    st.collector = { ok: true, error: '' };
    const membership = service.applyPanes(panes);
    if (membership || !wasOk) {
      service.broadcastSnapshot(push.health);
      for (const s of st.sessions.values()) if (!st.worktrees[s.id] && s.present) refreshWorktree(s.id).catch(() => {});
    }
    return true;
  }

  // One collection cycle: session list, dead panes, transcript progress, no-progress timers.
  async function tick() {
    const ok = await collect();
    await drainSpool();
    for (const [pk, b] of Object.entries(st.bindings)) {
      const events = [];
      const pane = st.panes.find((p) => paneKey(p) === pk);
      if (ok && (!pane || pane.dead) && !b.reducer.ended) events.push({ kind: 'pane_dead' });
      if (b.transcript_path && (b.reducer.state === 'working' || (b.reducer.state === 'stuck' && b.reducer.no_progress))) {
        if (reader(b.transcript_path).poll().grew) {
          events.push({ kind: 'transcript_progress' });
          service.broadcast('progress', { session_ids: sessionsOfPane(pk) }, { bump: false });
        }
      }
      events.push({ kind: 'timeout_check' });
      let cur = b;
      let any = false;
      for (const ev of events) {
        const r = reduce(cur.reducer, ev, { now: now(), noProgressMs });
        if (r.changed) { cur = { ...cur, reducer: r.state }; any = true; commit(pk, cur); notify(pk, r.transitions); }
      }
      if (any) sessionsOfPane(pk).forEach(service.publishSession);
      if (cur.reducer.question && cur.reducer.question.kind === 'permission' && !cur.reducer.question.choices_available) await readPrompt(pk);
    }
    flushOwed();
    const due = push.nextDue();
    if (due !== null && due <= now()) await queuePump();
    return ok;
  }

  // Validates an answer against the question that is pending right now and
  // returns the bounded key sequence. Nothing is sent for an expired question
  // or a choice that is not actually displayed.
  async function answerKeys(target, { question_id, keys }) {
    const q = target.binding.reducer.question;
    if (!q || q.id !== question_id) throw new CommandError(409, 'that question is no longer pending; nothing was sent');
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 9 || !keys.every((k) => typeof k === 'string')) throw new CommandError(400, 'keys must be a short list');
    if (q.kind === 'permission') {
      const parsed = parsePermissionPrompt(await tmux.capturePane(target.pane.paneId));
      if (!parsed.ok) throw new CommandError(409, `the terminal no longer shows a recognised prompt (${parsed.reason}); nothing was sent`);
      if (keys.length !== 1 || !parsed.options.some((o) => o.key === keys[0])) throw new CommandError(422, 'that choice is not displayed; nothing was sent');
      return [keys[0]];
    }
    if (q.kind === 'question') {
      if (!q.questions || q.questions.length !== 1) throw new CommandError(422, 'this prompt has several questions; answer it with the key buttons');
      const only = q.questions[0];
      if (!keys.every((k) => only.options.some((o) => o.key === k)) || new Set(keys).size !== keys.length) throw new CommandError(422, 'that choice is not one of the options; nothing was sent');
      if (!only.multi && keys.length !== 1) throw new CommandError(422, 'this question takes exactly one choice');
      return only.multi ? [...keys, 'Enter'] : [keys[0]];
    }
    throw new CommandError(422, 'this kind of prompt cannot be answered from Control');
  }

  return { ingest, tick, collect, drainSpool, answerKeys, queuePump, spoolDir, refreshWorktree, stats: () => ({ ignored }) };
}

module.exports = { createEvidence, HOOK_KINDS };
