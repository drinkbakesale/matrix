'use strict';
// Collecting the evidence a brief is allowed to be derived from.
//
// The only source is the exact pane Matrix is already streaming for that session — the same
// `tmux capture-pane` target, resolved from the live session identity. Transcript files under
// ~/.claude/projects are deliberately NOT used: several sessions can share one project
// directory, so "the newest .jsonl in this project" is not proof of which session wrote it.
//
// Captured text is untrusted. Lines the terminal shows as user turns ("> ...") are the only
// thing presented to a generator as a statement of intent; everything else is context.

const crypto = require('crypto');

const MAX_EVIDENCE_CHARS = 24 * 1024;
const MAX_FIELD_CHARS = 8 * 1024;
const USER_LINE = /^\s*>\s?(.*)$/;

function collapse(lines, limit) {
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > limit ? text.slice(text.length - limit) : text;
}

// Does this line introduce quoted material, so that a "> " line under it is something the
// pane is QUOTING rather than something the user said? Two shapes cover what quoting
// actually looks like in a pane: a lead-in ending in a colon ("Tool output: README says:"),
// and a line under one of Claude Code's tool/assistant glyphs. A blank line, or the start
// of the capture, is the opposite — a clean block boundary, which is where real prompts sit.
//
// This is a heuristic over plain text, and it is worth being exact about what it is not:
// `capture-pane -p` gives no styling, so nothing in the bytes *proves* authorship. Text the
// model reads can still be shaped to look like a prompt. What bounds the damage is that the
// brief is read-only prose shown to the user and the generator never acts on it, and that
// when every "> " run is rejected the service reports unavailable instead of inventing one.
const QUOTE_LEAD_IN = /(:|：)\s*$/;
const TOOL_GLYPH = /^\s*[⏺⎿]/;
function isQuotationContext(previous) {
  if (previous === null) return false;             // start of capture
  if (previous.trim() === '') return false;        // blank line: a real block boundary
  return QUOTE_LEAD_IN.test(previous) || TOOL_GLYPH.test(previous);
}

// Pull the user turns out of a captured pane in order. A turn is one or more consecutive
// "> " lines that BEGIN A BLOCK: at the start of the capture, after a blank line, or
// continuing a turn already in progress.
//
// The block rule is the provenance check, and it is the whole point. A pane contains plenty
// of "> " lines that are not user turns: a README quoted back by a file read, a diff, an
// email, a code comment. Those arrive immediately under the tool's own output with no blank
// line between, and a collector that reads "starts with >" as "the user said this" lets any
// text Claude happens to open rewrite the brief. A quoted line like that is not treated as
// intent; it stays visible in the pane-tail context item, which carries no intent at all.
// When that leaves no user turn, the service reports unavailable rather than guessing.
function userTurns(capture) {
  const turns = [];
  let buffer = [];
  let previous = null;            // null = start of capture, which is a block boundary
  for (const line of String(capture).split('\n')) {
    const match = USER_LINE.exec(line);
    if (match && (buffer.length || !isQuotationContext(previous))) {
      const body = match[1].trim();
      if (body) buffer.push(body);
      previous = line;
      continue;
    }
    if (buffer.length) { turns.push(buffer.join(' ')); buffer = []; }
    previous = line;
  }
  if (buffer.length) turns.push(buffer.join(' '));
  return turns.filter(t => t.length > 2);
}

// Early turns carry the broad purpose; recent turns carry the work in flight. They come from
// two separate bounded captures, because in a long session the opening turns scroll out of
// the tail window entirely — capturing only the tail loses the goal permanently.
//
// `capture` is the recent tail. `earlyCapture`, when supplied, is a slice of the very start
// of the pane's history; `pane-early` prefers it and falls back to the head of the tail.
function buildEvidence({ capture, earlyCapture, evidenceAt, recap }) {
  const text = typeof capture === 'string' ? capture : '';
  const earlyText = typeof earlyCapture === 'string' ? earlyCapture : '';
  const turns = userTurns(text);
  const earlyTurns = earlyText ? userTurns(earlyText) : [];
  const items = [];
  // Claude Code's own recap of the session (goal and where things stand) comes first: it is
  // the best single statement of both sentences the brief needs.
  if (recap && typeof recap.text === 'string' && recap.text.trim()) {
    items.push({ id: 'recap', role: 'recap', text: collapse([recap.text], MAX_FIELD_CHARS) });
  }
  const earlySource = earlyTurns.length ? earlyTurns.slice(0, 4) : turns.slice(0, 4);
  if (earlySource.length) {
    items.push({ id: 'pane-early', role: 'user', text: collapse(earlySource, MAX_FIELD_CHARS) });
  }
  if (turns.length && (earlyTurns.length || turns.length > 4)) {
    items.push({ id: 'pane-recent', role: 'user', text: collapse(turns.slice(-6), MAX_FIELD_CHARS) });
  }
  const tail = text.split('\n').slice(-40);
  const tailText = collapse(tail, 2048);
  if (tailText) items.push({ id: 'pane-tail', role: 'tool', text: tailText });
  let total = 0;
  const bounded = [];
  for (const item of items) {
    if (total + item.text.length > MAX_EVIDENCE_CHARS) break;
    total += item.text.length;
    bounded.push(item);
  }
  return {
    items: bounded,
    evidenceAt: Number.isFinite(evidenceAt) ? evidenceAt : Date.now(),
    fingerprint: fingerprintItems(bounded),
    hasUserEvidence: bounded.some(i => i.role === 'user' || i.role === 'recap'),
  };
}

function fingerprintItems(items) {
  const hash = crypto.createHash('sha256');
  for (const item of Array.isArray(items) ? items : []) {
    hash.update(`${item.id}\u0000${item.role}\u0000${item.text}\u0000`);
  }
  return hash.digest('hex').slice(0, 32);
}

// `capturePane` is the injected process boundary (server/lib/brief-tmux.js in production, a
// fake-process adapter in tests). It may return a plain string (tail only) or
// `{ recent, early }` from the two-capture reader. A capture failure propagates: the service
// records it as an error rather than silently reporting "no evidence".
function createEvidenceCollector({ capturePane, readRecap = null, now = Date.now, maxChars = MAX_EVIDENCE_CHARS }) {
  if (typeof capturePane !== 'function') throw new Error('evidence collector requires capturePane');
  return {
    async collect(identity) {
      if (!identity || !identity.name) throw new Error('evidence collection requires a session identity');
      if (!identity.target) throw new Error('evidence collection requires the resolved pane target');
      const raw = await capturePane(identity);
      const bound = s => (typeof s === 'string' ? s.slice(-maxChars * 4) : '');
      const capture = typeof raw === 'string' ? bound(raw) : bound(raw && raw.recent);
      const earlyCapture = typeof raw === 'string' ? '' : bound(raw && raw.early);
      const recap = readRecap ? await readRecap(identity) : null;
      return { ...buildEvidence({ capture, earlyCapture, evidenceAt: now(), recap }), target: identity.target };
    },
  };
}

module.exports = {
  createEvidenceCollector,
  buildEvidence,
  userTurns,
  fingerprintItems,
  MAX_EVIDENCE_CHARS,
};
