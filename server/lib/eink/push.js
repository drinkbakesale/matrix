// Durable notification outbox for the control PWA. One transition is enqueued
// once (keyed by its transition id) and delivered once per subscription.
// Delivery state survives restarts; repeated hooks, replays and reconnects
// cannot enqueue or resend an acknowledged transition.
const crypto = require('crypto');

const MAX_ATTEMPTS = 4;
const RETRY_MS = [5000, 30000, 120000];
const KEEP_TRANSITIONS = 500;
const TITLES = { needs_input: 'needs your input', done: 'finished', stuck: 'is stuck' };

function createPush({ store, send, vapidReady = () => true, now = () => Date.now(), onHealth = () => {} }) {
  let doc = store.readJson('outbox.json', { subscriptions: [], transitions: [] });
  let lastError = '';
  let diskError = '';
  const save = () => store.writeJson('outbox.json', doc);
  const subId = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

  function subscribe(sub) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys) {
      return { error: 'invalid push subscription' };
    }
    const id = subId(sub.endpoint);
    const next = { ...doc, subscriptions: doc.subscriptions.filter((s) => s.id !== id).concat([{ id, sub, created_at: now() }]) };
    store.writeJson('outbox.json', next);
    doc = next;
    onHealth();
    return { id };
  }

  // enqueue(transition) -> true when new. target/label are safe to show; no
  // draft text, transcript text or secrets ever enter a payload.
  function enqueue({ id, kind, session_id, label }) {
    if (doc.transitions.some((t) => t.id === id)) return false;
    const next = JSON.parse(JSON.stringify(doc));
    next.transitions.push({
      id, kind, session_id, label, created_at: now(),
      deliveries: doc.subscriptions.map((s) => ({ sub: s.id, status: 'pending', attempts: 0, next_at: now() })),
    });
    if (next.transitions.length > KEEP_TRANSITIONS) next.transitions = next.transitions.slice(-KEEP_TRANSITIONS);
    store.writeJson('outbox.json', next); // a failed write throws: the transition is not claimed as queued
    doc = next;
    return true;
  }

  function payload(t) {
    return JSON.stringify({
      title: `${t.label} ${TITLES[t.kind] || t.kind}`,
      body: t.kind === 'needs_input' ? 'Open Control to answer.' : t.kind === 'stuck' ? 'Open Control to look.' : 'Turn ended.',
      tag: t.id, // stable tag: a provider retry replaces, never stacks
      event_id: t.id,
      kind: t.kind,
      target: t.session_id,
      url: `/control/?session=${encodeURIComponent(t.session_id)}`,
    });
  }

  // Attempts every due delivery once. Returns the number of provider calls.
  async function pump() {
    if (!vapidReady()) { lastError = 'VAPID keys are not configured'; return 0; }
    let calls = 0;
    for (const t of doc.transitions) {
      for (const d of t.deliveries) {
        if (d.status !== 'pending' || d.next_at > now()) continue;
        const s = doc.subscriptions.find((x) => x.id === d.sub);
        if (!s) { d.status = 'dropped'; continue; }
        calls += 1;
        d.attempts += 1;
        try {
          await send(s.sub, payload(t));
          d.status = 'delivered';
          d.delivered_at = now();
        } catch (err) {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) {
            d.status = 'dropped';
            doc.subscriptions = doc.subscriptions.filter((x) => x.id !== s.id);
            lastError = `subscription ${s.id} expired (HTTP ${code}) and was removed; re-enable notifications on that device`;
          } else if (d.attempts >= MAX_ATTEMPTS) {
            d.status = 'failed';
            lastError = `delivery failed after ${d.attempts} attempts: ${err && err.message}`;
          } else {
            d.next_at = now() + RETRY_MS[Math.min(d.attempts - 1, RETRY_MS.length - 1)];
            lastError = `delivery failed (attempt ${d.attempts}), will retry: ${err && err.message}`;
          }
        }
        try { save(); } catch (err) { lastError = `cannot persist delivery state: ${err.message}`; throw err; }
      }
    }
    onHealth();
    return calls;
  }

  function nextDue() {
    let due = null;
    for (const t of doc.transitions) for (const d of t.deliveries) if (d.status === 'pending' && (due === null || d.next_at < due)) due = d.next_at;
    return due;
  }

  function health() {
    const pending = doc.transitions.reduce((n, t) => n + t.deliveries.filter((d) => d.status === 'pending').length, 0);
    const failed = doc.transitions.reduce((n, t) => n + t.deliveries.filter((d) => d.status === 'failed').length, 0);
    const problems = [];
    if (!vapidReady()) problems.push('VAPID keys are not configured (run npm run setup)');
    if (doc.subscriptions.length === 0) problems.push('no device has enabled notifications in Control');
    if (failed) problems.push(`${failed} notification(s) failed permanently`);
    if (diskError) problems.push(diskError);
    if (lastError) problems.push(lastError);
    return { ok: problems.length === 0, subscriptions: doc.subscriptions.length, pending, failed, detail: problems.join('; ') };
  }

  return { subscribe, enqueue, pump, nextDue, health, _doc: () => doc, clearError: () => { lastError = ''; }, reportError: (msg) => { diskError = msg; } };
}

module.exports = { createPush };
