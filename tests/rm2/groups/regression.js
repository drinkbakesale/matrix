// Regression group: for every new interaction group, one behavioural probe is
// run with the same assertion against (a) the exact base export 27534cd and
// (b) the candidate. The base must fail it at runtime and the candidate must
// pass it. The base runs its own unmodified production code: only this test
// harness, a tmux double and (as an outside device) the candidate-built RM2
// client talk to it. A probe that could not even be set up is an error, not a
// "base failure".
module.exports = (L) => {
  const { assert, fs, path } = L;
  const BASE_COMMIT = '27534cddc450dfb2003eb6c2733e543e5fda110d';
  const BASE_TAR_SHA256 = 'dbe380536b883fa31ffc730e553cfbc5a658cc8c93b04be4d172e8cd46bdc003';

  function baseRoot() {
    const tar = path.join(L.candidate, 'tests/rm2/base/base-27534cd.tar.gz');
    const sum = L.crypto.createHash('sha256').update(fs.readFileSync(tar)).digest('hex');
    assert.equal(sum, BASE_TAR_SHA256, 'the bundled base export is the recorded one');
    const dir = L.tmp('base');
    assert.equal(L.spawnSync('tar', ['xzf', tar, '-C', dir]).status, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'server/lib/eink')) && !fs.existsSync(path.join(dir, 'rm2')), 'the base export contains no candidate implementation');
    fs.symlinkSync(fs.realpathSync(path.join(L.candidate, 'node_modules')), path.join(dir, 'node_modules'));
    return dir;
  }

  async function target(root, label) {
    const tm = L.fakeTmux();
    const pane = tm.pane({});
    tm.setPanes([pane]);
    const home = L.tmp(`home-${label}`);
    // Pairing material is data on disk; it is created the same way for both targets.
    const auth = L.eink(home);
    const tok = { device: auth.issueToken('device').token, controller: auth.issueToken('controller').token, hook: auth.issueToken('hook').token };
    fs.writeFileSync(path.join(home, 'eink', 'hook-token'), tok.hook + '\n');
    const tls = L.spawnSync(process.execPath, [path.join(L.candidate, 'scripts', 'matrix-eink'), 'setup-tls', '--json'], { env: { ...process.env, MATRIX_HOME: home }, encoding: 'utf8' });
    const pin = JSON.parse(tls.stdout);
    const srv = await L.startServer({ root, home, env: tm.env, waitReady: false });
    // Setup must complete: the server (base or candidate) is really up and serving its existing surface.
    await L.until(async () => { const r = await fetch(`${srv.base}/api/sessions`).catch(() => null); return r && r.status === 200; }, 15000, `${label} server`);
    return { label, root, tm, pane, srv, tok, pin, sid: L.sessionId(pane), endpoint: { name: 'lan', url: `https://127.0.0.1:${srv.tlsPort}`, cert_pem: pin.cert_pem, server_name: pin.server_name, pin_sha256: pin.pin_sha256 } };
  }

  // One behavioural assertion per interaction group. Each returns normally or throws.
  const probes = {
    async evidence(x) {
      const r = await L.http('POST', `${x.srv.api}/hook`, { token: x.tok.hook, body: { v: 1, event_id: 'regress-evt-0001', seq: Date.now(), hook_event_name: 'UserPromptSubmit', session_id: 'conv-regress-01', prompt: 'REGRESSION PROMPT', cwd: '/tmp', pane: { server_pid: x.pane.pid, pane_id: x.pane.pane_id } } });
      assert.equal(r.status, 200, `hook evidence accepted (HTTP ${r.status})`);
      const s = (await L.http('GET', `${x.srv.api}/snapshot`, { token: x.tok.controller })).data;
      const me = s.sessions.find((q) => q.id === x.sid);
      assert.deepEqual([me.state, me.prompt.text], ['working', 'REGRESSION PROMPT'], 'a prompt makes the session working with the exact prompt');
    },
    async display(x) {
      // The production RM2 client (an outside device) connects and shows the session row.
      const client = await L.startClient({ endpoints: [x.endpoint], token: x.tok.device });
      try {
        const d = await client.waitDump((q) => q.conn.Status === 'fresh', 6000, 'the RM2 client to receive a snapshot and show rows');
        assert.ok(Object.keys(d.visible).some((k) => k.startsWith('row:')), 'a session row is drawn');
      } finally { await client.stop(); }
    },
    async control(x) {
      const page = await L.newPage();
      try {
        const res = await page.goto(`${x.srv.base}/control/`);
        assert.equal(res.status(), 200, `Control page is served (HTTP ${res.status()})`);
        assert.ok(await page.$('#draft'), 'Control has a draft box');
        const code = L.eink(x.srv.home).issuePairCode('controller').code;
        await page.fill('#pair-code', code);
        await page.click('#pair-form button');
        await page.waitForFunction(() => document.getElementById('conn').textContent === 'Live', null, { timeout: 6000 });
        await page.click('#sessions li');
        await page.locator('#draft').click();
        await page.keyboard.type('typed on the iPad');
        await L.until(async () => (await L.http('GET', `${x.srv.api}/snapshot`, { token: x.tok.controller })).data.sessions[0].draft.text === 'typed on the iPad', 4000, 'the typed draft to reach Matrix');
      } finally { await page.context().close(); }
    },
    async push(x) {
      const r = await L.http('POST', `${x.srv.api}/push/subscribe`, { token: x.tok.controller, body: { subscription: { endpoint: 'https://push.example.test/regress', keys: { p256dh: 'k', auth: 'a' } } } });
      assert.equal(r.status, 200, `Control push subscription accepted (HTTP ${r.status})`);
      const h = await L.http('GET', `${x.srv.api}/push/health`, { token: x.tok.controller });
      assert.equal(h.data.subscriptions, 1);
    },
    async recovery(x) {
      const res = await fetch(`${x.srv.api}/events`, { headers: { Authorization: `Bearer ${x.tok.device}` } });
      assert.equal(res.status, 200, `event stream opens (HTTP ${res.status})`);
      const reader = res.body.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      assert.ok(first.startsWith('event: snapshot'), 'the stream starts with an authoritative snapshot');
      assert.match(first, /"epoch":"[0-9a-f]{16}"/, 'carrying a server epoch for resync');
    },
    async network(x) {
      const cfg = path.join(L.tmp('pf'), 'c.json');
      fs.writeFileSync(cfg, JSON.stringify({ endpoints: [x.endpoint], token: x.tok.device }));
      const r = L.spawnSync(L.hostBin(), ['probe', '--config', cfg], { encoding: 'utf8' });
      assert.equal(r.status, 0, `the pinned private TLS route answers (${r.stdout.trim() || r.stderr.trim()})`);
    },
    async device(x) {
      // The tablet's first-run report (model, software version, display, route, touch), produced by the
      // production client acting as the outside device, must pass against this Matrix.
      const client = await L.startClient({ endpoints: [x.endpoint], token: x.tok.device, firstrunTap: false });
      try {
        await L.until(() => client.firstrun || client.exited(), 20000, 'the first-run report');
        const checks = client.firstrun.firstrun.checks;
        assert.equal(client.firstrun.firstrun.version, '3.28.0.162');
        const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
        assert.deepEqual(failed, [], `every first-run check passes (failed: ${failed.join('; ').slice(0, 200)})`);
      } finally { await client.stop(); }
    },
    async security(x) {
      const r = await L.http('POST', `${x.srv.api}/submit`, { body: { session_id: x.sid } });
      assert.equal(r.status, 401, `an unauthenticated submit is refused as unauthenticated (HTTP ${r.status})`);
      const ok = await L.http('GET', `${x.srv.api}/snapshot`, { token: x.tok.device });
      assert.equal(ok.status, 200, `and a paired device is admitted (HTTP ${ok.status})`);
    },
  };

  return {
    async base_red_candidate_green(t) {
      const results = [];
      const log = { base_commit: BASE_COMMIT, base_export_sha256: BASE_TAR_SHA256, candidate: L.candidate, generated_at: new Date().toISOString(), groups: {} };
      for (const group of Object.keys(probes)) {
        const entry = { assertion_id: `RM2_regression::${group}` };
        for (const label of ['base', 'candidate']) {
          const root = label === 'base' ? baseRoot() : L.candidate; // a fresh, unmodified base export every time
          const x = await target(root, label); // throws if setup cannot complete: that is a harness error, not a red
          let outcome;
          try { await probes[group](x); outcome = { status: 'passed', detail: '' }; } catch (err) { outcome = { status: 'failed', detail: String(err.message).split('\n')[0].slice(0, 400) }; }
          entry[label] = { ...outcome, setup: 'completed', server_alive: !x.srv.exited(), server_log_tail: x.srv.readLog().split('\n').slice(-4) };
          assert.ok(!x.srv.exited(), `${label} server was running for ${group}`);
          await L.cleanup();
        }
        log.groups[group] = entry;
        results.push(`${group}: base ${entry.base.status}${entry.base.detail ? ` (${entry.base.detail.slice(0, 90)})` : ''} / candidate ${entry.candidate.status}`);
      }
      fs.writeFileSync(path.join(t.dir, 'base-red-candidate-green.json'), JSON.stringify(log, null, 1));
      const junit = ['<?xml version="1.0"?>', '<testsuites>'];
      for (const side of ['base', 'candidate']) {
        junit.push(`<testsuite name="RM2_regression@${side === 'base' ? BASE_COMMIT : 'candidate'}" tests="${Object.keys(probes).length}">`);
        for (const [g, e] of Object.entries(log.groups)) junit.push(`<testcase classname="RM2_regression" name="${g}">${e[side].status === 'failed' ? `<failure message="${e[side].detail.replace(/[<>&"]/g, ' ')}"/>` : ''}</testcase>`);
        junit.push('</testsuite>');
      }
      junit.push('</testsuites>');
      fs.writeFileSync(path.join(t.dir, 'base-red-candidate-green.junit.xml'), junit.join('\n'));
      for (const [g, e] of Object.entries(log.groups)) {
        assert.equal(e.base.status, 'failed', `${g}: the base must fail this behavioural assertion`);
        assert.ok(!/Cannot find module|SyntaxError|is not a function|ENOENT.*tests\/rm2/.test(e.base.detail), `${g}: the base failure is behavioural, not a missing test dependency (${e.base.detail})`);
        assert.equal(e.candidate.status, 'passed', `${g}: the candidate must pass the same assertion (${e.candidate.detail})`);
      }
      t.note(results.join(' | '));
    },
  };
};
