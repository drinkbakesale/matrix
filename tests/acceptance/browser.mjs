// Browser acceptance runner.
//   node tests/acceptance/browser.mjs --oracle <dir> --artifacts <dir> --result <file>
//
// Serves the delivered HTML/JS/CSS over loopback and drives it in real browser engines. The
// only fakes are at the network boundary (a stubbed WebSocket, a fixture tmux, an injectable
// clock, a switchable generator) — the application DOM and rendering are never bypassed.

import path from 'node:path';
import { createRun, parseArgs } from './assertions.mjs';
import { playwright, saveArtifact } from './browser-support.mjs';
import { startFixtureServer, exportBase, baseHash } from './browser-server.mjs';
import { loadCorpus, tempDir, cleanupAll, paneFor, claudeSession } from './service-support.mjs';
import { copyDiagnosis, mobileStreamSelection, clipboardAndFailure, desktopScrollLifecycle } from './browser-copy-cases.mjs';
import { pinnedBothClients, updatesAndOverrides, isolationAndFailures } from './browser-brief-cases.mjs';

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.join(import.meta.dirname, '..', '..');
const artifactDir = args.artifacts || path.dirname(args.result || '.');
const resultFile = args.result || path.join(artifactDir, 'browser.json');

const run = createRun([
  'Copy::diagnosis_and_base_failure',
  'Copy::mobile_stream_selection',
  'Copy::clipboard_and_failure',
  'Copy::desktop_scroll_lifecycle',
  'Brief::pinned_both_clients',
  'Brief::updates_and_overrides',
  'Brief::isolation_and_failures',
]);

const corpus = loadCorpus(args.oracle);
const byId = Object.fromEntries(corpus.map(r => [r.id, r]));
const panes = { f1: paneFor(byId.f1), f2: paneFor(byId.f2), f3: paneFor(byId.f3) };

// Two sessions of the *same* project, so cross-session isolation is actually at risk.
// Session A also has a second window, so a same-name window change is exercisable.
const sessions = () => ({
  A: {
    ...claudeSession('A', panes.f1),
    projectName: 'shared-project',
    windows: [
      { name: 'claude', command: 'claude', active: true, pane: panes.f1 },
      { name: 'shell', command: 'bash', active: false, pane: '> The broad goal is reliable inventory tracking. We are currently repairing barcode import validation.\n\n$ ls\n' },
    ],
  },
  B: { ...claudeSession('B', panes.f3), createdAt: 1_600_000_100, projectName: 'shared-project' },
  // No Claude running anywhere at open, and distinct evidence per window: the case where
  // the stream keeps the bare session as its target and announces an empty window.
  C: {
    sessionId: '$C', createdAt: 1_600_000_200, projectName: 'late-start',
    windows: [
      { name: 'one', command: 'bash', active: true, pane: panes.f1 },
      { name: 'two', command: 'bash', active: false, pane: panes.f3 },
    ],
  },
});

const { webkit, chromium, devices } = playwright();
let browser = null;
let server = null;

try {
  browser = await webkit.launch();
  server = await startFixtureServer({ root: repoRoot, sessions: sessions(), storeFile: path.join(tempDir('matrix-home-'), 'briefs.json') });
  const ctx = {
    webkit, chromium, devices, repoRoot, artifactDir, panes,
    origin: server.origin,
    server,
    baseExport: exportBase(repoRoot),
    baseHash: baseHash(repoRoot),
    // Each diagnosis variant gets its own server rooted at base or candidate sources.
    startServer: root => startFixtureServer({ root, sessions: sessions(), storeFile: path.join(tempDir('matrix-home-'), 'briefs.json') }),
  };
  ctx.browser = browser;
  saveArtifact(artifactDir, 'engine.json', {
    playwright: (await import('node:module')).createRequire(import.meta.url)('playwright/package.json').version,
    webkitVersion: browser.version(),
    note: 'Desktop WebKit under Playwright is not an installed iOS PWA: no SpringBoard, no native selection handles, no OS share sheet.',
  });

  await run.runCase('Copy::diagnosis_and_base_failure', t => copyDiagnosis(ctx, t));
  await run.runCase('Copy::mobile_stream_selection', t => mobileStreamSelection(ctx, t));
  await run.runCase('Copy::clipboard_and_failure', t => clipboardAndFailure(ctx, t));
  await run.runCase('Copy::desktop_scroll_lifecycle', t => desktopScrollLifecycle(ctx, t));
  await run.runCase('Brief::pinned_both_clients', t => pinnedBothClients(ctx, t));
  await run.runCase('Brief::updates_and_overrides', t => updatesAndOverrides(ctx, t));
  await run.runCase('Brief::isolation_and_failures', t => isolationAndFailures(ctx, t));
} catch (err) {
  console.error('runner failed:', err && err.stack || err);
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
  cleanupAll();
  run.finish(resultFile, path.join(artifactDir, 'browser-trace.json'));
}
