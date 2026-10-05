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
import { mobileStreamSelection, clipboardAndFailure, desktopScrollLifecycle } from './browser-copy-cases.mjs';
import { copyDiagnosis } from './browser-diagnosis.mjs';
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

// Audit of every V-browser assertion for conditions that hold with the feature disabled.
// `tightened` entries were weak and were replaced; `control` names the product edit that
// makes the replacement fail. `adequate` entries were examined and left alone, with the
// reason they already discriminate.
const ASSERTION_AUDIT = {
  method: 'Each case was read assertion by assertion and asked: would this still pass if the '
    + 'behaviour it names were removed? Where the answer was yes, the assertion was retied to a '
    + 'measured quantity and a negative control was run against the delivered product.',
  tightened: [
    { id: 'A21-1', where: 'Copy::desktop_scroll_lifecycle, bottom-following',
      weakness: 'one short line of growth (~20px) compared against a fixed 120px tolerance, so the gap stayed inside the tolerance whether or not autoScroll ran',
      now: 'append 60 lines, require measured scrollHeight growth >600px, scrollTop travel within 4px of that growth, and a final bottom gap <=4px',
      control: "matrix-transcript.js autoScroll() disabled -> 'scrollTop moved 0px of 1908px', final gap 1908px; the previous assertion passed that same build (exit 0)" },
    { id: 'W2', where: 'Copy::mobile_stream_selection, Select all',
      weakness: 'end > start, satisfied by a one-character selection',
      now: 'selection range must be exactly [0, snapshot length]',
      control: "matrix-copy.js select-all set to setSelectionRange(0, 1) -> 'actual [0,1], expected [0,1337]'" },
    { id: 'W3', where: 'Brief::isolation_and_failures, rejected edit',
      weakness: "t.ok(rev >= 0) — true for every possible value, including the 0 fallback",
      now: 'the revision after the rejected edit must equal the revision before it',
      control: 'covered by W4 below; both read the same storage-failure path' },
    { id: 'W4', where: 'Brief::isolation_and_failures, unsaved edit display',
      weakness: 'a disjunction whose right-hand side the preceding assertion had just proved true, so it could not fail',
      now: 'the unsaved text must not appear as the stored goal, asserted on its own',
      control: "matrix-brief.js writes the failed edit into #brief-goal before reporting the error -> 'the unsaved edit is never presented as the stored goal' fails" },
    { id: 'W5', where: 'Copy::desktop_scroll_lifecycle, reader scrolled up',
      weakness: 'scrollTop > 0, true for a one-pixel scroll',
      now: 'the reader must be more than one viewport above the bottom, reported in px',
      control: 'shares the Resume control with W6' },
    { id: 'W6', where: 'Copy::desktop_scroll_lifecycle, Resume does not yank to the bottom',
      weakness: 'a fixed 100px floor on a transcript thousands of px tall',
      now: 'the gap must exceed one viewport height, reported in px',
      control: "matrix-transcript.js resume() forced to following=true and scrollTop=scrollHeight -> '0px above it' and the following-state assertion both fail" },
    { id: 'W7', where: 'Copy::desktop_scroll_lifecycle, mouse drag',
      weakness: 'selected.length > 0, and nothing tied the string to the transcript',
      now: '>=10 characters AND the string must appear in the transcript snapshot',
      control: 'not run separately: a drag that selects nothing already fails the byte-identity assertion three lines later, which is the behaviour this case exists to prove' },
  ],
  adequate: [
    { where: 'Copy::clipboard_and_failure round-trips', why: 'exact equality against the COPY_FIXTURE literal plus mandatory >=1 real round-trip for Copy all and separately for the nonempty subset; a spy cannot satisfy either' },
    { where: 'Copy::diagnosis_and_base_failure pruning', why: 'the unprotected control asserts the node count is capped exactly at the 1000 limit and an identified oldest node is gone, so a workload that never prunes fails' },
    { where: 'browser-diagnosis selectionLifetime.preserved', why: 'requires the recorded selection to be non-empty as well as unchanged, so an empty-vs-empty comparison cannot pass' },
    { where: 'Copy::mobile_stream_selection WebKit branch', why: 'observedPressMs is wall-clock measured and the tap is labelled a tap; the branch asserts the exact missing protocol facility by name' },
    { where: 'Brief::updates_and_overrides polling', why: 'waitForBrief throws past the deadline, and generatedAt must strictly advance on success and strictly not move on failure' },
    { where: 'assertions.mjs envelope', why: 'every expected case id is pre-registered as failed, so a crash or an omitted case reports failure rather than disappearing' },
  ],
  impracticalControls: [
    { where: 'Copy::clipboard_and_failure', why: 'disabling the real system clipboard is what the denied-clipboard branch already injects, and it is asserted in-suite; there is no further product edit that would leave the round-trip assertions passing' },
    { where: 'Copy::diagnosis_and_base_failure', why: 'its negative control is structural and permanent — every condition is measured on the frozen base commit in the same run, so the base IS the control' },
  ],
};

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

  // Every assertion in this suite was audited for conditions that stay true with the
  // feature under test switched off. What that audit found, what replaced it, and the
  // negative control that now proves each replacement bites, archived with the run.
  saveArtifact(artifactDir, 'assertion-audit.json', ASSERTION_AUDIT);

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
