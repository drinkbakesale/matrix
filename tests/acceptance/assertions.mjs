// Shared result envelope and generic fixtures for the acceptance runners.
//
// This module imports nothing from the other acceptance modules, so it can never take part
// in a cycle with them. The one delivered module it touches — pane-stream.js, loaded by the
// pane-stream probe at the bottom — is `require`d inside the function, after that probe has
// put its throwaway `tmux` on PATH, so merely importing this file loads no server code.
//
// Every expected case id is pre-registered as failed, so a runner that crashes before it
// reaches a case reports that case as a failure rather than silently omitting (or skipping)
// it. Only the JSON assertions envelope goes to the result file; traces go beside it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LIB = path.join(import.meta.dirname, '..', '..', 'server', 'lib');

export function createRun(expectedIds) {
  const results = new Map(expectedIds.map(id => [id, {
    id, status: 'failed', detail: 'case did not run',
  }]));
  const artifacts = {};

  function record(id, status, detail) {
    if (!results.has(id)) throw new Error(`unexpected case id: ${id}`);
    results.set(id, { id, status, detail });
  }

  async function runCase(id, fn) {
    const checks = [];
    const probe = {
      ok(condition, detail) { checks.push({ ok: !!condition, detail }); return !!condition; },
      eq(actual, expected, detail) {
        const same = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
        checks.push({ ok: same, detail: `${detail} — actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}` });
        return same;
      },
      includes(haystack, needle, detail) {
        const found = String(haystack).includes(needle);
        checks.push({ ok: found, detail: `${detail} — ${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 220))}` });
        return found;
      },
      note(key, value) { artifacts[key] = value; },
      checks,
    };
    let thrown = null;
    try {
      await fn(probe);
    } catch (err) {
      thrown = err;
    }
    const failed = checks.filter(c => !c.ok);
    if (thrown) record(id, 'failed', `threw: ${String(thrown && thrown.stack || thrown)}`);
    else if (failed.length) record(id, 'failed', failed.map(c => c.detail).join(' | ').slice(0, 4000));
    else record(id, 'passed', `${checks.length} checks passed`);
  }

  function finish(resultFile, traceFile) {
    const assertions = [...results.values()];
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify({ assertions }, null, 2));
    if (traceFile) {
      fs.mkdirSync(path.dirname(traceFile), { recursive: true });
      fs.writeFileSync(traceFile, JSON.stringify(artifacts, null, 2));
    }
    const failed = assertions.filter(a => a.status !== 'passed');
    for (const a of assertions) console.log(`${a.status === 'passed' ? 'PASS' : 'FAIL'} ${a.id}: ${a.detail}`);
    process.exitCode = failed.length ? 1 : 0;
    return failed.length === 0;
  }

  return { runCase, record, finish, artifacts };
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────────────
// Clocks, temp directories, fake executables and fixture builders, used by both runners.
// They live beside the result envelope because they depend on nothing but node builtins:
// putting them in a module that also loads the delivered server code would point the
// dependency the wrong way.

const cleanups = [];

export function tempDir(prefix = 'matrix-brief-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function cleanupAll() {
  while (cleanups.length) { try { cleanups.pop()(); } catch {} }
}

export function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return { now: () => value, advance(ms) { value += ms; return value; }, set(ms) { value = ms; return value; } };
}

export function argAfter(args, flag) { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; }

// A session whose single Claude window holds `pane`.
export function claudeSession(id, pane, extra = {}) {
  return {
    sessionId: `$${id}`, createdAt: 1_600_000_000,
    windows: [{ name: 'claude', command: 'claude', active: true, pane }], ...extra,
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
      } finally { live -= 1; }
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
  setTimeout(() => process.stdout.write(${JSON.stringify(stdout)}, () => process.exit(${exitCode})), ${delayMs});
});
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, log, read: () => JSON.parse(fs.readFileSync(log, 'utf8')) };
}

export function loadCorpus(oracleDir) {
  return JSON.parse(fs.readFileSync(path.join(oracleDir, 'brief-fixtures.json'), 'utf8'));
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function lastLines(text, n) {
  const lines = String(text).split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

// A fake `tmux` executable. Sessions hold real multi-window panes with real scrollback, so
// window selection and the early/recent capture split are genuinely exercised.
//   session: { sessionId, createdAt, windows: [{ name, command, active, pane, panes? }] }
//
// Two things make it a fake tmux rather than a lookup table:
//   1. It RENDERS whatever `-F` format it is handed, so one fixture serves code that asks
//      for different fields — including the pre-repair code a regression has to fail on.
//   2. It models tmux TARGET parsing, verified against tmux 3.6a: `@id`/`$id` are exact,
//      while `session:window.pane` splits a trailing `.<digits>` off as a pane index BEFORE
//      matching the window name, so `A:v2.1` really reaches window `v2`, pane 1.
// Window ids are opaque counters carrying nothing from the name, so code that built a target
// out of names could not accidentally produce one.
export function fakeTmuxProcess(initial = {}) {
  const sessions = new Map(Object.entries(initial));
  const calls = [];
  const behaviour = { delayMs: 0, fail: new Set() };
  const windowIds = new Map();                     // `${sessionId}\u0000${name}` -> `@n`
  let nextWindowId = 0;

  // tmux accepts a session name or a session id wherever a session is addressed.
  function sessionBy(key) {
    for (const [name, s] of sessions) if (name === key || s.sessionId === key) return s;
    return null;
  }
  const windowsOf = key => { const s = sessionBy(key); return s ? (s.windows || []) : []; };
  const key2 = (sid, w) => `${sid}\u0000${w}`;
  function idFor(sessionId, windowName) {
    const k = key2(sessionId, windowName);
    if (!windowIds.has(k)) { nextWindowId += 1; windowIds.set(k, `@${nextWindowId}`); }
    return windowIds.get(k);
  }
  const render = (fmt, vars) => String(fmt).replace(/#\{([a-z_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

  function paneTextForTarget(target) {
    const raw = String(target);
    if (raw.startsWith('@')) {                     // an exact window id addresses one window
      for (const s of sessions.values()) {
        const hit = (s.windows || []).find(w => windowIds.get(key2(s.sessionId, w.name)) === raw);
        if (hit) return String(hit.pane || '');
      }
      return null;
    }
    const colon = raw.indexOf(':');                // `$id` or a bare name addresses a session
    const key = colon === -1 ? raw : raw.slice(0, colon);
    let rest = colon === -1 ? '' : raw.slice(colon + 1);
    const windows = windowsOf(key);
    if (!windows.length) return null;
    if (!rest) { const a = windows.find(w => w.active) || windows[0]; return a ? String(a.pane || '') : null; }
    let paneIndex = null;
    const dot = rest.lastIndexOf('.');
    if (dot > 0 && /^\d+$/.test(rest.slice(dot + 1))) { paneIndex = Number(rest.slice(dot + 1)); rest = rest.slice(0, dot); }
    const hit = windows.find(w => w.name === rest);
    if (!hit) return null;
    if (paneIndex !== null) return Array.isArray(hit.panes) ? (hit.panes[paneIndex] ?? null) : String(hit.pane || '');
    return String(hit.pane || '');
  }

  function respond(args) {
    const cmd = args[0];
    if (behaviour.fail.has(cmd)) throw Object.assign(new Error(`fake tmux: ${cmd} failed`), { code: 1 });
    if (cmd === 'list-sessions') {
      const fmt = argAfter(args, '-F') || '#{session_name}';
      return [...sessions.entries()].map(([name, s]) => render(fmt, {
        session_name: name, session_id: s.sessionId, session_created: s.createdAt,
      })).join('\n') + '\n';
    }
    if (cmd === 'list-panes') {
      const s = sessionBy(argAfter(args, '-t'));
      const windows = s ? (s.windows || []) : [];
      if (!windows.length) throw Object.assign(new Error('no such session'), { code: 1 });
      const fmt = argAfter(args, '-F') || '#{window_name}';
      return windows.map((w, i) => render(fmt, {
        window_index: i, window_id: idFor(s.sessionId, w.name), window_name: w.name,
        window_active: w.active ? 1 : 0, pane_current_command: w.command || 'bash', pane_id: `%${i}`,
      })).join('\n') + '\n';
    }
    if (cmd === 'display-message') {
      const text = paneTextForTarget(argAfter(args, '-t'));
      if (text === null) throw Object.assign(new Error('no such pane'), { code: 1 });
      return render(args[args.length - 1], {
        history_size: text.split('\n').length, pane_width: 80, pane_height: 24,
      }) + '\n';
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
    // The identifiers a test must compare against: a resolved target is one of these, never
    // a string a test could have spelled out of the session and window names.
    sessionIdOf(name) { const s = sessionBy(name); return s ? s.sessionId : null; },
    windowId(name, windowName) { const s = sessionBy(name); return s ? idFor(s.sessionId, windowName) : null; },
    targetsFor(cmd) { return this.callsFor(cmd).map(c => c.args[c.args.indexOf('-t') + 1]); },
    reset() { calls.length = 0; },
  };
}

// Runs the delivered pane-stream module against a throwaway `tmux` on PATH and a fake
// WebSocket, and records exactly what a connecting client is told. The stream fixes its
// target when the connection opens, so what it announces then is what anything else
// describing "this session" must bind to. No live tmux, HOME or server is involved —
// except via `binDir`, which supplies a directory already holding a `tmux` executable, used
// by the real-tmux regression to point this same probe at its own private socket.
export function paneStreamProbe({ session = 'A', windows = [], query = null, sessionId = '$9', binDir = null } = {}) {
  const dir = binDir || tempDir('matrix-panestream-');
  const dataFile = path.join(dir, 'tmux-data.json');
  const argvLog = path.join(dir, 'argv.log');
  const marker = path.join(dir, 'executed');
  if (binDir) return runPaneStream(dir, { session, query, argvLog, marker });
  fs.writeFileSync(dataFile, JSON.stringify({ session, sessionId, windows }));
  // Renders whatever `-F` format it is handed and answers a session by name OR id, the way
  // tmux does, so the same probe serves code that asks for different fields.
  fs.writeFileSync(path.join(dir, 'tmux'), [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(argvLog)}, args.join(' ') + '\\n');`,
    `const d = JSON.parse(fs.readFileSync(${JSON.stringify(dataFile)}, 'utf8'));`,
    'const at = f => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };',
    'const render = (f, v) => String(f).replace(/#\\{([a-z_]+)\\}/g, (m, k) => (k in v ? String(v[k]) : m));',
    "const out = s => process.stdout.write(s + '\\n');",
    "if (args[0] === 'list-sessions') {",
    "  out(render(at('-F') || '#{session_name}', { session_name: d.session, session_id: d.sessionId, session_created: 1 }));",
    "} else if (args[0] === 'list-panes') {",
    "  if (at('-t') !== d.session && at('-t') !== d.sessionId) process.exit(1);",
    "  out(d.windows.map((w, i) => render(at('-F') || '#{window_name}', {",
    "    window_index: i, window_id: '@' + i, window_name: w[0], window_active: i === 0 ? 1 : 0,",
    "    pane_current_command: w[1], pane_id: '%' + i,",
    "  })).join('\\n'));",
    "} else if (args[0] === 'display-message') {",
    '  out(render(args[args.length - 1], { pane_width: 80, pane_height: 24, history_size: 1 }));',
    "} else if (args[0] === 'capture-pane') { out('fixture pane line'); }",
  ].join('\n') + '\n', { mode: 0o755 });
  return runPaneStream(dir, { session, query, argvLog, marker });
}

function runPaneStream(dir, { session, query, argvLog, marker }) {
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  const paneStream = require(path.join(LIB, 'pane-stream.js'));
  const sent = [];
  const wsHandlers = new Map();
  let closed = null;
  const ws = {
    readyState: 1,
    send: raw => sent.push(JSON.parse(raw)),
    on: (evt, cb) => wsHandlers.set(evt, cb),
    close: (code, reason) => { closed = { code, reason }; ws.readyState = 3; }, ping: () => {},
  };
  let connect = null;
  paneStream.attach({ on: (evt, cb) => { if (evt === 'connection') connect = cb; } }, { port: 0 });
  try {
    connect(ws, { url: `/?${query || `session=${encodeURIComponent(session)}`}` });
  } finally {
    const onClose = wsHandlers.get('close');
    if (onClose) onClose();           // clears the poll and ping timers this connection made
    process.env.PATH = previousPath;
  }
  const argv = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8') : '';
  return { sent, first: sent[0] || null, types: sent.map(m => m.type), closed, argv, marker };
}
