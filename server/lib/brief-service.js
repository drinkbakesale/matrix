'use strict';
// Per-session brief cache, scheduling and edit handling.
//
// Nothing expensive happens on a request: `read()` always answers from the store/cache and
// only *schedules* work. Generation is bounded (one job per session, one generator globally,
// a capped evidence payload and a capped runtime) and is driven by `tick()`, so the caller
// owns the clock and tests never wait on real time.

const { BriefStore, BriefStoreError, sessionKey, FIELDS, MAX_FIELD_CHARS } = require('./brief-store');
const { validateBriefOutput, BriefGenerationError } = require('./brief-generator');

const DEFAULT_EVIDENCE_INTERVAL_MS = 30000;
const DEFAULT_GENERATION_TIMEOUT_MS = 30000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const OPEN_SESSION_TTL_MS = 2 * 60 * 1000;

class BriefRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BriefRequestError';
    this.status = status;
    this.code = code;
  }
}

function validOverride(value) {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  if (value.length > MAX_FIELD_CHARS) return false;
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

class BriefService {
  constructor({
    storeFile,
    resolveSession,
    collector,
    generator,
    now = Date.now,
    fsImpl,
    evidenceIntervalMs = DEFAULT_EVIDENCE_INTERVAL_MS,
    generationTimeoutMs = DEFAULT_GENERATION_TIMEOUT_MS,
    literalRequired = true,
    onError = () => {},
  }) {
    if (typeof resolveSession !== 'function') throw new Error('brief service requires resolveSession');
    this.store = new BriefStore({ file: storeFile, fsImpl, now });
    this.resolveSession = resolveSession;
    this.collector = collector;
    this.generator = generator;
    this.now = now;
    this.evidenceIntervalMs = evidenceIntervalMs;
    this.generationTimeoutMs = generationTimeoutMs;
    this.literalRequired = literalRequired;
    this.onError = onError;
    this.runtime = new Map();   // key -> { lastCheck, running, error, unavailable, attempts, nextAttemptAt, evidenceAt, fingerprint, lastAccess }
    this.generatorBusy = false;
    this.pending = [];
    this.jobs = new Set();
  }

  runtimeFor(key) {
    if (!this.runtime.has(key)) {
      this.runtime.set(key, {
        lastCheck: 0, running: false, error: null, unavailable: null,
        attempts: 0, nextAttemptAt: 0, evidenceAt: null, fingerprint: null, lastAccess: 0,
      });
    }
    return this.runtime.get(key);
  }

  // Resolve a client-supplied tmux name against the live session list. A name that is not
  // live (including a forged path) resolves to nothing and is rejected.
  identityFor(name) {
    if (typeof name !== 'string' || !name || name.length > 200 || /[\u0000-\u001f/\\]/.test(name)) {
      throw new BriefRequestError(400, 'invalid_session', 'session name is not a valid tmux session name');
    }
    const identity = this.resolveSession(name);
    if (!identity || identity.name !== name) {
      throw new BriefRequestError(404, 'unknown_session', 'no live session with that name');
    }
    return identity;
  }

  read(name) {
    const identity = this.identityFor(name);
    const key = sessionKey(identity);
    const state = this.runtimeFor(key);
    state.lastAccess = this.now();
    this.schedule(identity);
    return this.snapshot(identity, key);
  }

  snapshot(identity, key) {
    const record = this.store.get(identity);
    const state = this.runtimeFor(key);
    const effective = {};
    for (const field of FIELDS) {
      effective[field] = record.overrides[field] !== null ? record.overrides[field] : record.generated[field];
    }
    const hasText = FIELDS.some(f => typeof effective[f] === 'string' && effective[f]);
    let status;
    if (hasText) status = 'ok';
    else if (state.running || this.isQueued(key)) status = 'generating';
    else if (state.error) status = 'error';
    else if (state.unavailable) status = 'unavailable';
    else status = 'generating';
    return {
      session: { name: identity.name, sessionId: identity.sessionId || '', createdAt: identity.createdAt ?? null },
      goal: effective.goal ?? null,
      current: effective.current ?? null,
      generated: { goal: record.generated.goal, current: record.generated.current },
      overrides: { goal: record.overrides.goal, current: record.overrides.current },
      revision: record.revision,
      status,
      generatedAt: record.generated.generatedAt,
      evidenceAt: state.evidenceAt !== null ? state.evidenceAt : record.generated.evidenceAt,
      stale: !!(hasText && (state.error || state.unavailable)),
      error: state.error,
      unavailable: state.unavailable,
      source: record.generated.source,
      storageError: this.store.loadError,
      generator: this.generator ? this.generator.name : null,
    };
  }

  isQueued(key) {
    return this.pending.some(job => job.key === key);
  }

  // Edits are per field. `null` clears that field's override and restores the newest
  // generated value for it, leaving the other field's edit untouched.
  patch(name, body) {
    const identity = this.identityFor(name);
    const key = sessionKey(identity);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BriefRequestError(400, 'invalid_body', 'body must be an object');
    }
    const allowed = new Set(['goal', 'current', 'revision']);
    for (const prop of Object.keys(body)) {
      if (!allowed.has(prop)) throw new BriefRequestError(400, 'unknown_field', `unknown field: ${prop}`);
    }
    const edits = {};
    for (const field of FIELDS) {
      if (!(field in body)) continue;
      if (!validOverride(body[field])) {
        throw new BriefRequestError(400, 'invalid_value', `${field} must be a string of at most ${MAX_FIELD_CHARS} characters, or null`);
      }
      edits[field] = body[field] === null ? null : body[field].trim();
    }
    if (Object.keys(edits).length === 0) throw new BriefRequestError(400, 'no_edit', 'no goal or current field supplied');
    const record = this.store.get(identity);
    if (!Number.isInteger(body.revision)) throw new BriefRequestError(400, 'invalid_revision', 'revision must be an integer');
    if (body.revision !== record.revision) {
      throw new BriefRequestError(409, 'revision_conflict', `brief changed since revision ${body.revision}`);
    }
    try {
      this.store.update(identity, next => {
        for (const [field, value] of Object.entries(edits)) {
          next.overrides[field] = value === null || value === '' ? null : value;
        }
      });
    } catch (err) {
      if (err instanceof BriefStoreError) throw new BriefRequestError(500, err.code, err.message);
      throw err;
    }
    return this.snapshot(identity, key);
  }

  schedule(identity) {
    const key = sessionKey(identity);
    const state = this.runtimeFor(key);
    const now = this.now();
    if (state.running || this.isQueued(key)) return false;
    if (now < state.nextAttemptAt) return false;
    if (state.lastCheck && now - state.lastCheck < this.evidenceIntervalMs) return false;
    state.lastCheck = now;
    this.pending.push({ key, identity });
    this.drain();
    return true;
  }

  // Called by the host on a timer. Re-checks every session a client still has open.
  tick() {
    const now = this.now();
    for (const [key, state] of this.runtime) {
      if (now - state.lastAccess > OPEN_SESSION_TTL_MS) { this.runtime.delete(key); continue; }
      const [name] = key.split('\u0000');
      let identity = null;
      try { identity = this.identityFor(name); } catch { identity = null; }
      if (!identity || sessionKey(identity) !== key) continue;
      this.schedule(identity);
    }
    this.drain();
  }

  drain() {
    if (this.generatorBusy || this.pending.length === 0) return;
    const job = this.pending.shift();
    this.generatorBusy = true;
    const promise = this.runJob(job).finally(() => {
      this.generatorBusy = false;
      this.jobs.delete(promise);
      if (this.pending.length) this.drain();
    });
    this.jobs.add(promise);
  }

  // Wait for every queued job — tests only.
  async settle() {
    while (this.jobs.size || this.pending.length) {
      await Promise.all([...this.jobs]);
      if (!this.generatorBusy && this.pending.length) this.drain();
    }
  }

  async runJob({ key, identity }) {
    const state = this.runtimeFor(key);
    state.running = true;
    try {
      const evidence = await this.collector.collect(identity);
      // A session whose identity changed while the job ran is a different session now.
      const live = this.resolveSession(identity.name);
      if (!live || sessionKey(live) !== key) return;
      if (evidence.fingerprint !== state.fingerprint) {
        state.fingerprint = evidence.fingerprint;
        state.evidenceAt = evidence.evidenceAt;
      }
      const record = this.store.get(identity);
      if (record.generated.fingerprint === evidence.fingerprint && (record.generated.goal || record.generated.current)) {
        state.error = null;
        state.attempts = 0;
        return;                      // unchanged evidence never re-runs the generator
      }
      if (!evidence.hasUserEvidence) {
        state.unavailable = 'no session evidence yet — nothing in this pane says what it is working on';
        state.error = null;
        state.attempts = 0;
        return;
      }
      const raw = await this.withTimeout(this.generator.generate({ items: evidence.items }));
      const result = validateBriefOutput(raw, evidence.items, { literalRequired: this.literalRequired });
      if (result.status === 'unavailable') {
        state.unavailable = result.reason;
        state.error = null;
        state.attempts = 0;
        return;
      }
      this.store.update(identity, next => {
        next.generated.goal = result.goal ? result.goal.text : null;
        next.generated.current = result.current ? result.current.text : null;
        next.generated.generatedAt = this.now();
        next.generated.evidenceAt = evidence.evidenceAt;
        next.generated.fingerprint = evidence.fingerprint;
        next.generated.source = this.generator.name;
      });
      state.error = null;
      state.unavailable = null;
      state.attempts = 0;
    } catch (err) {
      state.attempts += 1;
      state.nextAttemptAt = this.now() + Math.min(this.evidenceIntervalMs * 2 ** state.attempts, MAX_BACKOFF_MS);
      state.error = err instanceof BriefGenerationError || err instanceof BriefStoreError
        ? err.message
        : 'brief generation failed';
      this.onError(err);
    } finally {
      state.running = false;
    }
  }

  withTimeout(promise) {
    // The adapter enforces its own process timeout; this is the service-level ceiling so a
    // hung generator can never pin the single global slot.
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BriefGenerationError('generator_timeout', 'brief generation timed out')), this.generationTimeoutMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }
}

module.exports = { BriefService, BriefRequestError, DEFAULT_EVIDENCE_INTERVAL_MS };
