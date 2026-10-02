// Fixtures and fakes for the brief service acceptance runner.
//
// Every external boundary is faked — tmux capture, the clock, the `claude` CLI, MATRIX_HOME —
// so the runner never reads the real HOME, never talks to a real tmux server and never
// spawns the real CLI. The application code under test is the delivered code, unmodified.

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

// A fake tmux: sessions keyed by name, each with its own incarnation and pane text.
export function fakeTmux(initial = {}) {
  const sessions = new Map(Object.entries(initial));
  const captures = [];
  return {
    sessions,
    captures,
    set(name, data) { sessions.set(name, data); },
    kill(name) { sessions.delete(name); },
    resolveSession(name) {
      const s = sessions.get(name);
      if (!s) return null;
      return {
        name,
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        projectName: s.projectName || 'fixture',
        target: s.target || `${name}:0`,
      };
    },
    capturePane(identity) {
      captures.push({ name: identity.name, target: identity.target, sessionId: identity.sessionId });
      const s = sessions.get(identity.name);
      return s ? s.pane : '';
    },
  };
}

// Renders a fixture record as pane text the way the live pane shows a Claude turn, so the
// evidence collector's own parser is exercised rather than bypassed.
export function paneFor(record) {
  const lines = [];
  for (const item of record.evidence || []) {
    if (item.role === 'user') lines.push(`> ${item.text}`);
    else lines.push(item.text);
    lines.push('');
  }
  lines.push('⏺ working…');
  return lines.join('\n');
}

export function makeService(opts) {
  const {
    tmux, clock, generator, storeFile, evidenceIntervalMs = 30000,
    literalRequired = true, generationTimeoutMs = 30000, fsImpl,
  } = opts;
  return new briefServiceMod.BriefService({
    storeFile,
    resolveSession: name => tmux.resolveSession(name),
    collector: briefEvidence.createEvidenceCollector({
      capturePane: identity => tmux.capturePane(identity),
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
  setTimeout(() => { process.stdout.write(${JSON.stringify(stdout)}); process.exit(${exitCode}); }, ${delayMs});
});
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, log, read: () => JSON.parse(fs.readFileSync(log, 'utf8')) };
}

export function loadCorpus(oracleDir) {
  return JSON.parse(fs.readFileSync(path.join(oracleDir, 'brief-fixtures.json'), 'utf8'));
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
