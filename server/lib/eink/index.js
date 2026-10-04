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
  const router = createRouter({ service, evidence, auth, push, vapidPublicKey: () => (vapid() ? vapid().publicKey : null) });
  app.use(BASE, router);

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
  tick();
  return { ...parts, router, close: () => timers.forEach(clearInterval) };
}

// A second, TLS-only listener for the RM2 on the home LAN. It serves nothing
// but the e-ink API and exists only when a certificate has been provisioned.
function listenTls({ router, fs = require('fs'), home, port, host = '0.0.0.0' }) {
  const dir = path.join(home, 'eink', 'tls');
  let key; let cert;
  try {
    key = fs.readFileSync(path.join(dir, 'key.pem'));
    cert = fs.readFileSync(path.join(dir, 'cert.pem'));
  } catch (err) {
    if (err.code === 'ENOENT') return { started: false, reason: 'no LAN certificate provisioned (run scripts/matrix-eink setup-tls)' };
    throw err;
  }
  const tlsApp = express();
  tlsApp.disable('x-powered-by');
  tlsApp.use(BASE, router);
  tlsApp.use((req, res) => res.status(404).json({ error: 'only the e-ink API is served here' }));
  const server = require('https').createServer({ key, cert, minVersion: 'TLSv1.2' }, tlsApp);
  server.listen(port, host);
  return { started: true, server };
}

module.exports = { mount, build, listenTls, BASE };
