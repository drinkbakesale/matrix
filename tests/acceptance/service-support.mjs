// Fixtures and fakes for the brief acceptance runners.
//
// The fake is a fake *process*: it stands in for `execFile('tmux', ...)` and nothing else.
// Everything above it — session/window resolution, the two-capture pane reader, the
// evidence collector, the generator, the validator, the store, the service and the HTTP
// routes — is the delivered production code. Replacing tmux with an in-memory resolver
// would skip exactly the boundary that has to be proved shell-free and bounded.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  tempDir, fakeClock, fakeCli, claudeSession, paneFor, countingGenerator, fakeTmuxProcess, sleep,
  paneStreamProbe,
} from './assertions.mjs';

const require = createRequire(import.meta.url);

// Generic fixtures live in assertions.mjs, which imports nothing from this file, so they
// cannot create a cycle with the delivered server modules loaded below. Re-exported
// here so every runner and case module keeps importing them from one place.
export {
  tempDir, cleanupAll, fakeClock, argAfter, fakeCli, claudeSession, shellActiveSession,
  paneFor, countingGenerator, loadCorpus, sleep, fakeTmuxProcess, lastLines, paneStreamProbe,
} from './assertions.mjs';
const LIB = path.join(import.meta.dirname, '..', '..', 'server', 'lib');

export const briefStore = require(path.join(LIB, 'brief-store.js'));
export const briefEvidence = require(path.join(LIB, 'brief-evidence.js'));
export const briefGenerator = require(path.join(LIB, 'brief-generator.js'));
export const briefServiceMod = require(path.join(LIB, 'brief-service.js'));
export const briefRoutes = require(path.join(LIB, 'brief-routes.js'));
export const briefTmux = require(path.join(LIB, 'brief-tmux.js'));


// The delivered resolver/capture stack on the fake process, with the SHIPPED defaults.
// Nothing here may relax caching or identity validation: a helper that quietly disabled a
// cache would hide exactly the class of staleness these cases exist to catch.
export function tmuxStack(fake, { timeoutMs = 5000, recentLines = 400, earlyLines = 120 } = {}) {
  const tmux = briefTmux.createTmux({ execFileImpl: fake.execFileImpl, timeoutMs });
  const resolver = briefTmux.createSessionResolver({ tmux });
  const capture = briefTmux.createPaneCapture({ tmux, recentLines, earlyLines });
  return { tmux, resolver, capture };
}

export function makeService(opts) {
  const { stack, clock, generator, storeFile, evidenceIntervalMs = 30000,
    literalRequired = true, generationTimeoutMs = 30000, fsImpl } = opts;
  return new briefServiceMod.BriefService({
    storeFile,
    resolveSession: (name, windowName, options) => stack.resolver.resolve(name, windowName, options),
    collector: briefEvidence.createEvidenceCollector({
      capturePane: identity => stack.capture.capture(identity),
      now: clock.now,
    }),
    generator,
    now: clock.now,
    fsImpl,
    evidenceIntervalMs,
    generationTimeoutMs,
    literalRequired,
  });
}


// What the stream announces, and whether the brief follows it — returned as labelled
// [actual, expected, detail] triples the runner asserts, plus a raw report to archive.
//
// Two halves. First, the real pane-stream module is run against a fake tmux for three
// window layouts, so the announcement itself is observed rather than assumed. Then the
// "no Claude at open" case is driven end to end: a connection that finds no Claude keeps
// the bare session as its target and announces an EMPTY window, and that announcement is
// authoritative — the brief must stay on the session pane even once Claude starts in
// another window, and only a reconnect may move it.
export async function streamBindingChecks({ clock, generator, storeFile, activePane, otherPane, expect }) {
  const checks = [];
  // The probe's tmux issues `@<index>` for window <index> and `$9` for the session, so the
  // expected target is an identifier tmux reported, never one spelled out of the names.
  for (const [label, windows, window, target] of [
    ['Claude in window one', [['one', 'claude'], ['two', 'bash']], 'one', '@0'],
    ['Claude moved to window two', [['one', 'bash'], ['two', 'claude']], 'two', '@1'],
    ['no Claude anywhere', [['one', 'bash'], ['two', 'bash']], '', '$9'],
  ]) {
    const probe = paneStreamProbe({ session: 'A', windows });
    checks.push([probe.first && probe.first.type, 'stream-target', `${label}: the connection announces its target first`]);
    checks.push([probe.first && probe.first.window, window, `${label}: the announcement names the window pane-stream picked`]);
    checks.push([probe.first && probe.first.target, target, `${label}: the announced target is the one the stream polls`]);
    checks.push([probe.types.indexOf('stream-target') < probe.types.indexOf('output'), true,
      `${label}: the binding is announced before the scrollback the client renders`]);
  }
  const report = await emptyBindingScenario({ clock, generator, storeFile, activePane, otherPane });
  checks.push(
    [report.briefAtOpen, report.streamAtOpen, 'the brief opens on the pane the stream is polling'],
    [report.goalAtOpen, expect.activeGoal, 'with no Claude running it describes the window being streamed'],
    [report.briefAfterStart, report.streamAtOpen, 'Claude starting in another window does not re-point an open brief'],
    [report.goalAfterStart, expect.activeGoal, 'the other window\'s work never takes over the open session'],
    [report.editTarget, report.streamAtOpen, 'an edit is addressed to the pane the user can see'],
    [report.briefAtReconnect, report.streamAtReconnect, 'a reconnect re-binds to the window it discovered'],
    [report.goalAfterReconnect, expect.otherGoal, 'and the brief then describes that window'],
    [report.overrideAfterReconnect, null, 'the edit stayed with the pane it was made against'],
    [report.unboundTarget, report.discoveredTarget, 'a client that has not been told yet still gets discovery'],
  );
  return { checks, report };
}

async function emptyBindingScenario({ clock, generator, storeFile, activePane, otherPane }) {
  // What a connection opening right now would resolve: the Claude window's id, or — with no
  // Claude running — the session's own id, which is the unambiguous form of the old bare
  // session target.
  const streamBinding = (session, fake) => {
    const claude = (session.windows || []).find(w => briefTmux.isClaudeCmd(w.command));
    return claude
      ? { window: claude.name, target: fake.windowId('C', claude.name) }
      : { window: '', target: fake.sessionIdOf('C') };
  };
  const noClaude = {
    sessionId: '$C', createdAt: 1_600_000_000,
    windows: [
      { name: 'one', command: 'bash', active: true, pane: activePane },
      { name: 'two', command: 'bash', active: false, pane: otherPane },
    ],
  };
  const fake = fakeTmuxProcess({ C: noClaude });
  const service = makeService({ stack: tmuxStack(fake), clock, generator, storeFile });

  const atOpen = streamBinding(noClaude, fake);
  let binding = { window: atOpen.window, authoritative: true };
  await service.read('C', binding);
  await service.settle();
  const opened = await service.read('C', binding);

  // Claude starts in the inactive window. The open connection still polls `-t C`.
  const claudeElsewhere = { ...noClaude, windows: [
    { name: 'one', command: 'bash', active: true, pane: activePane },
    { name: 'two', command: 'claude', active: false, pane: otherPane },
  ] };
  fake.set('C', claudeElsewhere);
  const polled = await service.read('C', binding);
  clock.advance(31000);
  await service.tick();
  await service.settle();
  const held = await service.read('C', binding);
  const edited = await service.patch('C', { goal: 'edit against the streamed pane', revision: held.revision }, binding);

  // Reconnect: a new connection discovers Claude and announces the window it found.
  const atReconnect = streamBinding(claudeElsewhere, fake);
  binding = { window: atReconnect.window, authoritative: true };
  const reconnected = await service.read('C', binding);
  clock.advance(31000);
  await service.tick();
  await service.settle();
  const rebound = await service.read('C', binding);
  // A client that has not been told yet still gets discovery, so a fresh open is not stuck.
  const unbound = await service.read('C', '');

  return {
    streamAtOpen: atOpen.target, briefAtOpen: opened.session.target, goalAtOpen: opened.goal,
    briefAfterStart: polled.session.target, goalAfterStart: held.goal,
    editTarget: edited.session.target,
    streamAtReconnect: atReconnect.target, briefAtReconnect: reconnected.session.target,
    goalAfterReconnect: rebound.goal, overrideAfterReconnect: rebound.overrides.goal,
    unboundTarget: unbound.session.target, discoveredTarget: fake.windowId('C', 'two'),
  };
}

// The evidence interval is a frozen MAXIMUM, and the production bootstrap reads it out of
// the environment (`MATRIX_BRIEF_INTERVAL_MS`) straight into the service. So the cap has to
// hold below that read, and a deployment must not be able to configure a brief that
// refreshes later than the maximum. Checked both at the validator and behaviourally.
export async function evidenceIntervalChecks({ clock, generator, storeFile, pane1, pane2, expect }) {
  const max = briefServiceMod.MAX_EVIDENCE_INTERVAL_MS;
  const fallback = briefServiceMod.DEFAULT_EVIDENCE_INTERVAL_MS;
  const checks = [[max, 30000, 'the frozen evidence-interval maximum is 30s']];
  // Exactly the values a deployment could put in the environment, through the exact helper
  // the bootstrap calls.
  for (const [raw, want, detail] of [
    ['600000', max, 'a ten-minute configured interval is capped at the maximum'],
    ['86400000', max, 'a one-day configured interval is capped at the maximum'],
    [600000, max, 'a numeric over-long interval is capped too'],
    ['5000', 5000, 'a shorter configured interval is honoured'],
    ['', fallback, 'an empty value falls back to the default, not to never'],
    ['nonsense', fallback, 'a garbage value falls back to the default'],
    ['-1', fallback, 'a negative value falls back to the default'],
    ['0', fallback, 'zero falls back to the default'],
    [undefined, fallback, 'an unset variable falls back to the default'],
  ]) checks.push([briefServiceMod.resolveEvidenceInterval(raw), want, detail]);

  // Behaviourally: a service constructed with an over-long interval still picks up changed
  // work one frozen maximum later, not one configured interval later.
  const fake = fakeTmuxProcess({ P: claudeSession('P', pane1) });
  const service = makeService({ stack: tmuxStack(fake), clock, generator, storeFile, evidenceIntervalMs: 600000 });
  await service.read('P');
  await service.settle();
  const first = await service.read('P');
  fake.set('P', claudeSession('P', pane2));
  clock.advance(max);
  await service.tick();
  await service.settle();
  const after = await service.read('P');
  checks.push(
    [service.evidenceIntervalMs, max, 'a service asked for a longer interval runs at the maximum'],
    [first.current, expect.firstCurrent, 'the session starts on its own first evidence'],
    [after.current, expect.secondCurrent, 'changed work is picked up one frozen maximum later, not one configured interval later'],
  );
  return { checks, report: { maxMs: max, configuredMs: 600000, effectiveMs: service.evidenceIntervalMs } };
}

// A24-2. The AGGREGATE evidence bound, measured on what actually crosses the boundary.
// Exported constants and per-item lengths say nothing about the total: a collector that
// kept every item, or a CLI adapter that stopped slicing, would still satisfy both.
export async function aggregateEvidenceChecks({ dir, execFile }) {
  const out = [];
  const cap = briefEvidence.MAX_EVIDENCE_CHARS;
  // Ten items, each individually legal, together far over the aggregate cap.
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `bulk-${i}`, role: i === 9 ? 'tool' : 'user', text: `> turn ${i} ` + 'z'.repeat(8000),
  }));
  const supplied = items.reduce((n, i) => n + i.text.length, 0);
  out.push([supplied > cap * 2, true, `aggregate: the fixture really is oversized (${supplied} chars for a ${cap} cap)`]);

  const built = briefEvidence.buildEvidence({
    capture: items.map(i => i.text).join('\n'), earlyCapture: '', evidenceAt: 1,
  });
  const collected = built.items.reduce((n, i) => n + i.text.length, 0);
  const perItem = 8 * 1024;   // the collector's own per-item collapse limit
  // The single-enormous-turn case the old inline check covered, kept beside the rest.
  const oneHuge = briefEvidence.buildEvidence({ capture: `> ${'x'.repeat(200000)}\n`, evidenceAt: 1 });
  out.push([oneHuge.items.every(i => i.text.length <= perItem), true,
    'aggregate: one enormous turn is capped per item as well']);
  out.push(
    [collected <= cap, true, `aggregate: the collector's items total within the cap (${collected} <= ${cap})`],
    [built.items.every(i => i.text.length <= perItem), true,
      `aggregate: and no single collected item exceeds ${perItem} chars`],
  );

  // The binding aggregate bound is in the CLI adapter, not the collector: the collector
  // emits at most three items whose per-item caps already sum below the aggregate cap, so
  // its own ceiling is unreachable by construction and asserting it would prove nothing.
  // What CAN be measured is the payload the adapter actually writes to the process.
  const cli = fakeCli(dir, { stdout: '{"unavailable":"none"}' });
  const gen = briefGenerator.createClaudeCliGenerator({ execFile, bin: cli.bin, timeoutMs: 5000, cwd: dir });
  await gen.generate({ items: [] });
  const headerOnly = cli.read().stdin.length;      // the fixed prompt, measured not guessed
  await gen.generate({ items });
  const { stdin } = cli.read();
  out.push(
    [stdin.length <= headerOnly + cap, true,
      `aggregate: the CLI stdin payload is bounded (${stdin.length} <= ${headerOnly} prompt + ${cap} evidence)`],
    [stdin.length < supplied, true, `aggregate: and is far smaller than the evidence handed in (${stdin.length} < ${supplied})`],
    [stdin.includes('bulk-0'), true, 'aggregate: the kept head of the evidence really did reach the CLI'],
    [stdin.includes('bulk-9'), false, 'aggregate: and the tail beyond the cap really was dropped'],
  );
  return out;
}

// A24-3. Persistence is ATOMIC: the live file is replaced, never written through. With a
// saved override already on disk, a failure injected BEFORE the replacement must leave the
// previous complete record readable now and after a restart, and must not be acknowledged.
export async function atomicPersistenceChecks({ clock, storeFile, pane }) {
  const out = [];
  const fake = fakeTmuxProcess({ A: claudeSession('A', pane) });
  const gen = briefGenerator.createExtractiveGenerator();
  let service = makeService({ stack: tmuxStack(fake), clock, generator: gen, storeFile });
  await service.read('A'); await service.settle();
  const saved = await service.patch('A', { goal: 'the override already on disk', revision: (await service.read('A')).revision });
  out.push([saved.goal, 'the override already on disk', 'atomic: a complete record is saved before the failure']);

  // Real fs, except that the replacement step fails. A store that wrote the live file
  // directly would never reach renameSync and would therefore succeed here.
  const writes = [];
  const renames = [];
  const failing = {
    ...fs,
    writeFileSync: (f, d, o) => { writes.push(String(f)); return fs.writeFileSync(f, d, o); },
    renameSync: (a, b) => { renames.push([String(a), String(b)]); throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
  };
  service = makeService({ stack: tmuxStack(fake), clock, generator: gen, storeFile, fsImpl: failing });
  const before = await service.read('A');
  let err = null;
  try { await service.patch('A', { goal: 'this must never be acknowledged', revision: before.revision }); } catch (e) { err = e; }
  out.push(
    [err && err.status, 500, 'atomic: a persistence failure is an error, never a success'],
    [writes.some(f => f !== storeFile && f.startsWith(storeFile)), true,
      `atomic: the write went to a temporary beside the live file, not through it (${JSON.stringify(writes)})`],
    [writes.includes(storeFile), false, 'atomic: the live file was never written directly'],
    [renames.length > 0, true, 'atomic: replacement of the live file was attempted'],
    [(await service.read('A')).goal, 'the override already on disk', 'atomic: the in-memory record is rolled back to the saved one'],
  );

  // A restart reads the file off disk: the previous complete record must still be there.
  service = makeService({ stack: tmuxStack(fake), clock, generator: gen, storeFile });
  const restarted = await service.read('A');
  out.push(
    [restarted.goal, 'the override already on disk', 'atomic: the file on disk still holds the previous complete record'],
    [restarted.storageError, null, 'atomic: and it is not corrupt'],
    [fs.readFileSync(storeFile, 'utf8').includes('this must never be acknowledged'), false,
      'atomic: the unacknowledged edit never reached the file'],
  );
  return out;
}

// A24-4. evidenceAt and generatedAt mean different things and must move independently:
// evidenceAt is how fresh the SOURCE is, generatedAt is when a generation last SUCCEEDED.
// Nothing asserted either before, so a service that returned polling time as evidenceAt,
// or simply echoed generatedAt, would have been indistinguishable.
export async function timestampChecks({ clock, storeFile, pane1, pane2 }) {
  const out = [];
  const fake = fakeTmuxProcess({ A: claudeSession('A', pane1) });
  const gen = countingGenerator(briefGenerator.createExtractiveGenerator());
  let service = makeService({ stack: tmuxStack(fake), clock, generator: gen, storeFile });
  await service.read('A'); await service.settle();
  const first = await service.read('A');
  out.push(
    [Number.isFinite(first.evidenceAt), true, `timestamps: a generated brief reports when its evidence was read (${first.evidenceAt})`],
    [Number.isFinite(first.generatedAt), true, 'timestamps: and when it was generated'],
  );

  // Polling with UNCHANGED evidence must not make the old evidence look freshly read.
  clock.advance(31000);
  await service.tick(); await service.settle();
  const polled = await service.read('A');
  out.push(
    [polled.evidenceAt, first.evidenceAt, 'timestamps: unchanged evidence does not refresh evidenceAt to the polling time'],
    [polled.generatedAt, first.generatedAt, 'timestamps: and does not move generatedAt either'],
    [polled.evidenceAt !== clock.now(), true, `timestamps: evidenceAt is not just "now" (${polled.evidenceAt} vs ${clock.now()})`],
  );

  // CHANGED evidence moves both, and they are not the same number by construction.
  fake.set('A', claudeSession('A', pane2));
  clock.advance(31000);
  const atChange = clock.now();
  await service.tick(); await service.settle();
  clock.advance(5000);
  const changed = await service.read('A');
  out.push(
    [changed.evidenceAt > first.evidenceAt, true, `timestamps: changed evidence moves evidenceAt (${first.evidenceAt} -> ${changed.evidenceAt})`],
    [changed.evidenceAt, atChange, 'timestamps: to when that evidence was actually read, not to the read time'],
    [changed.generatedAt >= atChange, true, 'timestamps: and generatedAt advances on the successful generation'],
  );

  // A FAILED refresh keeps the last successful generatedAt while still reporting freshness.
  const failing = { name: 'extractive', version: '1', generate: async () => { throw new briefGenerator.BriefGenerationError('generator_failed', 'NCfail'); } };
  fake.set('A', claudeSession('A', `${pane1}\n> and one more different turn here\n`));
  service = makeService({ stack: tmuxStack(fake), clock, generator: failing, storeFile });
  clock.advance(31000);
  // A fresh service has an empty runtime map, so tick() would iterate nothing: the first
  // read is what registers the session AND schedules the job that then fails.
  await service.read('A'); await service.settle();
  const failed = await service.read('A');
  out.push(
    [failed.generatedAt, changed.generatedAt, 'timestamps: a failed refresh preserves the last successful generation time'],
    [failed.stale, true, 'timestamps: and the kept text is labelled stale'],
    [failed.evidenceAt > changed.evidenceAt, true, 'timestamps: while source freshness still moves, so the two are distinguishable'],
  );

  // A restart serves the persisted timestamps, not fresh ones.
  service = makeService({ stack: tmuxStack(fake), clock, generator: failing, storeFile });
  const restarted = await service.read('A');
  out.push([restarted.generatedAt, changed.generatedAt, 'timestamps: generatedAt survives a restart unchanged']);

  // A GENERATION STILL IN FLIGHT must not move either timestamp's meaning: evidenceAt
  // describes the changed source as soon as it is read, while generatedAt still describes
  // the LAST SUCCESS until this job actually succeeds. Held at an explicit boundary, not
  // timed, so "still pending" is observed rather than assumed.
  const held = countingGenerator(briefGenerator.createExtractiveGenerator());
  service = makeService({ stack: tmuxStack(fake), clock, generator: held, storeFile });
  await service.read('A'); await service.settle();
  const beforeHold = await service.read('A');
  fake.set('A', claudeSession('A', pane2 + '\n> a distinct third turn for the held job\n'));
  const enteredBefore = held.calls;
  const release = held.hold();
  clock.advance(31000);
  const atCollect = clock.now();
  await service.tick();
  out.push([await waitUntil(() => held.calls > enteredBefore), true, 'timestamps: the held generation entered'],
    [service.jobs.size > 0, true, 'timestamps: and is still pending, so nothing has succeeded yet']);
  clock.advance(7000);
  const pending = await service.read('A');
  out.push(
    [pending.generatedAt, beforeHold.generatedAt, 'timestamps: a pending generation does not advance generatedAt'],
    [pending.stale, false, 'timestamps: and a job merely running is not a failure'],
    [pending.evidenceAt, atCollect, 'timestamps: while evidenceAt already describes the changed source it is reading'],
    [pending.evidenceAt > beforeHold.evidenceAt, true, 'timestamps: which is newer than the last successful generation\'s source'],
  );
  await release();
  await service.settle();
  const completed = await service.read('A');
  out.push(
    [completed.generatedAt > beforeHold.generatedAt, true, 'timestamps: generatedAt advances only once generation succeeds'],
    [completed.evidenceAt, atCollect, 'timestamps: and evidenceAt still names when that source was read'],
  );

  // UNCHANGED evidence across a restart: the first background check must not make old
  // evidence look freshly read. runJob compares against the runtime fingerprint, which is
  // null in a new process, so this only holds if it also consults the persisted one.
  service = makeService({ stack: tmuxStack(fake), clock, generator: briefGenerator.createExtractiveGenerator(), storeFile });
  clock.advance(31000);
  await service.read('A'); await service.settle();   // await the first background check
  const unchangedRestart = await service.read('A');
  out.push(
    [unchangedRestart.evidenceAt, completed.evidenceAt, 'timestamps: unchanged evidence across a restart keeps its source freshness'],
    [unchangedRestart.generatedAt, completed.generatedAt, 'timestamps: and its generation time'],
  );
  return out;
}

const waitUntil = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(5); }
  return false;
};

// A generation ALREADY RUNNING when a newer edit lands. Two things make this a race rather
// than the shape of one: the evidence moves to a fixture the fields have not carried
// (re-submitting the current pane hits the unchanged-fingerprint early return and never
// starts a job), and the generator is held at an explicit boundary instead of being made
// slow, so the test observes that generation entered and is STILL PENDING when the edit is
// saved rather than hoping a sleep was long enough.
export async function generationRaceChecks({ clock, storeFile, byId }) {
  const out = [];
  const fake = fakeTmuxProcess({ A: claudeSession('A', paneFor(byId.f2)) });
  const racing = countingGenerator(briefGenerator.createExtractiveGenerator());
  let service = makeService({ stack: tmuxStack(fake), clock, generator: racing, storeFile });
  await service.read('A');
  await service.settle();
  const seeded = await service.patch('A', { goal: 'edited goal stays put', revision: (await service.read('A')).revision });
  out.push([seeded.goal, 'edited goal stays put', 'race: a goal override is in place before the race starts']);
  fake.set('A', claudeSession('A', paneFor(byId.f1)));
  const enteredBefore = racing.calls;
  const release = racing.hold();
  clock.advance(31000);
  await service.tick();
  out.push([await waitUntil(() => racing.calls > enteredBefore), true, 'race: the held generation really entered'],
    [service.jobs.size > 0, true, 'race: and is still pending at the boundary, not already finished']);

  const mid = await service.patch('A', { current: 'saved while the job was mid-flight', revision: (await service.read('A')).revision });
  out.push([mid.current, 'saved while the job was mid-flight', 'race: the edit is accepted while generation is in flight'],
    [service.jobs.size > 0, true, 'race: the job was still held at the boundary when the edit was saved']);

  await release();
  await service.settle();
  const raced = await service.read('A');
  out.push(
    [raced.current, 'saved while the job was mid-flight', 'race: the completing job cannot clobber an edit saved after it started'],
    [raced.generated.current, byId.f1.expectedCurrent, 'race: but the generated value underneath did complete and update'],
    [raced.goal, 'edited goal stays put', 'race: the other override is untouched by the race'],
  );

  service = makeService({ stack: tmuxStack(fake), clock, generator: briefGenerator.createExtractiveGenerator(), storeFile });
  const restarted = await service.read('A');
  out.push([restarted.current, 'saved while the job was mid-flight', 'race: the mid-flight edit survives a service restart'],
    [restarted.generated.current, byId.f1.expectedCurrent, 'race: and so does the generated value that job wrote']);
  return out;
}
