// Network group: real TLS listeners on loopback stand in for the home LAN
// endpoint and the travel gateway. The production client, the production
// gateway proxy and the shipped preflight are what is exercised.
module.exports = (L) => {
  const { assert, fs, path } = L;
  const https = require('https');

  function makeCert(name) {
    const dir = L.tmp('cert');
    const r = L.spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`openssl: ${r.stderr}`);
    const pem = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    return { dir, cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem'), pem, name, pin: L.crypto.createHash('sha256').update(new L.crypto.X509Certificate(pem).raw).digest('hex') };
  }

  // Starts the production gateway proxy in front of a Matrix TLS endpoint.
  async function gateway(srv, cert, { port, upstreamPort } = {}) {
    port = port || await L.freePort();
    const ca = path.join(L.tmp('upca'), 'up.pem');
    fs.writeFileSync(ca, srv.pin.cert_pem);
    const proc = L.spawn(L.hostBin(), ['gateway', '--listen', `127.0.0.1:${port}`, '--upstream', `https://127.0.0.1:${upstreamPort || srv.tlsPort}`, '--upstream-ca', ca, '--upstream-name', srv.pin.server_name, '--cert', cert.cert, '--key', cert.key], { stdio: ['ignore', 'ignore', 'pipe'] });
    const g = { proc, port, stderr: '', endpoint: (name) => ({ name, url: `https://127.0.0.1:${port}`, cert_pem: cert.pem, server_name: cert.name, pin_sha256: cert.pin }) };
    proc.stderr.on('data', (d) => { g.stderr += d; });
    g.stop = async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await new Promise((r) => proc.once('exit', r)); } };
    await L.until(() => /listening/.test(g.stderr) || proc.exitCode !== null, 5000, 'gateway to listen');
    await L.until(() => new Promise((resolve) => { const s = require('net').connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); }), 5000, 'gateway port');
    L.registerProc && L.registerProc(proc);
    return g;
  }
  const tlsRequest = (ep, method, p, { token, body } = {}) => new Promise((resolve, reject) => {
    const u = new URL(ep.url);
    const req = https.request({ host: u.hostname, port: u.port, path: p, method, ca: ep.cert_pem, servername: ep.server_name, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let text = ''; res.on('data', (d) => { text += d; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  function preflight(config, endpoint) {
    const file = path.join(L.tmp('pf'), 'config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    const r = L.spawnSync(path.join(L.candidate, 'scripts', 'rm2-preflight'), ['--local', file, ...(endpoint ? ['--endpoint', endpoint] : [])], { encoding: 'utf8' });
    let results = null;
    try { results = JSON.parse(r.stdout).results; } catch { /* config error: no JSON */ }
    return { code: r.status, results, text: r.stdout + r.stderr };
  }
  async function base() {
    const tm = L.fakeTmux(); tm.setPanes([tm.pane({}), tm.pane({ session_id: '$2', session_name: 'beta', pane_id: '%2' })]);
    const srv = await L.startServer({ env: tm.env, tls: true });
    return { tm, srv, device: srv.token('device') };
  }

  return {
    async endpoint_failover(t) {
      const { tm, srv, device } = await base();
      const c1 = makeCert('lan-proxy.test'); const c2 = makeCert('travel-gateway.test');
      let g1 = await gateway(srv, c1); const g2 = await gateway(srv, c2);
      const client = await L.startClient({ endpoints: [g1.endpoint('home-lan'), g2.endpoint('travel-gateway')], token: device });
      let d = await client.waitDump((q) => q.conn.Status === 'fresh', 10000, 'fresh on the first endpoint');
      assert.equal(d.conn.Endpoint, 'home-lan');
      assert.match(d.visible.status, /LIVE · home-lan/);
      const ctl = srv.token('controller');
      const sid = L.sessionId(tm.pane({ session_id: '$2' }));
      await L.http('POST', `${srv.api}/select`, { token: ctl, body: { session_id: sid, base_revision: 1 } });
      await client.waitDump((q) => q.selection.session_id === sid, 3000, 'selection');
      // The LAN endpoint fails.
      await g1.stop();
      let t0 = Date.now();
      d = await client.waitDump((q) => q.conn.Status === 'disconnected', 3000, 'disconnected');
      const downMs = Date.now() - t0;
      assert.match(d.visible.status, /DISCONNECTED — last confirmed \d\d:\d\d:\d\d · retrying/);
      assert.deepEqual([Object.keys(d.states).length, d.selection.session_id], [2, sid], 'state is preserved while disconnected');
      d = await client.waitDump((q) => q.conn.Status === 'fresh', 36000, 'fresh on the travel endpoint');
      const ms1 = Date.now() - t0;
      assert.equal(d.conn.Endpoint, 'travel-gateway', 'the status identifies the endpoint now in use');
      assert.ok(ms1 <= 35000, `failover took ${ms1}ms`);
      assert.equal(d.selection.session_id, sid);
      // The travel endpoint fails and the LAN one is back.
      g1 = await gateway(srv, c1, { port: g1.port });
      await g2.stop();
      t0 = Date.now();
      await client.waitDump((q) => q.conn.Status !== 'fresh', 3000, 'not fresh after travel failed');
      d = await client.waitDump((q) => q.conn.Status === 'fresh', 36000, 'fresh on the LAN endpoint again');
      const ms2 = Date.now() - t0;
      assert.equal(d.conn.Endpoint, 'home-lan');
      assert.ok(ms2 <= 35000, `failback took ${ms2}ms`);
      // Both fail: an accurate disconnected status, no stale "live".
      await g1.stop();
      d = await client.waitDump((q) => q.conn.Status === 'disconnected', 3000, 'disconnected with both down');
      await L.wait(2500);
      d = await client.dump();
      assert.notEqual(d.conn.Status, 'fresh');
      assert.equal(Object.keys(d.states).length, 2);
      assert.ok(!client.stderr.includes(device), 'the token never appears in client diagnostics');
      t.note(`LAN proxy killed → disconnected in ${downMs}ms, fresh on travel-gateway after ${ms1}ms; travel killed → fresh on home-lan after ${ms2}ms; both down → disconnected, 2 sessions and selection kept`);
    },

    async route_preflight(t) {
      const { srv, device } = await base();
      const gc = makeCert('travel-gateway.test');
      const good = await gateway(srv, gc);
      const deadPort = await L.freePort();
      const noUpstream = await gateway(srv, gc, { upstreamPort: deadPort });
      const other = makeCert('someone-else.test');
      const lan = srv.endpoint('home-lan');
      const cases = {
        ok: [{ endpoints: [good.endpoint('travel-gateway')], token: device }, 'travel-gateway', 0, 'ok'],
        dns: [{ endpoints: [{ ...good.endpoint('travel-gateway'), url: 'https://no-such-gateway.invalid:8443' }], token: device }, 'travel-gateway', 1, 'dns'],
        upstream: [{ endpoints: [noUpstream.endpoint('travel-gateway')], token: device }, 'travel-gateway', 1, 'upstream'],
        auth: [{ endpoints: [good.endpoint('travel-gateway')], token: 'mx_device_this-token-was-never-issued-xxxxxxxxxxxx' }, 'travel-gateway', 1, 'auth'],
        tls: [{ endpoints: [{ ...good.endpoint('travel-gateway'), cert_pem: other.pem, pin_sha256: other.pin, server_name: other.name }], token: device }, 'travel-gateway', 1, 'tls'],
      };
      const seen = [];
      for (const [name, [config, ep, code, stage]] of Object.entries(cases)) {
        const r = preflight(config, ep);
        assert.equal(r.code, code, `${name}: exit code (${r.text})`);
        assert.equal(r.results[0].stage, stage, `${name}: stage (${r.text})`);
        assert.equal(r.results[0].ok, code === 0);
        if (code) assert.ok(r.results[0].reason.length > 8, `${name}: a reason is given`);
        assert.ok(!r.text.includes(config.token), `${name}: the token is not printed`);
        seen.push(`${name}→${r.results[0].stage}`);
      }
      // The whole route is proven: a successful probe really went through gateway and upstream.
      assert.match(good.stderr, /device API only/);
      // A working home route never counts for the road route.
      const mixed = { endpoints: [lan, noUpstream.endpoint('travel-gateway')], token: device };
      let r = preflight(mixed, 'home-lan');
      assert.deepEqual([r.code, r.results.length, r.results[0].ok], [0, 1, true]);
      r = preflight(mixed, 'travel-gateway');
      assert.deepEqual([r.code, r.results[0].endpoint, r.results[0].ok], [1, 'travel-gateway', false], 'the road route is reported on its own');
      r = preflight(mixed);
      assert.equal(r.code, 1, 'probing all routes fails when any route fails');
      assert.deepEqual(r.results.map((q) => [q.endpoint, q.ok]), [['home-lan', true], ['travel-gateway', false]]);
      r = preflight(mixed, 'no-such-endpoint');
      assert.equal(r.code, 2);
      t.note(`preflight stages: ${seen.join(', ')}; LAN ok + road broken → road reported failing separately (exit 1)`);
    },

    async private_transport(t) {
      const { tm, srv, device } = await base();
      const ctl = srv.token('controller');
      const gc = makeCert('travel-gateway.test');
      const g = await gateway(srv, gc);
      const lan = srv.endpoint('home-lan');
      const other = makeCert('impostor.test');
      const outputs = [];
      const probe = (ep, token = device) => { const r = preflight({ endpoints: [ep], token }, ep.name); outputs.push(r.text); return r; };
      // Wrong certificate, pin mismatch, name mismatch: all refused at the TLS stage.
      const impostor = await gateway(srv, other);
      assert.equal(probe({ ...lan, url: impostor.endpoint('x').url }).results[0].stage, 'tls', 'a server presenting another certificate is refused');
      assert.equal(probe({ ...lan, pin_sha256: other.pin }).results[0].stage, 'tls', 'a pin mismatch is refused even with a trusted chain');
      assert.equal(probe({ ...lan, server_name: 'another-name.local' }).results[0].stage, 'tls', 'a name mismatch is refused');
      assert.equal(probe(lan).code, 0, 'the correctly pinned endpoint works');
      // A TLS failure never downgrades: the client stays not-fresh and never falls back to plaintext.
      const client = await L.startClient({ endpoints: [{ ...lan, pin_sha256: other.pin }], token: device });
      await L.wait(2500);
      const d = await client.dump();
      assert.notEqual(d.conn.Status, 'fresh');
      assert.match(d.conn.Detail, /certificate|pinned/);
      await client.stop();
      // Plaintext endpoints and credentials in URLs are refused before any connection.
      let r = preflight({ endpoints: [{ name: 'plain', url: `http://127.0.0.1:${srv.port}` }], token: device }, 'plain');
      assert.equal(r.code, 2);
      assert.match(r.text, /only https is allowed/);
      r = preflight({ endpoints: [{ ...lan, url: `${lan.url}/?token=abc` }], token: device }, lan.name);
      assert.match(r.text, /credentials or query strings are not allowed/);
      // A redirect (to a public or plaintext host) is refused, not followed.
      const redirPort = await L.freePort();
      const hitFile = path.join(L.tmp('redir'), 'hits');
      // A separate process: the preflight runs synchronously and this process could not answer meanwhile.
      const redirector = L.spawn(process.execPath, ['-e', `
        const fs = require('fs');
        require('https').createServer({ key: fs.readFileSync(${JSON.stringify(gc.key)}), cert: fs.readFileSync(${JSON.stringify(gc.cert)}) }, (req, res) => {
          fs.appendFileSync(${JSON.stringify(hitFile)}, req.url + '\\n');
          res.writeHead(302, { Location: 'http://public.example.com/api/eink/v1/snapshot' }); res.end();
        }).listen(${redirPort}, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(hitFile)}, ''));`], { stdio: 'ignore' });
      L.registerProc(redirector);
      await L.until(() => fs.existsSync(hitFile), 5000, 'redirecting server');
      r = probe({ name: 'redirecting', url: `https://127.0.0.1:${redirPort}`, cert_pem: gc.pem, server_name: gc.name, pin_sha256: gc.pin });
      redirector.kill();
      const hits = fs.readFileSync(hitFile, 'utf8').split('\n').filter(Boolean).length;
      assert.deepEqual([r.code, r.results[0].stage, hits], [1, 'redirect', 1], `the redirect is reported and not followed (${r.text})`);
      // The gateway binds only a private address.
      for (const addr of ['0.0.0.0:8443', '[::]:8443', '8.8.8.8:8443']) {
        const run = L.spawnSync(L.hostBin(), ['gateway', '--listen', addr, '--upstream', 'https://mac.example.ts.net', '--cert', gc.cert, '--key', gc.key], { encoding: 'utf8', timeout: 5000 });
        assert.equal(run.status, 1, `gateway refuses to listen on ${addr}`);
        assert.match(run.stderr, /private address|not listen on its uplink/);
      }
      const insecure = L.spawnSync(L.hostBin(), ['gateway', '--listen', '127.0.0.1:1', '--upstream', 'http://mac.example.ts.net', '--cert', gc.cert, '--key', gc.key], { encoding: 'utf8', timeout: 5000 });
      assert.match(insecure.stderr, /must be an https/);
      // The gateway forwards only the device API: everything else is refused before it reaches Matrix.
      const sid = L.sessionId(tm.pane({}));
      await L.http('POST', `${srv.api}/select`, { token: ctl, body: { session_id: sid, base_revision: 1 } });
      await L.http('PUT', `${srv.api}/draft`, { token: ctl, body: { session_id: sid, text: 'via gateway?', revision: 1 } });
      const gw = g.endpoint('gw');
      const denied = [
        ['POST', '/api/eink/v1/submit', ctl, { session_id: sid, selection_revision: 2, draft_revision: 1, idempotency_id: 'gateway-submit-1' }],
        ['PUT', '/api/eink/v1/draft', ctl, { session_id: sid, text: 'x', revision: 2 }],
        ['POST', '/api/eink/v1/hook', device, {}],
        ['GET', '/', null], ['GET', '/api/sessions', null], ['GET', '/control/', null],
        ['GET', '/api/eink/v1/snapshot?x=1', device],
      ];
      for (const [m, p, tok, body] of denied) assert.equal((await tlsRequest(gw, m, p, { token: tok, body })).status, 403, `gateway refuses ${m} ${p}`);
      assert.equal((await tlsRequest(gw, 'GET', '/api/eink/v1/snapshot', { token: device })).status, 200, 'the device snapshot passes');
      assert.equal((await tlsRequest(gw, 'GET', '/api/eink/v1/snapshot', {})).status, 401, 'and still needs the device token');
      assert.deepEqual(tm.sent(), [], 'nothing was submitted through the gateway');
      // The Mac's LAN TLS listener serves only the e-ink API.
      for (const p of ['/', '/api/sessions', '/control/', '/desktop.html']) assert.equal((await tlsRequest(lan, 'GET', p, {})).status, 404, `LAN TLS listener does not serve ${p}`);
      assert.equal((await tlsRequest(lan, 'GET', '/api/eink/v1/snapshot', { token: device })).status, 200);
      // Diagnostics never leak credentials.
      const all = outputs.join('\n') + client.stderr + g.stderr + impostor.stderr + srv.readLog();
      assert.ok(!all.includes(device) && !all.includes(ctl), 'no token in any diagnostic output or log');
      // Listener binding: the RM2 TLS listener opens only on one validated private address of this Mac.
      const net = require('net');
      const lanIf = Object.values(L.os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address));
      assert.ok(lanIf, 'this check needs the test machine to have a private LAN address');
      const lanAddr = lanIf.address;
      const connect = (host, port) => new Promise((res) => { const c = net.connect({ host, port }, () => { c.destroy(); res('open'); }); c.setTimeout(1500, () => { c.destroy(); res('timeout'); }); c.on('error', (e) => res(e.code)); });
      const refusals = [['0.0.0.0', /wildcard address 0\.0\.0\.0/], ['::', /wildcard address ::/], ['::ffff:0.0.0.0', /wildcard/], ['8.8.8.8', /not a private LAN address/], ['::ffff:8.8.8.8', /not a private LAN address/], ['2001:4860:4860::8888', /not a private/], ['10.255.254.253', /not an address of this Mac/], ['not-an-address', /not an IP address/], ['', /no bind address configured/]];
      for (const [bind, why] of refusals) {
        const s2 = await L.startServer({ env: { ...tm.env, MATRIX_EINK_TLS_BIND: bind }, tls: true });
        assert.notEqual(await connect('127.0.0.1', s2.tlsPort), 'open', `bind ${JSON.stringify(bind)}: nothing listens on loopback`);
        assert.notEqual(await connect(lanAddr, s2.tlsPort), 'open', `bind ${JSON.stringify(bind)}: nothing listens on the LAN address`);
        assert.match(s2.readLog(), /E-ink LAN endpoint not started: /, 'the refusal is logged');
        assert.match(s2.readLog(), why, `bind ${JSON.stringify(bind)}: actionable reason`);
        assert.equal((await L.http('GET', `${s2.base}/`)).status, 200, 'Matrix itself still runs');
        await s2.stop();
      }
      const cli = L.spawnSync(process.execPath, [path.join(L.candidate, 'scripts/matrix-eink'), 'setup-tls', '--bind', '0.0.0.0'], { encoding: 'utf8', env: { ...process.env, MATRIX_HOME: L.tmp('clihome') } });
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /--bind refused: the wildcard address/);
      // Bound to the LAN address: the intended LAN path works, every other path to that port is closed.
      const s3 = await L.startServer({ env: { ...tm.env, MATRIX_EINK_TLS_BIND: lanAddr }, tls: true });
      const dev3 = s3.token('device');
      assert.equal(await connect(lanAddr, s3.tlsPort), 'open', 'the LAN address accepts connections');
      assert.equal(await connect('127.0.0.1', s3.tlsPort), 'ECONNREFUSED', 'the same port on another interface is closed: the listener is not a wildcard');
      const lanEp = { ...s3.endpoint('home-lan'), url: `https://${lanAddr}:${s3.tlsPort}` };
      assert.equal((await tlsRequest(lanEp, 'GET', '/api/eink/v1/snapshot', { token: dev3 })).status, 200, 'the RM2 route over the LAN address works with the pinned certificate');
      assert.match(s3.readLog(), new RegExp(`E-ink LAN endpoint \\(TLS\\) on ${lanAddr.replace(/\./g, '\\.')}:${s3.tlsPort} only`));
      // Matrix's main listener is on every interface for the legacy views; the e-ink API on it answers loopback only
      // (the hook and Tailscale Serve's local proxy), so no other listener bypasses the restriction.
      assert.equal((await L.http('GET', `http://${lanAddr}:${s3.port}/api/eink/v1/snapshot`, { token: dev3 })).status, 403, 'plaintext API over the LAN interface is refused');
      assert.equal((await L.http('POST', `http://${lanAddr}:${s3.port}/api/eink/v1/pair`, { body: { code: 'x' } })).status, 403);
      assert.equal((await L.http('GET', `http://127.0.0.1:${s3.port}/api/eink/v1/snapshot`, { token: dev3 })).status, 200, 'the loopback path (Tailscale Serve, hook) works');
      assert.equal((await L.http('GET', `http://${lanAddr}:${s3.port}/`)).status, 200, 'the legacy views keep their existing LAN behaviour');
      t.note(`listener binding: ${refusals.length} wildcard/public/mapped/non-local/malformed/missing bind values refused with reasons and nothing listening; bound to ${lanAddr} only (loopback on that port refused); API on the main port is loopback-only (LAN → 403). TLS: wrong cert, pin mismatch, name mismatch refused; no downgrade; http:// and URL credentials refused; redirect refused (1 hit, not followed); gateway refuses 0.0.0.0/::/public binds and 7 non-device requests (403); LAN listener serves only the API; no token in diagnostics`);
    },
  };
};
