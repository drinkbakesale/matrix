// Loopback fixture server for the browser acceptance runner.
//
// It serves the delivered HTML/JS/CSS (either from the candidate working tree or from a git
// export of the frozen base commit) and mounts the REAL brief route handler on the REAL
// brief service, backed by a temporary MATRIX_HOME, a fake tmux and an injectable clock.
// The brief endpoints are therefore exercised end to end — not route-mocked — so refresh and
// edit persistence are actually proved. The production entrypoint is never loaded.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { newPage } from './browser-support.mjs';
import {
  briefGenerator, briefRoutes, briefTmux, fakeClock, fakeTmuxProcess, tmuxStack, makeService, tempDir,
} from './service-support.mjs';

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };

export const BASE_COMMIT = '27534cddc450dfb2003eb6c2733e543e5fda110d';

// Export the frozen base sources into a temporary directory — never a live checkout.
export function exportBase(repoRoot) {
  const dir = tempDir('matrix-base-');
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', `${BASE_COMMIT}`, 'server/public'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  for (const rel of files) {
    const data = execFileSync('git', ['show', `${BASE_COMMIT}:${rel}`], { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  return { dir, commit: BASE_COMMIT, files };
}

export function baseHash(repoRoot) {
  return execFileSync('git', ['rev-parse', BASE_COMMIT], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function sessionRow(name, meta) {
  const windows = meta.windows || [];
  return {
    name, targetSession: name, projectName: meta.projectName || 'fixture',
    projectSource: 'explicit', description: '', windows: windows.length || 1, attached: false,
    path: '/tmp/fixture',
    windowList: windows.map((w, i) => ({ index: i, name: w.name, active: !!w.active })),
    claudeRunning: true, needsAttention: false, lastActivity: 0, projectConfirmed: true,
    sessionId: meta.sessionId, createdAt: meta.createdAt, instanceSuffix: '', displayName: name,
  };
}

// `generatorMode` lets a case make generation slow, failing or malformed at the boundary,
// without patching the delivered service.
function switchableGenerator(state) {
  const extractive = briefGenerator.createExtractiveGenerator();
  return {
    name: 'extractive', version: '1',
    async generate(input) {
      // An explicit, controllable boundary. `slow` is a timing hack and cannot prove a job
      // was still running when an edit landed; `gate` holds the job inside generate() until
      // the test releases it, and records that it really entered.
      state.entered += 1;
      if (state.gate) { state.pending += 1; try { await state.gate; } finally { state.pending -= 1; } }
      if (state.mode === 'slow') await new Promise(r => setTimeout(r, state.slowMs || 1500));
      if (state.mode === 'fail') throw new briefGenerator.BriefGenerationError('generator_failed', 'fake CLI exited with an error');
      if (state.mode === 'timeout') throw new briefGenerator.BriefGenerationError('generator_timeout', 'brief generation timed out');
      if (state.mode === 'malformed') return { goal: { text: 'x', evidenceId: 'not-a-real-id' } };
      if (state.mode === 'html') {
        const first = input.items.find(i => i.role === 'user');
        return first ? { goal: { text: '<img src=x onerror="window.__xss=1">', evidenceId: first.id, literal: first.text.slice(0, 5) } } : { unavailable: 'none' };
      }
      return extractive.generate(input);
    },
  };
}

export async function startFixtureServer({ root, sessions, storeFile, literalRequired = true }) {
  const clock = fakeClock();
  // A fake tmux *process* behind the delivered resolver/capture stack, so the browser cases
  // exercise the same session/window resolution the live server uses.
  const tmux = fakeTmuxProcess(sessions);
  const stack = tmuxStack(tmux);
  const state = { mode: 'ok', slowMs: 1500, gate: null, releaseGate: null, entered: 0, pending: 0 };
  const generator = switchableGenerator(state);
  const home = storeFile || path.join(tempDir('matrix-home-'), 'briefs.json');
  let service = makeService({ stack, clock, generator, storeFile: home, literalRequired });
  const briefHandler = briefRoutes.createNodeHandler(service);
  let handler = briefHandler;

  const setPane = (name, pane) => {
    const prev = tmux.sessions.get(name);
    if (!prev) return;
    const windows = (prev.windows || []).map(w => (w.active || w.command === 'claude' ? { ...w, pane } : w));
    tmux.set(name, { ...prev, windows });
  };

  // Controlled response delay. A held session's brief response is COMPUTED immediately (so
  // it carries the state at request time) but WRITTEN only when the test releases it. That
  // is what lets a case prove an in-flight answer for a session the user has left can never
  // reach the screen.
  const held = new Map();                 // session -> [{ replay }]
  const holding = new Set();

  function heldSession(pathname) {
    const match = /^\/api\/sessions\/([^/]+)\/brief\/?$/.exec(pathname);
    if (!match) return null;
    let name;
    try { name = decodeURIComponent(match[1]); } catch { return null; }
    return holding.has(name) ? name : null;
  }

  function captureResponse() {
    const captured = { status: 200, headers: {}, chunks: [] };
    const sink = {
      setHeader(k, v) { captured.headers[k] = v; },
      writeHead(status, headers) { captured.status = status; Object.assign(captured.headers, headers || {}); return sink; },
      end(body) { if (body !== undefined) captured.chunks.push(body); },
      write(body) { captured.chunks.push(body); },
    };
    return {
      sink,
      replay(real) {
        real.writeHead(captured.status, captured.headers);
        real.end(captured.chunks.join(''));
      },
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname.startsWith('/__control/')) {
      const op = url.pathname.slice('/__control/'.length);
      if (op === 'advance') {
        clock.advance(Number(url.searchParams.get('ms') || 0));
        await service.tick();
        return json(200, { now: clock.now() });
      }
      if (op === 'pane') {
        setPane(url.searchParams.get('session'), decodeURIComponent(url.searchParams.get('pane') || ''));
        return json(200, { ok: true });
      }
      // Kills the session and starts another with the same name. The resolver is NOT told:
      // noticing is the delivered code's job, and the browser cases rely on it noticing.
      if (op === 'reincarnate') {
        const name = url.searchParams.get('session');
        const prev = tmux.sessions.get(name) || {};
        tmux.set(name, { ...prev, sessionId: `${prev.sessionId}-new`, createdAt: (prev.createdAt || 0) + 1000 });
        return json(200, { ok: true });
      }
      // The user quits Claude in one window and starts it in another. Same session, same
      // incarnation, no reopen — exactly what an already-open connection cannot see.
      if (op === 'move-claude') {
        const name = url.searchParams.get('session');
        const to = url.searchParams.get('window');
        const prev = tmux.sessions.get(name) || {};
        const windows = (prev.windows || []).map(w => ({ ...w, command: w.name === to ? 'claude' : 'bash' }));
        tmux.set(name, { ...prev, windows });
        return json(200, { windows: windows.map(w => ({ name: w.name, command: w.command })) });
      }
      // What a WebSocket connecting right now would resolve and announce, using the same
      // predicate pane-stream uses. The stubbed socket replays this as `stream-target`,
      // and tests/acceptance/service.mjs proves pane-stream really sends it.
      if (op === 'stream-target') {
        const name = url.searchParams.get('session');
        const prev = tmux.sessions.get(name) || {};
        const claude = (prev.windows || []).find(w => briefTmux.isClaudeCmd(w.command));
        const window = claude ? claude.name : '';
        // The target is the tmux identifier for the resolved window, or for the session
        // itself when no Claude was found — never a string built out of the names.
        const sessionId = tmux.sessionIdOf(name);
        return json(200, { session: name, window, sessionId, target: window ? tmux.windowId(name, window) : sessionId });
      }
      if (op === 'mode') { state.mode = url.searchParams.get('mode') || 'ok'; return json(200, { mode: state.mode }); }
      if (op === 'gate') { state.gate = new Promise(r => { state.releaseGate = r; }); return json(200, { ok: true }); }
      if (op === 'ungate') {
        const r = state.releaseGate;
        state.gate = null; state.releaseGate = null;
        if (r) r();
        return json(200, { ok: true });
      }
      if (op === 'genstate') { return json(200, { entered: state.entered, pending: state.pending }); }
      if (op === 'settle') { await service.settle(); return json(200, { ok: true }); }
      if (op === 'restart') {
        service = makeService({ stack, clock, generator, storeFile: home, literalRequired });
        handler = briefRoutes.createNodeHandler(service);
        return json(200, { ok: true });
      }
      if (op === 'readonly') {
        service = makeService({
          stack, clock, generator, storeFile: home, literalRequired,
          fsImpl: { ...fs, writeFileSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } },
        });
        handler = briefRoutes.createNodeHandler(service);
        return json(200, { ok: true });
      }
      if (op === 'store') { return json(200, { file: home, contents: fs.existsSync(home) ? fs.readFileSync(home, 'utf8') : null }); }
      if (op === 'hold') { holding.add(url.searchParams.get('session')); return json(200, { ok: true }); }
      if (op === 'unhold') { holding.delete(url.searchParams.get('session')); return json(200, { ok: true }); }
      if (op === 'held') { return json(200, { count: (held.get(url.searchParams.get('session')) || []).length }); }
      if (op === 'release') {
        const name = url.searchParams.get('session');
        const want = url.searchParams.get('count');
        const queue = held.get(name) || [];
        const n = want === null ? queue.length : Math.min(Number(want), queue.length);
        for (let i = 0; i < n; i += 1) queue.shift().replay();   // FIFO: oldest answer first
        return json(200, { released: n, remaining: queue.length });
      }
      return json(404, { ok: false });
    }

    const holdName = heldSession(url.pathname);
    if (holdName) {
      const captured = captureResponse();
      if (!(await handler(req, captured.sink))) { res.writeHead(404).end(); return; }
      if (!held.has(holdName)) held.set(holdName, []);
      held.get(holdName).push({ replay: () => captured.replay(res) });
      return;
    }

    if (await handler(req, res)) return;

    if (url.pathname === '/api/sessions') {
      return json(200, { sessions: [...tmux.sessions.entries()].map(([name, meta]) => sessionRow(name, meta)) });
    }
    if (url.pathname === '/api/notifications/stream' || url.pathname === '/api/ptt/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end('data: {"type":"connected"}\n\n');
    }
    if (url.pathname.startsWith('/api/')) return json(200, { ok: true, projects: [], sessions: [], alert: null });

    const rel = url.pathname === '/' ? 'server/public/index.html'
      : url.pathname === '/desktop' ? 'server/public/desktop.html'
        : 'server/public/' + url.pathname.replace(/^\//, '');
    if (rel.includes('..')) { res.writeHead(403).end(); return; }
    try {
      const data = fs.readFileSync(path.join(root, rel));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'text/plain', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    clock,
    tmux,
    state,
    storeFile: home,
    service: () => service,
    async stop() { await new Promise(r => server.close(r)); },
  };
}

// The page-side callers for the control channel defined above, kept beside the endpoints
// they drive so both ends of `/__control/*` live in one module.
export const control = (page, op, params = {}) => page.evaluate(
  ([o, p]) => fetch(`/__control/${o}?${new URLSearchParams(p)}`).then(r => r.json()),
  [op, params],
);

// Polls a control endpoint until `predicate` holds, so a race waits on an observed
// harness state rather than a guessed delay.
export async function waitForControl(page, op, predicate, deadlineMs, label) {
  const started = Date.now();
  for (;;) {
    const value = await control(page, op);
    if (predicate(value)) return value;
    if (Date.now() - started > deadlineMs) throw new Error(`${label}: ${op} never satisfied in ${deadlineMs}ms (last ${JSON.stringify(value)})`);
    await page.waitForTimeout(50);
  }
}

// Pins the PAGE's Date.now() onto the fixture timeline.
//
// matrix-brief.js renders the age line as ago(now(), brief.generatedAt), and `now()` is the
// page's own Date.now(). The service stamps its timestamps from the injected fixture clock,
// which starts in 2023, so an unpinned page compares a 2026 wall clock against a 2023
// timestamp and prints "updated 1000 d ago" no matter which timestamp the renderer picked.
// That string still contains "updated", which is why a contains-check could never see a
// renderer reading the wrong field. Pinning the page clock is what makes the visible text a
// measurement. Must be installed BEFORE the first navigation so the first render is already
// on the fixture timeline.
export function installPageClock(page, atMs) {
  return page.addInitScript(ms => {
    window.__pageNow = ms;
    Date.now = () => window.__pageNow;
  }, atMs);
}

// Moves the pinned page clock and lets the delivered view redraw from its existing record,
// so the age line is recomputed without refetching. Returns the new value for readability.
export async function setPageClock(page, ms) {
  await page.evaluate(v => { window.__pageNow = v; }, ms);
  await page.evaluate(() => briefView.refresh());
  await page.waitForTimeout(80);
  return ms;
}

// The page-side driver for the brief UI: opening a client on the fixture timeline,
// reading what is on screen, and asserting the age line. Kept beside the control channel
// and page clock it drives rather than in any one case file.
export async function settleAndRefresh(page) {
  await control(page, 'settle');
  await page.evaluate(() => briefView.refresh());
  await page.waitForTimeout(80);
}

// Waits for the DELIVERED client poll to bring a change in on its own. Nothing here calls
// briefView.refresh(), so the deadline really is the shipped polling interval plus slack.
export async function waitForBrief(page, predicate, deadlineMs, label) {
  const started = Date.now();
  for (;;) {
    const brief = await readBrief(page);
    if (predicate(brief)) return { brief, elapsedMs: Date.now() - started };
    if (Date.now() - started > deadlineMs) {
      throw new Error(`${label}: client poll did not update within ${deadlineMs}ms (last ${JSON.stringify(brief)})`);
    }
    await page.waitForTimeout(100);
  }
}

export async function readBrief(page) {
  return page.evaluate(() => ({
    status: document.getElementById('brief').getAttribute('data-status'),
    goal: document.getElementById('brief-goal').textContent,
    current: document.getElementById('brief-current').textContent,
    age: document.getElementById('brief-age').textContent,
    note: document.getElementById('brief-status').textContent,
    generated: briefView.current() ? briefView.current().generated : null,
    generatedAt: briefView.current() ? briefView.current().generatedAt : null,
    evidenceAt: briefView.current() ? briefView.current().evidenceAt : null,
    revision: briefView.current() ? briefView.current().revision : null,
    stale: briefView.current() ? briefView.current().stale : null,
  }));
}

export async function openClient(ctx, kind, name = 'A') {
  if (kind === 'mobile') {
    const { context, page } = await newPage(ctx.browser, { device: ctx.devices['iPhone 13'] });
    await installPageClock(page, ctx.server.clock.now());
    await page.goto(`${ctx.origin}/?open=${encodeURIComponent(name)}`);
    await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
    return { context, page };
  }
  const { context, page } = await newPage(ctx.browser, { viewport: { width: 1280, height: 860 } });
  await installPageClock(page, ctx.server.clock.now());
  await page.goto(`${ctx.origin}/desktop.html`);
  await page.waitForSelector(`.project-item[data-session="${name}"]`);
  await page.click(`.project-item[data-session="${name}"] .project-content`);
  await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
  return { context, page };
}

// Asserts the age line the USER SEES, and proves at the same moment that the assertion can
// tell the two timestamps apart: it reports what an evidenceAt-reading renderer would have
// printed instead, and requires it to differ. `expected` is always a literal, so the format
// itself is asserted rather than recomputed from a copy of the renderer's own arithmetic.
export async function expectAge(page, t, { at, expected, label }) {
  await setPageClock(page, at);
  const shown = await readBrief(page);
  // Read from the record the renderer actually drew, not one sampled before the refresh.
  const evidenceSecs = Math.max(0, Math.floor((at - shown.evidenceAt) / 1000));
  const evidenceMin = Math.floor(evidenceSecs / 60);
  const asEvidence = evidenceSecs < 45 ? 'updated just now'
    : evidenceSecs < 3600 ? `updated ${evidenceMin} min ago`
      : `updated ${Math.floor(evidenceSecs / 3600)} h ago`;
  t.ok(asEvidence !== expected,
    `${label}: at this clock an evidenceAt-reading renderer would print "${asEvidence}", not "${expected}" — the check discriminates`);
  t.eq(shown.age, expected, `${label}: the visible age reads the last successful generation`);
}

export async function editField(page, field, value) {
  await page.click(`#brief-edit-${field}`);
  await page.waitForSelector(`#brief-input-${field}`);
  await page.fill(`#brief-input-${field}`, value);
  await page.click(`#brief-save-${field}`);
  await page.waitForTimeout(120);
}
