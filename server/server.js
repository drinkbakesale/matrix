const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');

const config = require('./lib/matrix-config');
const { BuildInboxError, runBuildInbox, buildInboxErrorResponse } = require('./lib/build-inbox');
const notifyRoutes = require('./lib/notify-routes');
const voiceRoutes = require('./lib/voice-routes');
const projectRoutes = require('./lib/project-routes');
const paneStream = require('./lib/pane-stream');
const { listLiveSessions, sweepAttention, setGoalSource } = require('./lib/sessions');
const { createRowGoals } = require('./lib/row-goals');
const { createRowLabeler } = require('./lib/row-labeler');
const { createClaudeCli } = require('./lib/claude-cli');
const claudeCli = createClaudeCli({ bin: process.env.MATRIX_CLAUDE_BIN || 'claude' });
const { createTmux, createSessionResolver, createPaneCapture } = require('./lib/brief-tmux');
const { createEvidenceCollector } = require('./lib/brief-evidence');
const { createRecapReader } = require('./lib/brief-recap');
const { createExtractiveGenerator, createClaudeCliGenerator } = require('./lib/brief-generator');
const { BriefService, resolveEvidenceInterval } = require('./lib/brief-service');
const briefRoutes = require('./lib/brief-routes');

config.bootstrap();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

notifyRoutes.loadVapid();
voiceRoutes.ensureWhisperServer();
voiceRoutes.ensureSoundServer();

// No-cache headers for development
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// E-ink workstation (RM2 display + iPad control): its own scoped API, mounted
// before the legacy body parser so its limits and auth apply to its routes only.
const eink = require('./lib/eink').mount(app, {
  home: config.MATRIX_HOME,
  // web-push is a process-wide singleton, so the VAPID details notify-routes set apply here too.
  webpush: require('web-push'),
  vapid: notifyRoutes.hasVapid,
});
app.use(express.json());

notifyRoutes.mount(app);
voiceRoutes.mount(app);
projectRoutes.mount(app);
require('./lib/new-session-routes').mount(app, {
  router: require('./lib/session-router').createSessionRouter({
    cli: createClaudeCli({ bin: process.env.MATRIX_CLAUDE_BIN || 'claude', timeoutMs: 120000 }),
    model: process.env.MATRIX_ROUTER_MODEL || undefined,
  }),
  launcher: require('./lib/session-launcher').createSessionLauncher(),
});

app.get('/api/sessions', (req, res) => {
  listLiveSessions().then(sessions => res.json({ sessions }), err => {
    console.error('[sessions] listing failed:', err.message);
    res.status(500).json({ error: `tmux listing failed: ${err.message}` });
  });
});

// ── Session briefs ──
// The extractive generator ships as the default because it only ever returns text that is
// literally present in the session's own pane, so it cannot invent a goal and its accuracy
// is measurable offline. Set MATRIX_BRIEF_GENERATOR=claude to summarise with the installed
// `claude` CLI instead (richer, but its accuracy is not measured by this repository).
function selectGenerator() {
  if ((process.env.MATRIX_BRIEF_GENERATOR || 'extractive').toLowerCase() !== 'claude') {
    return { generator: createExtractiveGenerator(), literalRequired: true };
  }
  return {
    generator: createClaudeCliGenerator({
      execFile,
      bin: process.env.MATRIX_CLAUDE_BIN || 'claude',
      model: process.env.MATRIX_BRIEF_MODEL || 'claude-haiku-4-5-20251001',
    }),
    literalRequired: false,
  };
}

const { generator, literalRequired } = selectGenerator();
// Shell-free, async, bounded tmux access for briefs only; the window the client streams is
// what gets resolved and captured.
const briefTmux = createTmux({});
const briefResolver = createSessionResolver({ tmux: briefTmux });
const briefCapture = createPaneCapture({ tmux: briefTmux });
const briefService = new BriefService({
  storeFile: config.BRIEF_PATH,
  resolveSession: (name, window, options) => briefResolver.resolve(name, window, options),
  collector: createEvidenceCollector({
    capturePane: identity => briefCapture.capture(identity),
    // Claude Code's own "※ recap" for the bound pane, via the hook's session-links record.
    readRecap: (reader => identity => reader.read(identity))(
      createRecapReader({ linksDir: path.join(config.MATRIX_HOME, 'session-links') })),
  }),
  generator,
  literalRequired,
  // Validated, not trusted: MATRIX_BRIEF_INTERVAL_MS may shorten the evidence interval but
  // cannot push it past the 30s ceiling, and a garbage value falls back to the default.
  evidenceIntervalMs: resolveEvidenceInterval(process.env.MATRIX_BRIEF_INTERVAL_MS, {
    onClamp: (asked, max) => console.error(`[brief] MATRIX_BRIEF_INTERVAL_MS=${asked} exceeds the ${max}ms maximum; using ${max}ms`),
  }),
  onError: err => console.error(`[brief] ${err.code || 'error'}: ${err.message}`),
});
briefRoutes.mountExpress(app, briefService);
// Evidence polling is cheap; the service itself enforces the 30s evidence interval and the
// one-job-per-session / one-generator-globally bounds.
setInterval(() => {
  briefService.tick().catch(err => console.error('[brief] tick:', err.message));
}, 5000);

// ── Build Inbox (read-only controller summary for the mobile pinned row) ──
// Fixed command: the absolute buildctl binary with `inbox --json`. No request data is used.
const BUILD_INBOX_ARGS = Object.freeze(['inbox', '--json']);
let buildInboxInFlight = null;

app.get('/api/build-inbox', async (req, res) => {
  try {
    if (!buildInboxInFlight) {
      buildInboxInFlight = runBuildInbox({ binary: config.BUILDCTL_PATH, args: BUILD_INBOX_ARGS, execFile })
        .finally(() => { buildInboxInFlight = null; });
    }
    const summary = await buildInboxInFlight;
    res.json({ ok: true, generatedAt: Date.now(), ...summary });
  } catch (err) {
    console.error(`[build-inbox] ${err instanceof BuildInboxError ? err.code : 'error'}: ${err.message}`);
    const { status, body } = buildInboxErrorResponse(err);
    res.status(status).json(body);
  }
});

paneStream.attach(wss, { port: config.PORT });

setInterval(sweepAttention, 10000);

// Row goal lines: refreshed in the background from each session's latest recap.
const rowGoals = createRowGoals({
  linksDir: path.join(config.MATRIX_HOME, 'session-links'),
  labelsFile: path.join(config.MATRIX_HOME, 'row-labels.json'),
  labeler: createRowLabeler({ cli: claudeCli, model: process.env.MATRIX_ROW_LABEL_MODEL || undefined }),
});
setGoalSource(name => rowGoals.get(name));
const refreshRowGoals = () => listLiveSessions().then(list => rowGoals.refresh(list.map(s => s.name)),
  err => console.error('[row-goals] session list failed:', err.message));
refreshRowGoals();
setInterval(refreshRowGoals, 15000);

server.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Matrix running on http://0.0.0.0:${config.PORT}`);
  console.log(`Config directory: ${config.MATRIX_HOME}`);
  console.log(`SSE notifications enabled (${notifyRoutes.sseClients.size} clients)`);
  console.log(`Brief generator: ${generator.name}`);
  if (!notifyRoutes.hasVapid()) {
    console.log('WARNING: Push notifications disabled — run "npm run setup" to configure VAPID keys');
  }
  if (eink.router) {
    const tlsPort = parseInt(process.env.MATRIX_EINK_TLS_PORT, 10) || 7779;
    const tls = require('./lib/eink').listenTls({ router: eink.router, home: config.MATRIX_HOME, port: tlsPort });
    console.log(tls.started ? `E-ink LAN endpoint (TLS) on ${tls.address}:${tlsPort} only` : `E-ink LAN endpoint not started: ${tls.reason}`);
  }
});
