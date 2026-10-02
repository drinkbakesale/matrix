'use strict';
// Durable storage for per-session briefs.
//
// A brief belongs to one tmux *incarnation*, never to a tmux name: a session called `41`
// that is killed and recreated is a different session and must not inherit the previous
// brief or its user edits. The key therefore folds the tmux session id and creation time in.
//
// Generated text and user overrides are stored in separate fields so a late generation can
// refresh the generated value without ever clobbering an edit, and clearing one override
// restores that field's newest generated value while leaving the other edit alone.

const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const MAX_FIELD_CHARS = 500;
const FIELDS = Object.freeze(['goal', 'current']);

class BriefStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BriefStoreError';
    this.code = code;
  }
}

// Identity of one live session incarnation. `name` alone is not a key.
function sessionKey(identity) {
  if (!identity || typeof identity.name !== 'string' || !identity.name) {
    throw new BriefStoreError('invalid_identity', 'session identity requires a name');
  }
  const id = typeof identity.sessionId === 'string' ? identity.sessionId : '';
  const created = identity.createdAt === undefined || identity.createdAt === null ? '' : String(identity.createdAt);
  // Control characters and the separator cannot appear in a tmux id/name we accept.
  return [identity.name, id, created].map(part => String(part).replace(/[\u0000-\u001f]/g, '')).join('\u0000');
}

function emptyRecord(identity) {
  return {
    name: identity.name,
    sessionId: identity.sessionId || '',
    createdAt: identity.createdAt === undefined ? null : identity.createdAt,
    overrides: { goal: null, current: null },
    generated: { goal: null, current: null, generatedAt: null, evidenceAt: null, fingerprint: null, source: null },
    revision: 0,
    updatedAt: null,
  };
}

function normalizeRecord(raw, identity) {
  const base = emptyRecord(identity);
  if (!raw || typeof raw !== 'object') return base;
  const out = base;
  for (const field of FIELDS) {
    const value = raw.overrides && raw.overrides[field];
    out.overrides[field] = typeof value === 'string' ? value.slice(0, MAX_FIELD_CHARS) : null;
    const gen = raw.generated && raw.generated[field];
    out.generated[field] = typeof gen === 'string' ? gen.slice(0, MAX_FIELD_CHARS) : null;
  }
  const g = raw.generated || {};
  out.generated.generatedAt = Number.isFinite(g.generatedAt) ? g.generatedAt : null;
  out.generated.evidenceAt = Number.isFinite(g.evidenceAt) ? g.evidenceAt : null;
  out.generated.fingerprint = typeof g.fingerprint === 'string' ? g.fingerprint : null;
  out.generated.source = typeof g.source === 'string' ? g.source : null;
  out.revision = Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  out.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : null;
  return out;
}

// A corrupt or unreadable store must not silently become "no overrides": callers surface
// `loadError` so the UI can say the stored edits could not be read.
class BriefStore {
  constructor({ file, fsImpl = fs, now = Date.now } = {}) {
    if (!file) throw new BriefStoreError('invalid_config', 'brief store requires a file path');
    this.file = file;
    this.fs = fsImpl;
    this.now = now;
    this.sessions = new Map();
    this.loadError = null;
    this.load();
  }

  load() {
    this.sessions = new Map();
    this.loadError = null;
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      this.loadError = `brief storage unreadable (${err.code || err.message})`;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.loadError = 'brief storage is corrupt and was not used';
      return;
    }
    if (!parsed || parsed.version !== STORE_VERSION || !parsed.sessions || typeof parsed.sessions !== 'object') {
      this.loadError = `brief storage version ${parsed && parsed.version} is not supported`;
      return;
    }
    for (const [key, raw] of Object.entries(parsed.sessions)) {
      if (!raw || typeof raw.name !== 'string') continue;
      this.sessions.set(key, normalizeRecord(raw, {
        name: raw.name,
        sessionId: raw.sessionId,
        createdAt: raw.createdAt,
      }));
    }
  }

  get(identity) {
    const key = sessionKey(identity);
    const existing = this.sessions.get(key);
    return existing ? existing : emptyRecord(identity);
  }

  // Apply `mutate` to a copy of the record and persist. A write failure throws so no caller
  // can report an edit as saved when it was not.
  update(identity, mutate) {
    const key = sessionKey(identity);
    const current = this.get(identity);
    const next = JSON.parse(JSON.stringify(current));
    mutate(next);
    next.name = identity.name;
    next.sessionId = identity.sessionId || '';
    next.createdAt = identity.createdAt === undefined ? null : identity.createdAt;
    next.revision = current.revision + 1;
    next.updatedAt = this.now();
    const previous = this.sessions.get(key);
    this.sessions.set(key, next);
    try {
      this.persist();
    } catch (err) {
      if (previous) this.sessions.set(key, previous);
      else this.sessions.delete(key);
      throw new BriefStoreError('storage_write_failed', `could not save the brief (${err.code || err.message})`);
    }
    return next;
  }

  persist() {
    const payload = { version: STORE_VERSION, sessions: Object.fromEntries(this.sessions) };
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    this.fs.renameSync(tmp, this.file);
  }
}

module.exports = { BriefStore, BriefStoreError, sessionKey, FIELDS, MAX_FIELD_CHARS, STORE_VERSION };
