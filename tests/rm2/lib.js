// Shared harness for the RM2 acceptance groups. It starts production pieces
// (Matrix server, hook script, host-built client, real browser) and provides
// doubles only for the outside world.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawn, spawnSync, execFileSync } = require('child_process');

module.exports = ({ candidate, artifacts }) => {
  const procs = [];
  const dirs = [];
  let browser = null;
  let hostBinPath = null;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms, what) {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      try { last = await fn(); if (last) return last; } catch (err) { last = err; }
      if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
      await wait(25);
    }
  }
  const tmp = (name) => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `rm2t-${name}-`)); dirs.push(d); return d; };
  const caseDir = (name) => { const d = path.join(artifacts, name); fs.mkdirSync(d, { recursive: true }); return d; };
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
  const sessionId = (p) => 's_' + crypto.createHash('sha256').update(`${p.pid}:${p.session_id}:${p.session_created}`).digest('hex').slice(0, 12);

  // ---- tmux binary double ------------------------------------------------
  function fakeTmux() {
    const dir = tmp('tmux');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.copyFileSync(path.join(candidate, 'tests', 'rm2', 'fake-tmux'), path.join(bin, 'tmux'));
    fs.chmodSync(path.join(bin, 'tmux'), 0o755);
    const lines = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const pane = (o) => ({ pid: '4242', session_id: '$1', session_created: '1700000000', session_name: 'alpha', window_id: '@1', pane_id: '%1', pane_pid: '100', pane_current_command: 'claude', pane_current_path: os.tmpdir(), pane_dead: '0', '@matrix_project': '', ...o });
    return {
      dir, pane,
      env: { PATH: `${bin}:${process.env.PATH}`, MATRIX_TMUX: path.join(bin, 'tmux'), FAKE_TMUX_DIR: dir },
      bin: path.join(bin, 'tmux'),
      setPanes: (panes) => fs.writeFileSync(path.join(dir, 'panes.json'), JSON.stringify(panes)),
      noServer: () => fs.rmSync(path.join(dir, 'panes.json'), { force: true }),
      calls: () => lines('calls.jsonl'),
      sent: () => lines('sent.jsonl'),
      setCapture: (paneId, text) => fs.writeFileSync(path.join(dir, `capture-${paneId}.txt`), text),
      set: (name, obj) => (obj === null ? fs.rmSync(path.join(dir, name), { force: true }) : fs.writeFileSync(path.join(dir, name), JSON.stringify(obj))),
      // Barrier on one tmux command: calls started after hold() block inside the binary until release().
      hold: (command) => {
        for (const f of fs.readdirSync(dir)) if (f === 'release' || f.startsWith('held-')) fs.rmSync(path.join(dir, f));
        fs.writeFileSync(path.join(dir, 'hold.json'), JSON.stringify({ command }));
      },
      held: () => fs.readdirSync(dir).filter((f) => f.startsWith('held-')).length,
      release: () => { fs.rmSync(path.join(dir, 'hold.json'), { force: true }); fs.writeFileSync(path.join(dir, 'release'), ''); },
    };
  }

  // ---- production server -------------------------------------------------
  function eink(home) {
    const { createStore } = require(path.join(candidate, 'server/lib/eink/store'));
    const { createAuth } = require(path.join(candidate, 'server/lib/eink/auth'));
    return createAuth({ store: createStore({ dir: path.join(home, 'eink') }) });
  }

  async function startServer({ home = tmp('home'), env = {}, tls = false, root = candidate, port, tlsPort, waitReady = true } = {}) {
    port = port || await freePort();
    tlsPort = tlsPort || await freePort();
    let pin = null;
    if (tls) {
      const r = spawnSync(process.execPath, [path.join(candidate, 'scripts', 'matrix-eink'), 'setup-tls', '--json'], { env: { ...process.env, MATRIX_HOME: home }, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`setup-tls failed: ${r.stderr}`);
      pin = JSON.parse(r.stdout);
    }
    const transcripts = path.join(home, 'transcripts');
    fs.mkdirSync(transcripts, { recursive: true });
    const log = path.join(artifacts, `server-${port}.log`);
    const out = fs.openSync(log, 'a');
    const proc = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
      cwd: root, stdio: ['ignore', out, out],
      env: { ...process.env, TMUX: '', TMUX_PANE: '', PYTHON_PATH: '/usr/bin/false', MATRIX_HOME: home, MATRIX_PORT: String(port), MATRIX_EINK_TLS_PORT: String(tlsPort), MATRIX_EINK_TLS_BIND: '127.0.0.1', MATRIX_EINK_POLL_MS: '150', MATRIX_EINK_TRANSCRIPT_ROOT: transcripts, MATRIX_BUILDCTL: '/nonexistent/buildctl', ...env },
    });
    procs.push(proc);
    const base = `http://127.0.0.1:${port}`;
    const srv = {
      proc, port, tlsPort, home, base, pin, log, transcripts, api: `${base}/api/eink/v1`,
      token: (scope) => eink(home).issueToken(scope).token,
      auth: () => eink(home),
      pairCode: () => eink(home).issuePairCode('controller').code,
      stop: async (signal = 'SIGTERM') => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill(signal); await new Promise((r) => proc.once('exit', r)); } },
      exited: () => proc.exitCode !== null || proc.signalCode !== null,
      endpoint: (name = 'lan') => ({ name, url: `https://127.0.0.1:${tlsPort}`, cert_pem: pin.cert_pem, server_name: pin.server_name, pin_sha256: pin.pin_sha256 }),
      readLog: () => fs.readFileSync(log, 'utf8'),
    };
    if (waitReady) await until(async () => (await fetch(`${base}/api/eink/v1/snapshot`).catch(() => null)), 15000, 'the Matrix server to listen');
    return srv;
  }

  // One request per connection (no keep-alive pool): a harness request can never be written to an
  // idle socket the server is closing, however slowly the machine is running.
  async function http(method, url, { token, body, headers = {} } = {}) {
    const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const all = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers };
    if (!url.startsWith('http://')) {
      const res = await fetch(url, { method, redirect: 'manual', headers: all, body: payload });
      return parsed(res.status, await res.text());
    }
    return new Promise((resolve, reject) => {
      const req = require('http').request(url, { method, agent: false, headers: { ...all, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(parsed(res.statusCode, Buffer.concat(chunks).toString('utf8'))));
        res.on('error', reject);
      });
      req.on('error', (err) => reject(new Error(`${method} ${url} failed: ${err.code || err.message}`, { cause: err })));
      req.end(payload);
    });
  }
  function parsed(status, text) {
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status, data, text };
  }

  // ---- real hook script --------------------------------------------------
  // Runs hooks/matrix-evidence.js exactly as Claude Code would: JSON on stdin,
  // tmux identity in the environment.
  function hook(srv, pane, input, { env = {} } = {}) {
    const r = spawnSync(process.execPath, [path.join(candidate, 'hooks', 'matrix-evidence.js')], {
      input: JSON.stringify({ cwd: pane.pane_current_path, permission_mode: 'default', ...input }), encoding: 'utf8',
      env: { ...process.env, MATRIX_HOME: srv.home, MATRIX_PORT: String(srv.port), TMUX: `/tmp/fake-tmux/default,${pane.pid},0`, TMUX_PANE: pane.pane_id, ...env },
    });
    if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
    if (r.stdout.trim() !== '') throw new Error(`hook printed output (it must only observe): ${r.stdout}`);
    return r;
  }
  function hookToken(srv) {
    const t = srv.token('hook');
    fs.writeFileSync(path.join(srv.home, 'eink', 'hook-token'), t + '\n', { mode: 0o600 });
    return t;
  }

  // ---- host-built client -------------------------------------------------
  function hostBin() {
    if (hostBinPath) return hostBinPath;
    const r = spawnSync(path.join(candidate, 'scripts', 'rm2-build'), ['host'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`host build failed: ${r.stderr}`);
    hostBinPath = r.stdout.trim().split('\n').pop();
    return hostBinPath;
  }
  function script(input) {
    const r = spawnSync(hostBin(), ['script'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`script failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }
  function fixtureRoot({ model = 'reMarkable 2.0', version = '3.28.0.162', backend = true, hashtab = true, versionFile = 'os-release' } = {}) {
    const root = tmp('rmroot');
    const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    if (model !== null) w('sys/devices/soc0/machine', model + '\n');
    if (version !== null) {
      if (versionFile === 'os-release') w('etc/os-release', `NAME="codex"\nIMG_VERSION="${version}"\n`);
      else w('usr/share/remarkable/update.conf', `[General]\nREMARKABLE_RELEASE_VERSION=${version}\n`);
    }
    if (backend) { w('home/root/xovi/xovi.so', 'x'); w('home/root/xovi/extensions.d/qt-resource-rebuilder.so', 'x'); w('home/root/xovi/extensions.d/appload.so', 'x'); }
    if (hashtab) w('home/root/xovi/exthome/qt-resource-rebuilder/hashtab', 'x');
    return root;
  }

  // Starts the production client with the capture backend against a server.
  // Touch is injected as QTFB-encoded input; everything else is real.
  async function startClient({ endpoints, token, root = fixtureRoot(), display = { typing_coalesce_ms: 100, clean_after_partials: 100, quiet_ms: 3000 }, firstrunTap = true, extraArgs = [] }) {
    const dir = tmp('client');
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ endpoints, token, display }));
    const proc = spawn(hostBin(), ['run', '--backend', 'capture', '--config', cfg, '--root', root, '--state-dir', path.join(dir, 'state'), '--heartbeat-file', path.join(dir, 'beat'), ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(proc);
    const c = { proc, dir, cfg, lines: [], refreshes: [], stderr: '', dumps: [], firstrun: null, frames: [] };
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let o; try { o = JSON.parse(line); } catch { continue; }
        c.lines.push(o);
        if (o.refresh) c.refreshes.push({ ...o.refresh, wall: Date.now() });
        if (o.dump) c.dumps.push(o.dump);
        if (o.firstrun) c.firstrun = o;
        if (o.frame) c.frames.push(o.frame);
      }
    });
    proc.stderr.on('data', (d) => { c.stderr += d; });
    c.send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
    c.tap = (x, y, id = 0) => { c.send({ touch: [0x10, id, x, y] }); c.send({ touch: [0x11, id, x, y] }); };
    c.dump = async () => { const n = c.dumps.length; c.send({ dump: true }); await until(() => c.dumps.length > n, 5000, 'client dump'); return c.dumps[c.dumps.length - 1]; };
    c.frame = async (file) => { const n = c.frames.length; c.send({ frame: file }); await until(() => c.frames.length > n, 5000, 'client frame'); return file; };
    c.waitDump = (pred, ms, what) => until(async () => { const d = await c.dump(); return pred(d) ? d : null; }, ms, what);
    c.exited = () => proc.exitCode !== null || proc.signalCode !== null;
    c.stop = async () => { if (!c.exited()) { c.send({ quit: true }); await Promise.race([new Promise((r) => proc.once('exit', r)), wait(3000)]); if (!c.exited()) proc.kill('SIGKILL'); } };
    if (firstrunTap) {
      await until(() => c.firstrun || c.exited(), 20000, 'the first-run screen');
      if (c.exited()) throw new Error(`client exited during first run: ${c.stderr}`);
      c.tap(700, 900);
      await c.waitDump((d) => d.conn && d.conn.Status !== 'starting', 15000, 'the client main loop');
    }
    return c;
  }

  // ---- real browser ------------------------------------------------------
  async function getBrowser() {
    if (browser) return browser;
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    let pw;
    try { pw = require(path.join(root, 'playwright')); } catch (err) { throw new Error(`a real browser engine is required: global playwright not found under ${root} (${err.message})`); }
    browser = await pw.webkit.launch();
    return browser;
  }
  async function newPage(opts = {}) {
    const b = await getBrowser();
    const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, ...opts });
    const page = await ctx.newPage();
    page.consoleLog = [];
    page.on('console', (m) => page.consoleLog.push(m.text()));
    page.on('pageerror', (e) => page.consoleLog.push(`PAGEERROR ${e.message}`));
    return page;
  }
  // Opens Control and pairs it through the real pairing form.
  async function openControl(srv, opts) {
    const page = await newPage(opts);
    await page.goto(`${srv.base}/control/`);
    await page.fill('#pair-code', srv.pairCode());
    await page.click('#pair-form button');
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(() => document.getElementById('conn').textContent === 'Live', null, { timeout: 10000 });
    return page;
  }

  async function cleanup() {
    for (const p of procs.splice(0)) { try { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); } catch { /* gone */ } }
    if (browser) { await browser.close().catch(() => {}); browser = null; }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  }

  const readPGM = (file) => { const b = fs.readFileSync(file); const head = /^P5\n(\d+) (\d+)\n255\n/.exec(b.subarray(0, 32).toString('latin1')); return { w: +head[1], h: +head[2], pix: b.subarray(head[0].length) }; };

  const registerProc = (p) => procs.push(p);
  return { registerProc, candidate, artifacts, assert, wait, until, tmp, caseDir, freePort, sessionId, fakeTmux, startServer, http, hook, hookToken, hostBin, script, fixtureRoot, startClient, newPage, openControl, cleanup, readPGM, eink, fs, path, os, crypto, spawn, spawnSync };
};
