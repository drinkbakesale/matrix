// HTTP surface of the e-ink service: /api/eink/v1. Snapshot + SSE for reads,
// plain HTTP commands for writes. Every route is scope-checked; tokens travel
// only in the Authorization header.
const express = require('express');
const { CommandError } = require('./service');
const { StoreError } = require('./store');

function createRouter({ service, evidence, auth, push, vapidPublicKey = () => null }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // Cross-site requests are refused before any handler runs.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if ('token' in req.query || 'access_token' in req.query) return res.status(400).json({ error: 'credentials are not accepted in URLs' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'cross-site request refused' });
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* malformed origin */ }
      if (host !== req.headers.host) return res.status(403).json({ error: 'cross-origin request refused' });
    }
    next();
  });

  const need = (...scopes) => (req, res, next) => {
    const v = auth.verify(req.headers.authorization);
    if (v.error) return res.status(v.status).json({ error: v.error });
    if (!scopes.includes(v.scope)) return res.status(403).json({ error: `this ${v.scope} capability may not do that` });
    req.einkScope = v.scope;
    next();
  };

  const run = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out && out.status && out.body) return res.status(out.status).json(out.body);
      if (out !== undefined) res.json(out);
    } catch (err) {
      if (err instanceof CommandError) return res.status(err.status).json({ error: err.message, ...err.extra });
      if (err instanceof StoreError) return res.status(500).json({ error: `not saved: ${err.message}` });
      console.error('[eink] request failed:', err);
      res.status(500).json({ error: `internal error: ${err.message}` });
    }
  };

  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

  router.post('/pair', run((req) => {
    const out = auth.redeemPairCode(body(req).code, String(body(req).label || '').slice(0, 80));
    if (out.error) throw new CommandError(403, out.error);
    return { token: out.token, scope: out.scope };
  }));

  router.get('/snapshot', need('device', 'controller'), run(() => service.snapshot(push.health)));

  router.get('/events', need('device', 'controller'), (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${data}\n\n`);
    const snap = service.snapshot(push.health);
    send('snapshot', JSON.stringify({ snapshot: snap, epoch: snap.epoch, revision: snap.revision, protocol: snap.protocol }));
    const remove = service.addClient(send);
    req.on('close', remove);
  });

  router.post('/select', need('device', 'controller'), run((req) => service.select(body(req))));
  router.post('/view', need('device', 'controller'), run((req) => service.setView(body(req))));
  router.put('/draft', need('controller'), run((req) => service.putDraft(body(req))));
  router.post('/submit', need('controller'), run((req) => service.submit(body(req))));
  router.post('/bind', need('controller'), run((req) => service.bind(body(req))));

  router.post('/answer', need('controller'), run((req) => {
    const b = body(req);
    return service.sendKeysCommand('answer', b, (target) => evidence.answerKeys(target, b));
  }));

  router.post('/key', need('controller'), run((req) => {
    const b = body(req);
    return service.sendKeysCommand('key', b, () => b.keys);
  }));

  // Hook evidence: a hook-scope capability, and never through a proxy.
  router.post('/hook', need('hook'), run((req) => {
    if (req.headers['x-forwarded-for'] || req.headers['tailscale-user-login']) throw new CommandError(403, 'hook evidence is accepted only from this Mac');
    const a = req.socket.remoteAddress || '';
    if (!(a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')) throw new CommandError(403, 'hook evidence is accepted only from this Mac');
    return evidence.ingest(body(req));
  }));

  router.get('/push/vapid-key', need('controller'), run(() => {
    const key = vapidPublicKey();
    if (!key) throw new CommandError(503, 'VAPID keys are not configured; run npm run setup on the Mac');
    return { publicKey: key };
  }));
  router.post('/push/subscribe', need('controller'), run((req) => {
    const out = push.subscribe(body(req).subscription);
    if (out.error) throw new CommandError(400, out.error);
    return out;
  }));
  router.get('/push/health', need('device', 'controller'), run(() => push.health()));

  router.use((req, res) => res.status(404).json({ error: 'unknown e-ink endpoint' }));
  // Body-parser failures (oversize, malformed JSON) are explicit JSON 4xx.
  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(err.status && err.status < 500 ? err.status : 400).json({ error: err.type === 'entity.too.large' ? 'payload too large' : 'malformed request body' });
  });
  return router;
}

module.exports = { createRouter };
