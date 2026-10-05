'use strict';
// Starts the real server/server.js as its own process group on spare ports with a throwaway
// MATRIX_HOME, and requires it to serve the app and the e-ink API. Wiring that only fails at
// module load (a name moved into a lib module, a mount argument that no longer exists) passes
// every unit test that loads modules in isolation; only booting the entry point catches it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
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

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 2000 }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

test('server.js boots with every route module mounted', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-boot-'));
  const port = await freePort();
  const tlsPort = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    detached: true,   // its own process group, so helpers it launches are stopped with it
    env: { ...process.env, MATRIX_HOME: home, MATRIX_PORT: String(port), MATRIX_EINK_TLS_PORT: String(tlsPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  try {
    let status = null;
    for (let i = 0; i < 100 && status === null; i++) {
      const early = await Promise.race([exited, new Promise(r => setTimeout(() => r(undefined), 150))]);
      if (early !== undefined) assert.fail(`server exited with code ${early} before serving:\n${output}`);
      status = await get(port, '/').catch(() => null);
    }
    assert.equal(status, 200, `the app is served on ${port}:\n${output}`);
    const eink = await get(port, '/api/eink/v1/snapshot');
    assert.notEqual(eink, 404, `the e-ink API is mounted (got ${eink}):\n${output}`);
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* already gone */ }
    await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
