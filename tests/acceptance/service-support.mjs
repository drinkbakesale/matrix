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

const require = createRequire(import.meta.url);
const LIB = path.join(import.meta.dirname, '..', '..', 'server', 'lib');

export const briefStore = require(path.join(LIB, 'brief-store.js'));
export const briefEvidence = require(path.join(LIB, 'brief-evidence.js'));
export const briefGenerator = require(path.join(LIB, 'brief-generator.js'));
export const briefServiceMod = require(path.join(LIB, 'brief-service.js'));
export const briefRoutes = require(path.join(LIB, 'brief-routes.js'));
export const briefTmux = require(path.join(LIB, 'brief-tmux.js'));

const cleanups = [];

export function tempDir(prefix = 'matrix-brief-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function cleanupAll() {
  while (cleanups.length) {
    try { cleanups.pop()(); } catch {}
  }
}

export function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) { value += ms; return value; },
    set(ms) { value = ms; return value; },
  };
}

function argAfter(args, flag) {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

function lastLines(text, n) {
  const lines = String(text).split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

// A fake `tmux` executable. Sessions hold real multi-window panes with real scrollback, so
// window selection and the early/recent capture split are genuinely exercised.
//   session: { sessionId, createdAt, windows: [{ name, command, active, pane }] }
export function fakeTmuxProcess(initial = {}) {
  const sessions = new Map(Object.entries(initial));
  const calls = [];
  const behaviour = { delayMs: 0, fail: new Set() };

  function windowsOf(name) {
    const s = sessions.get(name);
    return s ? (s.windows || []) : [];
  }

  function paneTextForTarget(target) {
    const [name, windowName] = String(target).split(':');
    const windows = windowsOf(name);
    if (!windows.length) return null;
    const hit = windowName ? windows.find(w => w.name === windowName) : windows.find(w => w.active) || windows[0];
    return hit ? String(hit.pane || '') : null;
  }

  function respond(args) {
    const cmd = args[0];
    if (behaviour.fail.has(cmd)) throw Object.assign(new Error(`fake tmux: ${cmd} failed`), { code: 1 });
    if (cmd === 'list-sessions') {
      return [...sessions.entries()].map(([name, s]) => `${name}|${s.sessionId}|${s.createdAt}`).join('\n') + '\n';
    }
    if (cmd === 'list-panes') {
      const name = argAfter(args, '-t');
      const windows = windowsOf(name);
      if (!windows.length) throw Object.assign(new Error('no such session'), { code: 1 });
      return windows.map((w, i) => `${i}|${w.name}|${w.active ? 1 : 0}|${w.command || 'bash'}`).join('\n') + '\n';
    }
    if (cmd === 'display-message') {
      const text = paneTextForTarget(argAfter(args, '-t'));
      if (text === null) throw Object.assign(new Error('no such pane'), { code: 1 });
      return `${text.split('\n').length}\n`;
    }
    if (cmd === 'capture-pane') {
      const text = paneTextForTarget(argAfter(args, '-t'));
      if (text === null) throw Object.assign(new Error('no such pane'), { code: 1 });
      const start = argAfter(args, '-S');
      const end = argAfter(args, '-E');
      const lines = text.split('\n');
      if (end !== undefined) {
        // Early slice: -S -<history> -E -<history - earlyLines>
        const from = Math.max(0, lines.length + Number(start));
        const to = Math.max(from, lines.length + Number(end));
        return lines.slice(from, to).join('\n') + '\n';
      }
      return lastLines(text, Math.abs(Number(start) || 400)) + '\n';
    }
    throw Object.assign(new Error(`fake tmux: unsupported ${cmd}`), { code: 127 });
  }

  const execFileImpl = (bin, args, opts, cb) => {
    calls.push({ bin, args: [...args], opts });
    const finish = () => {
      if (behaviour.delayMs && opts && opts.timeout && behaviour.delayMs > opts.timeout) {
        cb(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), '', '');
        return;
      }
      try { cb(null, respond(args), ''); } catch (err) { cb(err, '', String(err.message)); }
    };
    if (behaviour.delayMs) setTimeout(finish, Math.min(behaviour.delayMs, 50));
    else setImmediate(finish);
    return { stdin: null };
  };

  return {
    sessions, calls, behaviour, execFileImpl,
    set(name, data) { sessions.set(name, data); },
    kill(name) { sessions.delete(name); },
    callsFor(cmd) { return calls.filter(c => c.args[0] === cmd); },
    reset() { calls.length = 0; },
  };
}

// A session whose single Claude window holds `pane`.
export function claudeSession(id, pane, extra = {}) {
  return {
    sessionId: `$${id}`, createdAt: 1_600_000_000,
    windows: [{ name: 'claude', command: 'claude', active: true, pane }],
    ...extra,
  };
}

// A session whose tmux-active window is a shell and whose Claude window is elsewhere —
// the case where "the active window" and "the streamed window" disagree.
export function shellActiveSession(id, shellPane, claudePane) {
  return {
    sessionId: `$${id}`, createdAt: 1_600_000_000,
    windows: [
      { name: 'shell', command: 'bash', active: true, pane: shellPane },
      { name: 'claude', command: 'claude', active: false, pane: claudePane },
    ],
  };
}

// Renders a fixture record as pane text the way the live pane shows a Claude turn, so the
// evidence collector's own parser is exercised rather than bypassed.
export function paneFor(record, { padLines = 0 } = {}) {
  const lines = [];
  for (const item of record.evidence || []) {
    if (item.role === 'user') lines.push(`> ${item.text}`);
    else lines.push(item.text);
    lines.push('');
  }
  for (let i = 0; i < padLines; i += 1) lines.push(`filler output line ${i}`);
  lines.push('⏺ working…');
  return lines.join('\n');
}

// Builds the delivered resolver/capture stack on top of the fake process.
// Builds the delivered stack with the SHIPPED resolver defaults. Nothing here may relax
// caching or identity validation: a helper that quietly disabled a cache would hide exactly
// the class of staleness these cases exist to catch.
export function tmuxStack(fake, { timeoutMs = 5000, recentLines = 400, earlyLines = 120 } = {}) {
  const tmux = briefTmux.createTmux({ execFileImpl: fake.execFileImpl, timeoutMs });
  const resolver = briefTmux.createSessionResolver({ tmux });
  const capture = briefTmux.createPaneCapture({ tmux, recentLines, earlyLines });
  return { tmux, resolver, capture };
}

export function makeService(opts) {
  const {
    stack, clock, generator, storeFile, evidenceIntervalMs = 30000,
    literalRequired = true, generationTimeoutMs = 30000, fsImpl,
  } = opts;
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

// Counts calls and can be held open, so "no HTTP request waits for generation" and the
// global concurrency bound are observable rather than assumed.
export function countingGenerator(inner) {
  let calls = 0;
  let live = 0;
  let maxLive = 0;
  let gate = null;
  return {
    name: inner.name,
    version: inner.version,
    get calls() { return calls; },
    get maxConcurrent() { return maxLive; },
    hold() { let release; gate = new Promise(r => { release = r; }); return () => { const g = gate; gate = null; release(); return g; }; },
    async generate(input) {
      calls += 1;
      live += 1;
      maxLive = Math.max(maxLive, live);
      try {
        if (gate) await gate;
        return await inner.generate(input);
      } finally {
        live -= 1;
      }
    },
  };
}

// Writes a throwaway executable that records how it was invoked, so the CLI adapter's
// process boundary (argv, stdin, cwd, env) is inspected rather than trusted.
export function fakeCli(dir, { stdout = '', exitCode = 0, delayMs = 0 } = {}) {
  const bin = path.join(dir, 'fake-claude');
  const log = path.join(dir, 'fake-claude.json');
  const script = `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', c => { stdin += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({
    argv: process.argv.slice(2), stdin, cwd: process.cwd(),
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    envKeys: Object.keys(process.env).sort(),
  }));
  // Exit only once stdout has actually flushed, so an oversized payload really reaches the
  // parent's maxBuffer instead of being cut short by an early exit.
  setTimeout(() => {
    process.stdout.write(${JSON.stringify(stdout)}, () => process.exit(${exitCode}));
  }, ${delayMs});
});
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, log, read: () => JSON.parse(fs.readFileSync(log, 'utf8')) };
}

// Runs the delivered pane-stream module against a throwaway `tmux` on PATH and a fake
// WebSocket, and records exactly what a connecting client is told. The stream fixes its
// target when the connection opens, so what it announces at that moment is what anything
// else describing "this session" has to bind to. No real tmux, HOME or server is involved.
export function paneStreamProbe({ session = 'A', windows = [] } = {}) {
  const dir = tempDir('matrix-panestream-');
  const windowFile = path.join(dir, 'windows.txt');
  fs.writeFileSync(windowFile, `${windows.map(([name, cmd]) => `${name}|${cmd}`).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'tmux'), `#!/bin/sh
case "$1" in
  list-panes) cat ${JSON.stringify(windowFile)} ;;
  display-message) echo "80|24" ;;
  capture-pane) echo "fixture pane line" ;;
esac
`, { mode: 0o755 });

  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  const paneStream = require(path.join(LIB, 'pane-stream.js'));
  const sent = [];
  const wsHandlers = new Map();
  const ws = {
    readyState: 1,
    send: raw => sent.push(JSON.parse(raw)),
    on: (evt, cb) => wsHandlers.set(evt, cb),
    close: () => {},
    ping: () => {},
  };
  let connect = null;
  paneStream.attach({ on: (evt, cb) => { if (evt === 'connection') connect = cb; } }, { port: 0 });
  try {
    connect(ws, { url: `/?session=${encodeURIComponent(session)}` });
  } finally {
    const onClose = wsHandlers.get('close');
    if (onClose) onClose();           // clears the poll and ping timers this connection made
    process.env.PATH = previousPath;
  }
  return { sent, first: sent[0] || null, types: sent.map(m => m.type) };
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
  for (const [label, windows, window, target] of [
    ['Claude in window one', [['one', 'claude'], ['two', 'bash']], 'one', 'A:one'],
    ['Claude moved to window two', [['one', 'bash'], ['two', 'claude']], 'two', 'A:two'],
    ['no Claude anywhere', [['one', 'bash'], ['two', 'bash']], '', 'A'],
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
    [report.unboundTarget, 'C:two', 'a client that has not been told yet still gets discovery'],
  );
  return { checks, report };
}

async function emptyBindingScenario({ clock, generator, storeFile, activePane, otherPane }) {
  const streamBinding = session => {
    const claude = (session.windows || []).find(w => briefTmux.isClaudeCmd(w.command));
    return claude ? { window: claude.name, target: `C:${claude.name}` } : { window: '', target: 'C' };
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

  const atOpen = streamBinding(noClaude);
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
  const atReconnect = streamBinding(claudeElsewhere);
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
    unboundTarget: unbound.session.target,
  };
}

export function loadCorpus(oracleDir) {
  return JSON.parse(fs.readFileSync(path.join(oracleDir, 'brief-fixtures.json'), 'utf8'));
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
