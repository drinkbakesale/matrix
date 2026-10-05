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
// A ceiling, not a default. Sentence two is supposed to track the work as it changes, so an
// interval longer than this is a brief that is allowed to go stale. Deployment config may
// lower the interval; it must not be able to raise it.
const MAX_EVIDENCE_INTERVAL_MS = 30000;
const DEFAULT_GENERATION_TIMEOUT_MS = 30000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const OPEN_SESSION_TTL_MS = 2 * 60 * 1000;

// A tmux name is bounded, not pattern-restricted. It is matched by exact equality against
// the live listing and never becomes part of a tmux target, so the characters tmux allows in
// one — `.`, `:`, `/`, `|`, spaces — are all simply names here. What is still refused is what
// no live name can be: a control character (which cannot survive argv or JSON cleanly) and
// an unbounded string.
const MAX_NAME_CHARS = 200;
const nameInRange = value => typeof value === 'string' && value.length > 0
  && value.length <= MAX_NAME_CHARS && !/[\u0000-\u001f]/.test(value);

class BriefRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BriefRequestError';
    this.status = status;
    this.code = code;
  }
}

// A client either knows which pane its stream resolved, or it does not. A bare window name
// is the old call shape and is authoritative by virtue of naming something; `''` on its own
// is "not told yet"; `{ window: '', authoritative: true }` is the stream saying "the session
// itself, no window" — the three states the empty string alone cannot express.
// Returns null for a shape that is not a binding at all.
function normalizeBinding(binding) {
  if (binding === undefined || binding === null) return { window: '', authoritative: false };
  if (typeof binding === 'string') return { window: binding, authoritative: binding !== '' };
  if (typeof binding !== 'object' || Array.isArray(binding)) return null;
  const window = binding.window === undefined || binding.window === null ? '' : binding.window;
  if (typeof window !== 'string') return null;
  return { window, authoritative: !!binding.authoritative || window !== '' };
}

// Turns a configured interval (a number, or the raw string a deployment put in the
// environment) into one the service may actually run at. Garbage and non-positive values
// fall back to the default rather than to "never"; anything above the ceiling is capped and
// reported through `onClamp` so the operator sees that their setting was overruled.
function resolveEvidenceInterval(value, { onClamp } = {}) {
  const asked = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_EVIDENCE_INTERVAL_MS;
  if (asked > MAX_EVIDENCE_INTERVAL_MS) {
    if (onClamp) onClamp(asked, MAX_EVIDENCE_INTERVAL_MS);
    return MAX_EVIDENCE_INTERVAL_MS;
  }
  return asked;
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
    // Capped here rather than at the caller: the bootstrap reads this straight out of the
    // environment, so the only place the ceiling cannot be bypassed is below that read.
    this.evidenceIntervalMs = resolveEvidenceInterval(evidenceIntervalMs, { onClamp: (asked, max) => onError(
      Object.assign(new Error(`evidence interval ${asked}ms exceeds the ${max}ms maximum; using ${max}ms`), { code: 'interval_capped' })) });
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

  // Resolve a client-supplied tmux name and the window the client is actually streaming
  // against the live session list. A name that is not live (including a forged path)
  // resolves to nothing and is rejected. Resolution is asynchronous and cached at the
  // process boundary, so a request never blocks the event loop on tmux.
  async identityFor(name, binding) {
    // A session name is also the URL path segment this endpoint is addressed by, so a
    // separator that the route could never carry is refused here rather than silently
    // 404ing later. (tmux rewrites `.` and `:` out of session names itself, and a session
    // name holding a slash is unreachable through `/api/sessions/:name/brief` either way.)
    if (!nameInRange(name) || /[/\\]/.test(name)) {
      throw new BriefRequestError(400, 'invalid_session', 'session name is not a valid tmux session name');
    }
    const bound = normalizeBinding(binding);
    if (!bound) throw new BriefRequestError(400, 'invalid_window', 'window binding is not valid');
    // A window name is never part of a URL or a target, only of an equality test, so the
    // only bound it needs is the bound every tmux window name already satisfies.
    if (bound.window !== '' && !nameInRange(bound.window)) {
      throw new BriefRequestError(400, 'invalid_window', 'window is not a valid tmux window name');
    }
    // Only a session name, a window name and a boolean cross this line. The client never
    // supplies a tmux target, so it cannot address a pane of its own choosing.
    const identity = await this.resolveSession(name, bound.window, { authoritative: bound.authoritative });
    if (!identity || identity.name !== name) {
      throw new BriefRequestError(404, 'unknown_session', 'no live session with that name');
    }
    if (identity.windowKnown === false) {
      throw new BriefRequestError(404, 'unknown_window', 'that window is not open in this session');
    }
    // Resolution produced no tmux identifier for this pane, so there is nothing that can be
    // addressed without guessing. Fail closed rather than fall back to a name.
    if (!identity.target) {
      throw new BriefRequestError(404, 'unresolved_target', 'that pane has no resolved tmux identifier');
    }
    return identity;
  }

  async read(name, binding) {
    const identity = await this.identityFor(name, binding);
    const key = sessionKey(identity);
    const state = this.runtimeFor(key);
    state.lastAccess = this.now();
    state.window = identity.window || '';
    state.bound = !!identity.bound;
    // Scheduling only enqueues; generation never happens on the request path.
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
      session: {
        name: identity.name,
        sessionId: identity.sessionId || '',
        createdAt: identity.createdAt ?? null,
        window: identity.window || '',
        target: identity.target || identity.name,
      },
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
  async patch(name, body, binding) {
    const identity = await this.identityFor(name, binding);
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

  // Called by the host on a timer. Re-checks every session a client still has open, on the
  // exact window that client is streaming.
  async tick() {
    const now = this.now();
    for (const [key, state] of [...this.runtime]) {
      if (now - state.lastAccess > OPEN_SESSION_TTL_MS) { this.runtime.delete(key); continue; }
      const [name] = key.split('\u0000');
      let identity = null;
      // Re-resolve on the binding this session was last read with, not on a bare window
      // string: an authoritative empty window must not turn into discovery here either.
      const binding = { window: state.window || '', authoritative: !!state.bound };
      try { identity = await this.identityFor(name, binding); } catch { identity = null; }
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
      // Re-checked on the same binding the job was scheduled under.
      const live = await this.resolveSession(identity.name, identity.window || '', { authoritative: !!identity.bound });
      if (!live || sessionKey(live) !== key) return;
      const record = this.store.get(identity);
      // Source freshness moves only when the SOURCE really changed, and "changed" has to be
      // judged against what was last generated from — not against runtime state alone.
      // `state.fingerprint` is per-process and null after a restart, so comparing with it by
      // itself made the first background check of an unchanged pane look like freshly read
      // evidence: evidenceAt jumped to the poll time while generatedAt correctly stood still,
      // which is precisely the pair that is supposed to tell the user nothing has moved.
      const lastGenerated = state.fingerprint !== null ? state.fingerprint : record.generated.fingerprint;
      if (evidence.fingerprint !== lastGenerated) state.evidenceAt = evidence.evidenceAt;
      state.fingerprint = evidence.fingerprint;
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
        // A field the new evidence does not restate keeps its last supported value. The
        // pane is a rolling window: once the opening turns scroll past the capture, a
        // current-work-only result must not erase the goal the session actually stated.
        if (result.goal) next.generated.goal = result.goal.text;
        if (result.current) next.generated.current = result.current.text;
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

module.exports = {
  BriefService, BriefRequestError, resolveEvidenceInterval,
  DEFAULT_EVIDENCE_INTERVAL_MS, MAX_EVIDENCE_INTERVAL_MS, DEFAULT_GENERATION_TIMEOUT_MS, MAX_BACKOFF_MS,
};
