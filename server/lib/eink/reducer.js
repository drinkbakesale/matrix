// Deterministic digest reducer for one Claude conversation bound to one tmux
// pane. Code decides the state from typed hook evidence; no model is asked
// and nothing is guessed. Missing evidence stays "unavailable" with a reason.
const { WRITE_TOOLS } = require('./transcript');

const NO_PROGRESS_MS_DEFAULT = 10 * 60 * 1000;
const MAX_APPLIED = 2000;

function initial(conversationId) {
  return {
    conversation_id: conversationId,
    turn: 0,
    state: 'unavailable',
    state_reason: 'No turn observed since the evidence hook attached to this session',
    prompt: { available: false, text: '', reason: 'No prompt observed since the evidence hook attached' },
    message: { available: false, text: '', reason: 'No completed Claude message observed since the evidence hook attached' },
    question: null,
    tool_paths: [],
    progress_at: 0,
    last_seq: 0,
    turn_seq: 0,
    stuck_count: 0,
    no_progress: false,
    ended: false,
    applied: [],
  };
}

const active = (s) => s.state === 'working' || s.state === 'needs_input' || (s.state === 'stuck' && s.no_progress);

function questionFromTool(ev) {
  const qs = ev.tool_input && Array.isArray(ev.tool_input.questions) ? ev.tool_input.questions : null;
  const id = ev.tool_use_id || ev.event_id;
  if (!qs || qs.length === 0) {
    return { id, kind: 'question', text: 'Claude asked a question', questions: [], options: [], choices_available: false, reason: 'question payload had no readable questions' };
  }
  const questions = qs.map((q, qi) => ({
    index: qi,
    text: String(q.question || q.header || ''),
    multi: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).map((o, oi) => ({ key: String(oi + 1), label: o.description ? `${o.label} — ${o.description}` : String(o.label) })),
  }));
  const flat = [];
  questions.forEach((q) => q.options.forEach((o) => flat.push({ key: questions.length > 1 ? `${q.index + 1}.${o.key}` : o.key, label: o.label })));
  const text = questions.map((q, i) => (questions.length > 1 ? `(${i + 1}) ` : '') + q.text + (q.multi ? ' [choose any]' : '')).join('\n');
  return { id, kind: 'question', text, questions, options: flat, choices_available: flat.length > 0, reason: flat.length ? '' : 'question had no options' };
}

function permissionQuestion(ev) {
  const what = ev.tool_name ? `Permission needed: ${ev.tool_name}` : (ev.message || 'Claude needs your permission');
  return {
    id: ev.event_id, kind: 'permission', text: what, questions: [], options: [],
    // Hook permission_suggestions are NOT the displayed choices; the choices are
    // read from the terminal by the prompt adapter, or reported unavailable.
    choices_available: false, reason: 'displayed choices not read from the terminal yet',
  };
}

// reduce(state, event, ctx) -> { state, transitions[], changed }
// ctx: { now, completeMessage?: {available,text,reason}, noProgressMs? }
function reduce(prev, ev, ctx = {}) {
  const s = JSON.parse(JSON.stringify(prev));
  const transitions = [];
  const now = ctx.now || 0;
  const before = { state: prev.state, qid: prev.question && prev.question.id };

  const finish = () => {
    const qid = s.question && s.question.id;
    if (s.state !== before.state || (s.state === 'needs_input' && qid !== before.qid)) {
      if (s.state === 'needs_input') transitions.push({ kind: 'needs_input', id: `${s.conversation_id}:${s.turn}:needs_input:${qid || ''}` });
      if (s.state === 'done') transitions.push({ kind: 'done', id: `${s.conversation_id}:${s.turn}:done` });
      if (s.state === 'stuck') transitions.push({ kind: 'stuck', id: `${s.conversation_id}:${s.turn}:stuck:${s.stuck_count}` });
    }
    return { state: s, transitions, changed: JSON.stringify(s) !== JSON.stringify(prev) };
  };

  if (ev.kind === 'timeout_check') {
    const limit = ctx.noProgressMs || NO_PROGRESS_MS_DEFAULT;
    if (s.state === 'working' && s.progress_at > 0 && now - s.progress_at >= limit) {
      s.state = 'stuck';
      s.no_progress = true;
      s.stuck_count += 1;
      s.state_reason = `No progress observed for ${Math.round(limit / 60000)} minutes`;
    }
    return finish();
  }
  if (ev.kind === 'transcript_progress') {
    if (active(s)) {
      s.progress_at = now;
      if (s.state === 'stuck' && s.no_progress) { s.state = 'working'; s.no_progress = false; s.state_reason = ''; }
    }
    return finish();
  }
  if (ev.kind === 'pane_dead') {
    if (s.state === 'working' || s.state === 'needs_input') {
      s.state = 'stuck'; s.no_progress = false; s.stuck_count += 1; s.question = null;
      s.state_reason = 'The pane running Claude ended during a working turn';
    }
    s.ended = true;
    return finish();
  }

  // Hook evidence: exactly-once by event id, never regressing in time.
  if (ev.event_id) {
    if (s.applied.includes(ev.event_id)) return finish();
    s.applied.push(ev.event_id);
    if (s.applied.length > MAX_APPLIED) s.applied = s.applied.slice(-MAX_APPLIED);
  }
  const late = ev.seq <= s.last_seq;
  if (late) {
    // An old event cannot change state, prompt, message or question. A
    // successful write from the current turn is still a true fact and is kept.
    if (ev.kind === 'PostToolUse' && WRITE_TOOLS.has(ev.tool_name) && ev.seq > s.turn_seq && ev.file_path && !s.tool_paths.includes(ev.file_path)) {
      s.tool_paths.push(ev.file_path);
    }
    return finish();
  }
  s.last_seq = ev.seq;
  const progress = () => {
    s.progress_at = now;
    if (s.state === 'stuck' && s.no_progress) { s.state = 'working'; s.no_progress = false; s.state_reason = ''; }
  };

  switch (ev.kind) {
    case 'UserPromptSubmit':
      s.turn += 1;
      s.turn_seq = ev.seq;
      s.state = 'working';
      s.state_reason = '';
      s.no_progress = false;
      s.ended = false;
      s.stuck_count = 0;
      s.question = null;
      s.tool_paths = [];
      s.prompt = typeof ev.prompt === 'string'
        ? { available: true, text: ev.prompt, reason: '' }
        : { available: false, text: '', reason: 'prompt hook carried no prompt text' };
      s.progress_at = now;
      break;
    case 'PreToolUse':
      if (s.turn === 0) break;
      progress();
      if (ev.tool_name === 'AskUserQuestion') {
        s.question = questionFromTool(ev);
        s.state = 'needs_input';
        s.state_reason = '';
      } else if (s.question) {
        s.question = null; // Claude moved on: the earlier prompt was resolved
        s.state = 'working';
      }
      break;
    case 'PermissionRequest':
      if (s.turn === 0) break;
      s.question = permissionQuestion(ev);
      s.state = 'needs_input';
      s.state_reason = '';
      s.no_progress = false;
      break;
    case 'Notification': {
      if (s.turn === 0) break;
      const type = ev.notification_type || (/permission/i.test(ev.message || '') ? 'permission_prompt' : '');
      if (type === 'permission_prompt' && s.state !== 'done') {
        if (!(s.question && s.question.kind === 'permission')) s.question = permissionQuestion(ev);
        s.state = 'needs_input';
        s.state_reason = '';
      } else if (type === 'elicitation_dialog' && s.state !== 'done') {
        s.question = { id: ev.event_id, kind: 'elicitation', text: ev.message || 'A tool is asking for input', questions: [], options: [], choices_available: false, reason: 'elicitation choices are not exposed to hooks' };
        s.state = 'needs_input';
      }
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (s.turn === 0) break;
      progress();
      if (s.question && (s.question.kind !== 'question' || ev.tool_name === 'AskUserQuestion')) s.question = null;
      if (!s.question && (s.state === 'needs_input' || s.state === 'working')) s.state = 'working';
      if (ev.kind === 'PostToolUse' && WRITE_TOOLS.has(ev.tool_name) && ev.file_path && !s.tool_paths.includes(ev.file_path)) s.tool_paths.push(ev.file_path);
      break;
    case 'Stop':
      if (s.turn === 0) break;
      s.question = null;
      s.state = 'done';
      // "done" means the turn ended. Background work Claude left running is stated, not hidden.
      s.state_reason = ev.background_tasks ? `turn ended; ${ev.background_tasks} background task(s) still running` : '';
      s.no_progress = false;
      s.message = ctx.completeMessage || { available: false, text: '', reason: 'turn ended but no completed message could be read' };
      break;
    case 'StopFailure':
      if (s.turn === 0) break;
      s.question = null;
      s.state = 'stuck';
      s.no_progress = false;
      s.stuck_count += 1;
      s.state_reason = `Turn ended with an error: ${ev.error || 'no detail reported'}`;
      break;
    case 'SessionEnd':
      s.ended = true;
      if (s.state === 'working' || s.state === 'needs_input') {
        s.state = 'stuck'; s.no_progress = false; s.stuck_count += 1; s.question = null;
        s.state_reason = 'Claude ended during a working turn';
      }
      break;
    case 'SessionStart':
      s.ended = false;
      break;
    default: // SubagentStart/SubagentStop/PreCompact and friends are progress only
      if (active(s)) progress();
  }
  return finish();
}

module.exports = { initial, reduce, NO_PROGRESS_MS_DEFAULT };
