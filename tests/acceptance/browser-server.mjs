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
import {
  briefGenerator, briefRoutes, fakeClock, fakeTmuxProcess, tmuxStack, makeService, tempDir,
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
  const state = { mode: 'ok', slowMs: 1500 };
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
        stack.resolver.invalidate();
        await service.tick();
        return json(200, { now: clock.now() });
      }
      if (op === 'pane') {
        setPane(url.searchParams.get('session'), decodeURIComponent(url.searchParams.get('pane') || ''));
        return json(200, { ok: true });
      }
      if (op === 'reincarnate') {
        const name = url.searchParams.get('session');
        const prev = tmux.sessions.get(name) || {};
        tmux.set(name, { ...prev, sessionId: `${prev.sessionId}-new`, createdAt: (prev.createdAt || 0) + 1000 });
        stack.resolver.invalidate();
        return json(200, { ok: true });
      }
      if (op === 'mode') { state.mode = url.searchParams.get('mode') || 'ok'; return json(200, { mode: state.mode }); }
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
