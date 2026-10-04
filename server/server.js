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
const { listLiveSessions, sweepAttention } = require('./lib/sessions');
const { createTmux, createSessionResolver, createPaneCapture } = require('./lib/brief-tmux');
const { createEvidenceCollector } = require('./lib/brief-evidence');
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
app.use(express.json());

notifyRoutes.mount(app);
voiceRoutes.mount(app);
projectRoutes.mount(app);

app.get('/api/sessions', (req, res) => {
  res.json({ sessions: listLiveSessions() });
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
  collector: createEvidenceCollector({ capturePane: identity => briefCapture.capture(identity) }),
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

server.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Matrix running on http://0.0.0.0:${config.PORT}`);
  console.log(`Config directory: ${config.MATRIX_HOME}`);
  console.log(`SSE notifications enabled (${notifyRoutes.sseClients.size} clients)`);
  console.log(`Brief generator: ${generator.name}`);
  if (!notifyRoutes.hasVapid()) {
    console.log('WARNING: Push notifications disabled — run "npm run setup" to configure VAPID keys');
  }
});
