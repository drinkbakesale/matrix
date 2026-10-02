// Byte-for-byte equivalent of the frozen oracle gesture-probe.cjs, with the two minimum
// changes WebKit forces:
//   1. `new Touch({...})` throws "Illegal constructor" in WebKit → `document.createTouch`.
//   2. `new TouchEvent(..., {touches: [touch]})` throws "Type error" in WebKit because the
//      touch lists must be real TouchList objects → `document.createTouchList`.
// Everything else — the fixture stream, the 850 ms window, the stability predicate, the
// base/candidate pair — is identical, so this measures exactly what the oracle intended.
//
// This is NOT a replacement for the frozen oracle. It exists as the evidence that the only
// thing standing between the candidate and Gesture::* is that one unsupported constructor.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const [candidate, resultFile] = process.argv.slice(2);
const req = createRequire(path.join(candidate, 'package.json'));
const assertions = [];
const record = (name, ok, detail) => assertions.push({ id: `Gesture::${name}`, status: ok ? 'passed' : 'failed', detail });
(async () => {
  let browser;
  try {
    const { webkit, devices } = req('playwright');
    browser = await webkit.launch();
    for (const base of [true, false]) {
      const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname.startsWith('/api/')) {
          response.setHeader('Content-Type', 'application/json');
          const session = { name: '41', targetSession: '41', projectName: 'fixture', windows: 1, windowList: [], claudeRunning: true };
          response.end(JSON.stringify(url.pathname === '/api/sessions' ? { sessions: [session] } : { ok: true, projects: [] }));
          return;
        }
        const rel = 'server/public/' + (url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (rel.includes('..')) { response.writeHead(403).end(); return; }
        try {
          const data = base
            ? execFileSync('git', ['show', `27534cddc450dfb2003eb6c2733e543e5fda110d:${rel}`], { cwd: candidate, stdio: ['ignore', 'pipe', 'ignore'] })
            : fs.readFileSync(path.join(candidate, rel));
          response.setHeader('Content-Type', rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.css') ? 'text/css' : 'text/html');
          response.end(data);
        } catch { response.writeHead(404).end(); }
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      let context;
      try {
        context = await browser.newContext({ ...devices['iPhone 13'] });
        await context.addInitScript(() => {
          window.__sockets = [];
          window.WebSocket = class {
            static OPEN = 1;
            constructor() { this.readyState = 1; window.__sockets.push(this); setTimeout(() => this.onopen?.({}), 0); }
            send() {} close() { this.readyState = 3; }
          };
          window.EventSource = class { close() {} };
        });
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/?open=41`);
        await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
        const outcome = await page.evaluate(async () => {
          const s = window.__sockets.at(-1);
          const emit = (type, data) => s.onmessage({ data: JSON.stringify({ type, data }) });
          emit('output', 'initial history\n');
          emit('screen', 'selection target café 日本語\n');
          const term = document.getElementById('terminal');
          const original = term.querySelector('.msg-screen') || term.lastElementChild;
          const rect = original.getBoundingClientRect();
          const x = rect.x + 10;
          const y = rect.y + 8;
          const touch = document.createTouch(window, original, 1, x, y, x, y);
          const list = document.createTouchList(touch);
          original.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
          original.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: list, targetTouches: list, changedTouches: list }));
          let n = 0;
          const timer = setInterval(() => { emit('output', `new ${++n}\n`); emit('screen', `replacement ${n}\n`); }, 100);
          await new Promise(r => setTimeout(r, 850));
          const stable = original.isConnected && original.getBoundingClientRect().y === rect.y;
          clearInterval(timer);
          return { stable, updates: n, hasSelection: !getSelection().isCollapsed };
        });
        if (outcome.updates < 5) throw Error('stream fixture did not run');
        record(base ? 'base_exposes_race' : 'candidate_protects_pending_gesture', base ? !outcome.stable : outcome.stable,
          JSON.stringify({ mode: 'synthetic pre-selection causal probe, not native gesture proof', ...outcome }));
      } finally {
        if (context) await context.close();
        await new Promise(r => server.close(r));
      }
    }
  } catch (e) {
    for (const name of ['base_exposes_race', 'candidate_protects_pending_gesture']) {
      if (!assertions.some(a => a.id === `Gesture::${name}`)) record(name, false, String(e.stack || e));
    }
  } finally {
    if (browser) await browser.close();
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify({ assertions }, null, 2));
    process.exitCode = assertions.some(a => a.status !== 'passed') ? 1 : 0;
  }
})();
