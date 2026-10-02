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

// Pull the user turns out of a captured pane in order. A turn is one or more consecutive
// "> " lines; blank and decorative lines are dropped.
function userTurns(capture) {
  const turns = [];
  let buffer = [];
  for (const line of String(capture).split('\n')) {
    const match = USER_LINE.exec(line);
    if (match) {
      const body = match[1].trim();
      if (body) buffer.push(body);
      continue;
    }
    if (buffer.length) { turns.push(buffer.join(' ')); buffer = []; }
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
function buildEvidence({ capture, earlyCapture, evidenceAt }) {
  const text = typeof capture === 'string' ? capture : '';
  const earlyText = typeof earlyCapture === 'string' ? earlyCapture : '';
  const turns = userTurns(text);
  const earlyTurns = earlyText ? userTurns(earlyText) : [];
  const items = [];
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
    hasUserEvidence: bounded.some(i => i.role === 'user'),
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
function createEvidenceCollector({ capturePane, now = Date.now, maxChars = MAX_EVIDENCE_CHARS }) {
  if (typeof capturePane !== 'function') throw new Error('evidence collector requires capturePane');
  return {
    async collect(identity) {
      if (!identity || !identity.name) throw new Error('evidence collection requires a session identity');
      if (!identity.target) throw new Error('evidence collection requires the resolved pane target');
      const raw = await capturePane(identity);
      const bound = s => (typeof s === 'string' ? s.slice(-maxChars * 4) : '');
      const capture = typeof raw === 'string' ? bound(raw) : bound(raw && raw.recent);
      const earlyCapture = typeof raw === 'string' ? '' : bound(raw && raw.early);
      return { ...buildEvidence({ capture, earlyCapture, evidenceAt: now() }), target: identity.target };
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
