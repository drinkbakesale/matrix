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

  // Each probe only OBSERVES (after setup has completed) and returns plain data. It asserts nothing.
  const observe = {
    async evidence(x) {
      const r = await L.http('POST', `${x.srv.api}/hook`, { token: x.tok.hook, body: { v: 1, event_id: 'regress-evt-0001', seq: Date.now(), hook_event_name: 'UserPromptSubmit', session_id: 'conv-regress-01', prompt: 'REGRESSION PROMPT', cwd: '/tmp', pane: { server_pid: x.pane.pid, pane_id: x.pane.pane_id } } });
      const s = await L.http('GET', `${x.srv.api}/snapshot`, { token: x.tok.controller });
      const me = s.data && s.data.sessions ? s.data.sessions.find((q) => q.id === x.sid) : null;
      return { hook_status: r.status, snapshot_status: s.status, state: me ? me.state : null, prompt: me ? me.prompt.text : null };
    },
    async display(x) {
      const client = await L.startClient({ endpoints: [x.endpoint], token: x.tok.device, firstrunTap: false });
      await L.until(() => client.firstrun || client.exited(), 20000, 'the client first-run screen');
      client.tap(700, 900);
      let dump = null;
      try { dump = await client.waitDump((q) => q.conn && q.conn.Status === 'fresh', 6000, 'fresh'); } catch { dump = await client.dump().catch(() => null); }
      const out = { conn: dump ? dump.conn.Status : 'no dump', rows: dump ? Object.keys(dump.visible).filter((k) => k.startsWith('row:')).length : 0, conn_detail: dump ? dump.conn.Detail : '', trace: client.lines.slice(-6), stderr: client.stderr.slice(-400) };
      await client.stop();
      return out;
    },
    async control(x) {
      const page = await L.newPage();
      const res = await page.goto(`${x.srv.base}/control/`);
      const out = { page_status: res.status(), has_draft_box: !!(await page.$('#draft')), draft_on_mac: null };
      if (out.has_draft_box) {
        await page.fill('#pair-code', L.eink(x.srv.home).issuePairCode('controller').code);
        await page.click('#pair-form button');
        await page.waitForFunction(() => document.getElementById('conn').textContent === 'Live', null, { timeout: 6000 });
        await page.click('#sessions li');
        await page.locator('#draft').click();
        await page.keyboard.type('typed on the iPad');
        await L.wait(600);
        out.draft_on_mac = (await L.http('GET', `${x.srv.api}/snapshot`, { token: x.tok.controller })).data.sessions[0].draft.text;
      }
      await page.context().close();
      return out;
    },
    async push(x) {
      const r = await L.http('POST', `${x.srv.api}/push/subscribe`, { token: x.tok.controller, body: { subscription: { endpoint: 'https://push.example.test/regress', keys: { p256dh: 'k', auth: 'a' } } } });
      const h = await L.http('GET', `${x.srv.api}/push/health`, { token: x.tok.controller });
      return { subscribe_status: r.status, health_status: h.status, subscriptions: h.data ? h.data.subscriptions : null };
    },
    async recovery(x) {
      const res = await fetch(`${x.srv.api}/events`, { headers: { Authorization: `Bearer ${x.tok.device}` } });
      let first = '';
      if (res.status === 200) { const reader = res.body.getReader(); first = new TextDecoder().decode((await reader.read()).value); await reader.cancel(); } else await res.text();
      return { stream_status: res.status, first_event: (/^event: (\w+)/.exec(first) || [])[1] || null, has_epoch: /"epoch":"[0-9a-f]{16}"/.test(first) };
    },
    async network(x) {
      const cfg = path.join(L.tmp('pf'), 'c.json');
      fs.writeFileSync(cfg, JSON.stringify({ endpoints: [x.endpoint], token: x.tok.device }));
      const r = L.spawnSync(L.hostBin(), ['probe', '--config', cfg], { encoding: 'utf8' });
      let res = null; try { res = JSON.parse(r.stdout).results[0]; } catch { /* no JSON */ }
      return { exit: r.status, stage: res ? res.stage : null, reason: res ? res.reason : r.stderr.trim() };
    },
    async device(x) {
      const client = await L.startClient({ endpoints: [x.endpoint], token: x.tok.device, firstrunTap: false });
      await L.until(() => client.firstrun || client.exited(), 20000, 'the first-run report');
      const rep = client.firstrun ? client.firstrun.firstrun : null;
      const out = { version: rep ? rep.version : null, failed_checks: rep ? rep.checks.filter((c) => !c.ok).map((c) => c.name) : null, checks: rep ? rep.checks : null };
      await client.stop();
      return out;
    },
    async security(x) {
      const r = await L.http('POST', `${x.srv.api}/submit`, { body: { session_id: x.sid } });
      const ok = await L.http('GET', `${x.srv.api}/snapshot`, { token: x.tok.device });
      return { unauthenticated_submit_status: r.status, paired_device_snapshot_status: ok.status };
    },
  };

  // The behavioural assertion for each group: identical for base and candidate.
  const mustHold = {
    evidence: (o) => assert.deepEqual([o.hook_status, o.state, o.prompt], [200, 'working', 'REGRESSION PROMPT'], 'hook evidence makes the session working with the exact prompt'),
    display: (o) => assert.deepEqual([o.conn, o.rows >= 1], ['fresh', true], 'the RM2 client receives a snapshot and draws a session row'),
    control: (o) => assert.deepEqual([o.page_status, o.has_draft_box, o.draft_on_mac], [200, true, 'typed on the iPad'], 'typing in Control reaches Matrix as a draft'),
    push: (o) => assert.deepEqual([o.subscribe_status, o.subscriptions], [200, 1], 'Control can subscribe to notifications'),
    recovery: (o) => assert.deepEqual([o.stream_status, o.first_event, o.has_epoch], [200, 'snapshot', true], 'the event stream starts with a snapshot carrying an epoch'),
    network: (o) => assert.deepEqual([o.exit, o.stage], [0, 'ok'], 'the pinned private TLS route answers an authenticated snapshot'),
    device: (o) => assert.deepEqual([o.version, o.failed_checks], ['3.28.0.162', []], 'every first-run check passes'),
    security: (o) => assert.deepEqual([o.unauthenticated_submit_status, o.paired_device_snapshot_status], [401, 200], 'unauthenticated submit is 401 and a paired device is admitted'),
  };

  // The explicit behavioural failure expected on the base: the feature's surface is absent at runtime.
  // Anything else on the base (a crash, a harness error, a different status) is NOT accepted as "red".
  const expectedBaseFailure = {
    evidence: (o) => o.hook_status === 404 && o.snapshot_status === 404,
    display: (o) => o.conn !== 'fresh' && o.rows === 0 && /connect|refused/.test(o.conn_detail || ''),
    control: (o) => o.page_status === 404 && o.has_draft_box === false,
    push: (o) => o.subscribe_status === 404 && o.health_status === 404,
    recovery: (o) => o.stream_status === 404,
    network: (o) => o.exit === 1 && o.stage === 'connect',
    device: (o) => o.version === '3.28.0.162' && o.failed_checks.length === 1 && o.failed_checks[0] === 'route lan',
    security: (o) => o.unauthenticated_submit_status === 404 && o.paired_device_snapshot_status === 404,
  };

  const EXPECTED = {
    evidence: ['full_turn', 'questions_permissions', 'identity_isolation', 'corruption_unknown', 'stuck_rules', 'files_provenance', 'replay_order'],
    display: ['pixels_and_modes', 'real_touch', 'pagination', 'quiet_boundaries', 'lifecycle'],
    control: ['bidirectional_selection', 'keyboard_mouse_ime', 'literal_submit', 'selection_race', 'pending_answer', 'quick_access'],
    push: ['all_transitions', 'durable_dedup', 'failure_health', 'click_routing'],
    recovery: ['stale_and_reconnect', 'epoch_gap', 'draft_persistence', 'uncertain_delivery', 'session_survival'],
    network: ['endpoint_failover', 'route_preflight', 'private_transport'],
    device: ['arm_package', 'firmware_preflight', 'install_restore', 'rollback_failures', 'unsupported_report'],
    security: ['capabilities', 'identity_and_paths', 'injection_and_secrets', 'persistence_failure'],
    compatibility: ['old_views', 'worker_isolation'],
  };

  // Validates the result files the controller (or a local full run) produced for the other groups:
  // every expected candidate id must be present and passed; a skip or a missing file is a failure.
  function siblingResults() {
    const outDir = path.dirname(L.artifacts); // <dir>/regression-artifacts -> <dir>
    const report = {};
    for (const [group, names] of Object.entries(EXPECTED)) {
      const candidates = [path.join(outDir, `${group}.json`), path.join(outDir, '..', '..', group, 'artifacts', `${group}.json`)];
      const file = candidates.find((f) => fs.existsSync(f));
      assert.ok(file, `result file for group ${group} not found next to this run (looked in ${candidates.join(' and ')})`);
      const got = Object.fromEntries(JSON.parse(fs.readFileSync(file, 'utf8')).assertions.map((a) => [a.id, a.status]));
      for (const n of names) assert.equal(got[`RM2_${group}::${n}`], 'passed', `RM2_${group}::${n} must have run and passed with no skip (found ${got[`RM2_${group}::${n}`]})`);
      report[group] = { file, ids: names.length };
    }
    return report;
  }

  return {
    async base_red_candidate_green(t) {
      const git = L.spawnSync('git', ['-C', L.candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      const log = { base_commit: BASE_COMMIT, base_export_sha256: BASE_TAR_SHA256, candidate_commit: git.status === 0 ? git.stdout.trim() : 'not a git checkout', candidate_dir: L.candidate, generated_at: new Date().toISOString(), groups: {} };
      const results = [];
      for (const group of Object.keys(observe)) {
        const entry = { assertion_id: `RM2_regression::${group}`, assertion: mustHold[group].toString(), expected_base_failure: expectedBaseFailure[group].toString() };
        for (const label of ['base', 'candidate']) {
          const root = label === 'base' ? baseRoot() : L.candidate; // a fresh, unmodified base export every time
          // --- setup (must complete; a failure here is a harness error and fails the whole case) ---
          const x = await target(root, label);
          // --- observation ---
          const observed = await observe[group](x);
          assert.ok(!x.srv.exited(), `${label} server was running for the ${group} probe`);
          // --- verdict ---
          let status = 'passed'; let detail = '';
          try { mustHold[group](observed); } catch (err) { status = 'failed'; detail = String(err.message).split('\n')[0].slice(0, 300); }
          entry[label] = { setup: 'completed', observed, status, detail, expected_base_failure_matched: label === 'base' ? expectedBaseFailure[group](observed) : undefined };
          // Full traces are written before anything is cleaned up.
          fs.writeFileSync(path.join(t.dir, `${group}-${label}-observed.json`), JSON.stringify(entry[label], null, 1));
          fs.copyFileSync(x.srv.log, path.join(t.dir, `${group}-${label}-server.log`));
          await L.cleanup();
        }
        log.groups[group] = entry;
        results.push(`${group}: base ${entry.base.status} (expected failure matched: ${entry.base.expected_base_failure_matched}) / candidate ${entry.candidate.status}`);
      }
      log.candidate_results = siblingResults();
      fs.writeFileSync(path.join(t.dir, 'base-red-candidate-green.json'), JSON.stringify(log, null, 1));
      const junit = ['<?xml version="1.0"?>', '<testsuites>'];
      for (const side of ['base', 'candidate']) {
        junit.push(`<testsuite name="RM2_regression@${side === 'base' ? BASE_COMMIT : log.candidate_commit}" tests="${Object.keys(observe).length}">`);
        for (const [g, e] of Object.entries(log.groups)) junit.push(`<testcase classname="RM2_regression" name="${g}">${e[side].status === 'failed' ? `<failure message="${e[side].detail.replace(/[<>&"]/g, ' ')}"/>` : ''}</testcase>`);
        junit.push('</testsuite>');
      }
      junit.push('</testsuites>');
      fs.writeFileSync(path.join(t.dir, 'base-red-candidate-green.junit.xml'), junit.join('\n'));
      for (const [g, e] of Object.entries(log.groups)) {
        assert.equal(e.base.status, 'failed', `${g}: the base must fail this behavioural assertion`);
        assert.equal(e.base.expected_base_failure_matched, true, `${g}: the base failed, but not in the expected behavioural way: ${JSON.stringify(e.base.observed).slice(0, 300)}`);
        assert.equal(e.candidate.status, 'passed', `${g}: the candidate must pass the same assertion (${e.candidate.detail})`);
      }
      t.note(`base ${BASE_COMMIT.slice(0, 7)} vs candidate ${log.candidate_commit.slice(0, 12)}: ${results.join(' | ')}; all ${Object.values(EXPECTED).flat().length} other candidate ids validated as passed with no skips`);
    },
  };
};
