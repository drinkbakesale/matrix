// Mounts the e-ink workstation service on the Matrix express app.
const path = require('path');
const express = require('express');
const { createStore } = require('./store');
const { createAuth } = require('./auth');
const { createTmux } = require('./tmux');
const { createGit } = require('./gitfiles');
const { createPush } = require('./push');
const { createService } = require('./service');
const { createEvidence } = require('./evidence');
const { createRouter } = require('./router');
const { validateBind, isLoopback } = require('./ingress');

const BASE = '/api/eink/v1';

// build() wires the service from its external boundaries. Tests pass fakes
// for the outside world only (fs, tmux/git binaries, push sender, clock).
function build({ home, fs = require('fs'), now = () => Date.now(), tmuxBin, gitBin, execFile, sendPush, vapidReady, noProgressMs, transcriptRoot }) {
  const store = createStore({ dir: path.join(home, 'eink'), fs });
  const auth = createAuth({ store, now });
  const tmux = createTmux({ bin: tmuxBin, execFile });
  const git = createGit({ bin: gitBin, execFile });
  const service = createService({ store, tmux, now });
  const push = createPush({ store, send: sendPush, vapidReady, now });
  const evidence = createEvidence({ service, store, tmux, git, push, fs, now, noProgressMs, transcriptRoot });
  return { store, auth, tmux, git, service, push, evidence };
}

function mount(app, { home, webpush, vapid = () => null, pollMs = parseInt(process.env.MATRIX_EINK_POLL_MS, 10) || 2000, heartbeatMs = 2000 }) {
  let parts;
  try {
    parts = build({
      home,
      sendPush: (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' }),
      vapidReady: () => !!vapid(),
    });
  } catch (err) {
    // A corrupt state file must not become an empty-looking workstation.
    console.error(`[eink] NOT STARTED: ${err.message}`);
    app.use(BASE, (req, res) => res.status(503).json({ error: `e-ink service not started: ${err.message}` }));
    return { error: err, close() {} };
  }
  const { service, evidence, auth, push } = parts;
  const api = createRouter({ service, evidence, auth, push, vapidPublicKey: () => (vapid() ? vapid().publicKey : null) });
  // Nothing is answered until the first session collection has finished (or failed, which the
  // snapshot then states). A client that reconnects the instant Matrix restarts must never be told
  // "no sessions" merely because tmux had not been asked yet: it would blank and repaint every row.
  let firstCollection;
  const router = express.Router();
  router.use((req, res, next) => { firstCollection.then(() => next()); });
  router.use(api);
  // On Matrix's main listener (which the legacy views bind to every interface) the e-ink API is
  // served only to connections that arrived on loopback: the local hook and Tailscale Serve's proxy.
  // LAN clients must use the pinned TLS listener; nothing else can reach the API.
  app.use(BASE, (req, res, next) => {
    if (!isLoopback(req.socket.localAddress)) return res.status(403).json({ error: 'the e-ink API is not served on this interface' });
    next();
  }, router);

  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await evidence.tick(); } catch (err) {
      service.st.collector = { ok: false, error: `collector failed: ${err.message}` };
      console.error('[eink] collector failed:', err);
    } finally { ticking = false; }
  };
  const timers = [
    setInterval(tick, pollMs),
    setInterval(() => service.broadcast('heartbeat', {}, { bump: false }), heartbeatMs),
  ];
  firstCollection = tick();
  return { ...parts, router, close: () => timers.forEach(clearInterval) };
}

// A second, TLS-only listener for the RM2 on the home LAN. It serves nothing but the e-ink API,
// exists only when a certificate has been provisioned, and binds exactly one validated private
// (or loopback) address of this Mac: never a wildcard, never a public address.
function listenTls({ router, fs = require('fs'), home, port, bind = process.env.MATRIX_EINK_TLS_BIND, interfaces }) {
  const dir = path.join(home, 'eink', 'tls');
  let key; let cert;
  try {
    key = fs.readFileSync(path.join(dir, 'key.pem'));
    cert = fs.readFileSync(path.join(dir, 'cert.pem'));
  } catch (err) {
    if (err.code === 'ENOENT') return { started: false, reason: 'no LAN certificate provisioned (run scripts/matrix-eink setup-tls --bind <LAN address>)' };
    throw err;
  }
  if (bind === undefined) {
    try { bind = JSON.parse(fs.readFileSync(path.join(home, 'eink', 'listen.json'), 'utf8')).address; } catch (err) {
      if (err.code !== 'ENOENT') return { started: false, reason: `eink/listen.json is unreadable: ${err.message}` };
    }
  }
  const v = validateBind(bind, interfaces);
  if (!v.ok) return { started: false, reason: `refusing to open the RM2 listener: ${v.reason}` };
  const tlsApp = express();
  tlsApp.disable('x-powered-by');
  tlsApp.use(BASE, router);
  tlsApp.use((req, res) => res.status(404).json({ error: 'only the e-ink API is served here' }));
  const server = require('https').createServer({ key, cert, minVersion: 'TLSv1.2' }, tlsApp);
  server.on('error', (err) => console.error(`[eink] RM2 listener on ${v.addr}:${port} failed: ${err.message}`));
  server.listen({ port, host: v.addr, ipv6Only: true });
  return { started: true, server, address: v.addr };
}

module.exports = { mount, build, listenTls, BASE };
