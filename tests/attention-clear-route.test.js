'use strict';
// End to end on the real server.js, with its own tmux server (TMUX_TMPDIR) and MATRIX_HOME:
// a hook notification flags the exact tmux session, the flag stays, and the local
// /api/attention/clear call the Claude Code hook makes when the user answers removes it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

test('a flagged session stays flagged until the hook reports the user answered', { timeout: 40000 }, async () => {
  const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-tmux-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-home-'));
  const env = { ...process.env, TMUX_TMPDIR: tmuxDir, MATRIX_HOME: home };
  delete env.TMUX;
  execFileSync('tmux', ['new-session', '-d', '-s', 'needs-you', 'sleep 600'], { env });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT, detached: true, stdio: 'ignore',
    env: { ...env, MATRIX_PORT: String(port), MATRIX_EINK_TLS_PORT: String(await freePort()) },
  });
  const flagged = async () => (await request(port, 'GET', '/api/sessions')).body.sessions
    .find(s => s.name === 'needs-you').needsAttention;
  try {
    for (let i = 0; i < 60; i++) {
      const up = await request(port, 'GET', '/api/sessions').catch(() => null);
      if (up && up.status === 200) break;
      await new Promise(r => setTimeout(r, 150));
    }
    const sent = await request(port, 'POST', '/api/notify',
      { message: 'Claude needs your permission', project: 'needs-you', session: 'needs-you', tmuxSession: 'needs-you' });
    assert.equal(sent.status, 200);
    assert.equal(await flagged(), true, 'the exact tmux session is flagged');

    await new Promise(r => setTimeout(r, 11000));   // past one 10 s sweep
    assert.equal(await flagged(), true, 'the flag survives the sweep');

    assert.equal((await request(port, 'POST', '/api/attention/clear', {})).status, 400);
    assert.equal((await request(port, 'POST', '/api/attention/clear', { tmuxSession: 'needs-you' })).status, 200);
    assert.equal(await flagged(), false, 'answering clears it');
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    try { execFileSync('tmux', ['kill-server'], { env }); } catch { /* gone */ }
    fs.rmSync(tmuxDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
