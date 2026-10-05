// Security group: the real HTTP API with real tokens, the real page in WebKit,
// and (for disk faults) the real service with a failing filesystem.
module.exports = (L) => {
  const { assert, fs, path } = L;

  async function setup(panes) {
    const tm = L.fakeTmux();
    const list = (panes || [{}]).map((p) => tm.pane(p));
    tm.setPanes(list);
    const srv = await L.startServer({ env: tm.env });
    const hookTok = L.hookToken(srv);
    const tok = { device: srv.token('device'), controller: srv.token('controller'), hook: hookTok };
    for (const p of list) L.hook(srv, p, { session_id: `conv-sec-${p.pane_id.slice(1)}-0001`, hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
    const snap = async () => (await L.http('GET', `${srv.api}/snapshot`, { token: tok.controller })).data;
    const persisted = () => ['state.json', 'drafts.json', 'commands.jsonl', 'outbox.json'].map((f) => { try { return fs.readFileSync(path.join(srv.home, 'eink', f), 'utf8'); } catch { return null; } }).join('|');
    return { tm, srv, list, tok, snap, persisted, ids: list.map(L.sessionId) };
  }
  const rawHook = (pane, extra = {}) => ({ v: 1, event_id: `sec-evt-${Math.random().toString(16).slice(2)}aaaa`, seq: Date.now() + Math.random(), hook_event_name: 'UserPromptSubmit', session_id: 'conv-sec-raw-0001', prompt: 'x', cwd: '/tmp', pane: { server_pid: pane.pid, pane_id: pane.pane_id }, ...extra });

  return {
    async capabilities(t) {
      const x = await setup();
      const [sid] = x.ids; const api = x.srv.api;
      await L.http('POST', `${api}/select`, { token: x.tok.controller, body: { session_id: sid, base_revision: 1 } });
      await L.http('PUT', `${api}/draft`, { token: x.tok.controller, body: { session_id: sid, text: 'kept draft', revision: 1 } });
      const revoked = x.srv.auth().issueToken('controller');
      x.srv.auth().revoke(revoked.id);
      const expired = x.srv.auth().issueToken('controller', { ttlMs: 1 });
      await L.wait(20);
      const submit = { session_id: sid, selection_revision: 2, draft_revision: 1, idempotency_id: 'cap-submit-00001' };
      const routes = [
        ['GET', '/snapshot'], ['GET', '/push/health'], ['GET', '/push/vapid-key'],
        ['POST', '/select', { session_id: sid, base_revision: 2 }], ['POST', '/view', { digest_page: 3, row_page: 0, draft_page: -1 }],
        ['PUT', '/draft', { session_id: sid, text: 'OVERWRITTEN', revision: 9 }], ['POST', '/submit', submit],
        ['POST', '/answer', { ...submit, question_id: 'q', keys: ['1'], idempotency_id: 'cap-answer-00001' }], ['POST', '/key', { ...submit, keys: ['Enter'], idempotency_id: 'cap-key-0000001' }],
        ['POST', '/bind', { session_id: sid, pane_id: '%1' }], ['POST', '/hook', rawHook(x.list[0], { prompt: 'INJECTED PROMPT' })],
        ['POST', '/push/subscribe', { subscription: { endpoint: 'https://push.example.test/x', keys: { p256dh: 'k', auth: 'a' } } }],
      ];
      const before = x.persisted();
      let rejected = 0;
      const expect = async (label, opts, status, only) => {
        for (const [m, p, body] of routes) {
          if (only && !only.includes(p)) continue;
          const r = await L.http(m, `${api}${p}`, { ...opts, body });
          assert.ok(status.includes(r.status), `${label}: ${m} ${p} → ${r.status}, expected ${status}`);
          rejected += 1;
        }
      };
      await expect('no token', {}, [401]);
      await expect('garbage token', { token: 'mx_controller_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, [401]);
      await expect('revoked token', { token: revoked.token }, [401]);
      await expect('expired token', { token: expired.token }, [401]);
      await expect('RM2 device token on controller routes', { token: x.tok.device }, [403], ['/draft', '/submit', '/answer', '/key', '/bind', '/push/subscribe', '/push/vapid-key', '/hook']);
      await expect('browser token on hook ingestion', { token: x.tok.controller }, [403], ['/hook']);
      await expect('hook token elsewhere', { token: x.tok.hook }, [403], ['/snapshot', '/select', '/view', '/draft', '/submit', '/answer', '/key', '/bind', '/push/subscribe', '/push/health', '/push/vapid-key']);
      await expect('cross-origin', { token: x.tok.controller, headers: { Origin: 'https://evil.example' } }, [403]);
      await expect('cross-site fetch metadata', { token: x.tok.controller, headers: { 'Sec-Fetch-Site': 'cross-site' } }, [403]);
      await expect('proxied hook', { token: x.tok.hook, headers: { 'X-Forwarded-For': '100.64.0.9' } }, [403], ['/hook']);
      const q = await L.http('GET', `${api}/snapshot?token=${x.tok.controller}`, {});
      assert.equal(q.status, 400, 'a token in the URL is refused');
      // Pairing codes: wrong, used and expired.
      const code = x.srv.pairCode();
      assert.equal((await L.http('POST', `${api}/pair`, { body: { code: 'NOPE000000' } })).status, 403);
      assert.equal((await L.http('POST', `${api}/pair`, { body: { code } })).status, 200);
      assert.equal((await L.http('POST', `${api}/pair`, { body: { code } })).status, 403, 'a pairing code works once');
      const old = x.srv.pairCode();
      const tf = path.join(x.srv.home, 'eink', 'tokens.json');
      const doc = JSON.parse(fs.readFileSync(tf, 'utf8')); doc.codes.forEach((c) => { c.expires_at = Date.now() - 1000; }); fs.writeFileSync(tf, JSON.stringify(doc));
      const ex = await L.http('POST', `${api}/pair`, { body: { code: old } });
      assert.deepEqual([ex.status, ex.data.error], [403, 'pairing code expired']);
      // Zero side effects from every rejected request.
      const mid = x.persisted();
      const strip = (s) => s.replace(/"tokens\.json"/g, '');
      assert.equal(strip(mid), strip(before), 'no persisted state changed');
      const s = await x.snap();
      assert.deepEqual([s.selection.revision, s.view.digest_page, s.sessions[0].draft.text, s.sessions[0].prompt.text], [2, 0, 'kept draft', 'hello']);
      assert.deepEqual(x.tm.sent(), [], 'nothing reached a pane');
      // The valid capabilities do work.
      assert.equal((await L.http('GET', `${api}/snapshot`, { token: x.tok.device })).status, 200);
      assert.equal((await L.http('POST', `${api}/select`, { token: x.tok.device, body: { session_id: sid, base_revision: 2 } })).status, 200, 'the RM2 may select');
      assert.equal((await L.http('POST', `${api}/select`, { token: x.tok.controller, body: { session_id: sid, base_revision: 3 }, headers: { Origin: `http://127.0.0.1:${x.srv.port}` } })).status, 200, 'same-origin browser requests pass');
      const ok = await L.http('POST', `${api}/submit`, { token: x.tok.controller, body: { ...submit, selection_revision: 4 } });
      assert.equal(ok.status, 200);
      assert.equal(x.tm.sent().filter((q2) => q2.type === 'paste').length, 1);
      assert.equal((await L.http('POST', `${api}/hook`, { token: x.tok.hook, body: rawHook(x.list[0], { prompt: 'valid hook' }) })).status, 200);
      t.note(`${rejected} rejected requests (no/garbage/revoked/expired token, wrong scope, cross-origin, cross-site, proxied hook) with 0 side effects; pairing code wrong/used/expired → 403; valid device read+select and controller submit succeed`);
    },

    async identity_and_paths(t) {
      const dead = { session_id: '$2', session_name: 'deadpane', pane_id: '%2' };
      const x = await setup([{}, dead]);
      const [sid, deadSid] = x.ids; const api = x.srv.api; const c = x.tok.controller;
      const post = (p, body, m = 'POST') => L.http(m, `${api}${p}`, { token: c, body });
      const callsBefore = () => x.tm.calls().filter((q) => !['list-panes', 'capture-pane'].includes(q.argv[0])).length;
      // Malformed identities.
      for (const bad of ['../../etc/passwd', 's_ZZZZZZZZZZZZ', 's_0123', '', 42, null, 's_0123456789ab; rm -rf /', '%1']) {
        const r = await post('/select', { session_id: bad, base_revision: 1 });
        assert.ok([400, 404].includes(r.status), `select ${JSON.stringify(bad)} → ${r.status}`);
      }
      assert.equal((await post('/select', { session_id: 's_0123456789ab', base_revision: 1 })).status, 404, 'unknown but well-formed session');
      // A dead pane cannot receive input.
      await post('/select', { session_id: deadSid, base_revision: 1 });
      await post('/draft', { session_id: deadSid, text: 'to a dead pane', revision: 1 }, 'PUT');
      x.tm.setPanes([x.list[0], { ...x.list[1], pane_dead: '1' }]);
      let r = await post('/submit', { session_id: deadSid, selection_revision: 2, draft_revision: 1, idempotency_id: 'ident-dead-0001' });
      assert.equal(r.status, 410, 'dead pane → 410');
      // The session is replaced by a new generation with the same name.
      x.tm.setPanes([x.list[0], { ...x.list[1], session_created: '1900000000' }]);
      r = await post('/submit', { session_id: deadSid, selection_revision: 2, draft_revision: 1, idempotency_id: 'ident-stale-0001' });
      assert.ok([409, 410].includes(r.status), `stale generation → ${r.status}`);
      r = await post('/key', { session_id: deadSid, selection_revision: 2, keys: ['Enter'], idempotency_id: 'ident-stale-0002' });
      assert.ok([409, 410].includes(r.status));
      // Binding to a pane that has no evidence, or a hostile pane id.
      for (const pane of ['%99', '%1; touch /tmp/x', '../1']) assert.equal((await post('/bind', { session_id: sid, pane_id: pane })).status, 409);
      // Transcript paths outside the Claude projects directory are refused and never read.
      const outside = path.join(L.tmp('outside'), 'secret.jsonl');
      fs.writeFileSync(outside, JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'OUTSIDE-SECRET' }] } }) + '\n');
      const hook = (extra) => L.http('POST', `${api}/hook`, { token: x.tok.hook, body: rawHook(x.list[0], extra) });
      for (const p of [outside, '/etc/passwd', path.join(x.srv.transcripts, '..', '..', 'escape.jsonl'), `${x.srv.transcripts}/../x.jsonl`, path.join(x.srv.home, 'eink', 'tokens.json'), 'relative/path.jsonl']) {
        const h = await hook({ transcript_path: p });
        assert.equal(h.status, 400, `transcript ${p} → ${h.status}`);
        assert.match(h.data.error, /outside the Claude projects directory/);
      }
      const atime = fs.statSync(outside).atimeMs;
      await hook({ hook_event_name: 'Stop', session_id: 'conv-sec-1-0001' });
      assert.ok(!JSON.stringify(await x.snap()).includes('OUTSIDE-SECRET'));
      assert.equal(fs.statSync(outside).atimeMs, atime, 'the outside file was never opened');
      // Malformed hook identities.
      for (const bad of [{ pane: { server_pid: '1; ls', pane_id: '%1' } }, { pane: { server_pid: '4242', pane_id: '1' } }, { session_id: '../x' }, { event_id: 'x' }, { hook_event_name: 'Arbitrary' }, { seq: 'now' }]) {
        assert.equal((await hook(bad)).status, 400, `hook ${JSON.stringify(bad)} rejected`);
      }
      // Size limits.
      assert.equal((await post('/draft', { session_id: sid, text: 'x'.repeat(65537), revision: 5 }, 'PUT')).status, 413, 'draft over the limit');
      assert.equal((await post('/draft', { session_id: sid, text: 'x'.repeat(300000), revision: 5 }, 'PUT')).status, 413, 'body over the limit');
      const big = await hook({ prompt: 'y'.repeat(400000) });
      assert.equal(big.status, 413);
      assert.equal((await L.http('POST', `${api}/select`, { token: c, body: '{not json', headers: { 'Content-Type': 'application/json' } })).status, 400, 'malformed JSON → explicit 400');
      assert.equal((await post('/view', { digest_page: -5, row_page: 'x', draft_page: 1e9 })).status, 400);
      assert.equal((await post('/key', { session_id: sid, selection_revision: 1, keys: ['a'.repeat(50)], idempotency_id: 'ident-key-00001' })).status, 409);
      // Nothing beyond listing/reading was ever executed.
      assert.equal(callsBefore(), 0, 'no send, paste or key subprocess ran for any rejected command');
      assert.deepEqual(x.tm.sent(), []);
      assert.ok(x.tm.calls().every((q) => q.argv.every((a) => !/rm -rf|touch \/tmp/.test(a))), 'no hostile text reached a subprocess');
      t.note('8 malformed session ids, dead pane (410), replaced generation, 3 bad pane bindings, 6 out-of-scope transcript paths (400, never opened), 6 malformed hook identities, 3 oversize payloads (413), malformed JSON → all explicit 4xx; 0 send subprocesses');
    },

    async injection_and_secrets(t) {
      const marker = path.join(L.tmp('m'), 'PWNED');
      const evilName = `$(touch ${marker}) ; rm -rf ~ "q" 'x' \`id\``;
      const evilProject = '<img src=x onerror="window.__xss=1"><b>bold</b>';
      const x = await setup([{ session_name: evilName, '@matrix_project': evilProject }]);
      const [sid] = x.ids; const [pane] = x.list;
      const evilText = '<script>window.__xss=2</script><b>B</b> & "q" $(touch ' + marker + '2)';
      L.hook(x.srv, pane, { session_id: 'conv-sec-1-0001', hook_event_name: 'UserPromptSubmit', prompt: evilText });
      L.hook(x.srv, pane, { session_id: 'conv-sec-1-0001', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: '/w/<i>file</i>.js' }, tool_response: {} });
      L.hook(x.srv, pane, { session_id: 'conv-sec-1-0001', hook_event_name: 'Stop', last_assistant_message: evilText });
      const page = await L.newPage();
      const urls = [];
      page.on('request', (r) => urls.push(r.url()));
      await page.goto(`${x.srv.base}/control/`);
      await page.fill('#pair-code', x.srv.pairCode());
      await page.click('#pair-form button');
      await page.waitForFunction(() => document.getElementById('conn').textContent === 'Live');
      await page.click('#sessions li');
      await page.waitForFunction(() => document.getElementById('prompt').textContent.includes('<script>'));
      assert.equal(await page.evaluate(() => window.__xss), undefined, 'no injected script or handler ran');
      assert.equal(await page.textContent('#prompt'), evilText, 'markup is shown as literal text');
      assert.equal(await page.textContent('#message'), evilText);
      assert.ok((await page.textContent('#sessions li')).includes('<img src=x'), 'the session label is literal text');
      assert.ok((await page.textContent('#files')).includes('<i>file</i>.js'));
      assert.equal(await page.evaluate(() => document.querySelectorAll('main script, main img, main b, main i').length), 0, 'no element was created from session text');
      // The hostile session name and user text stay argv/literal data all the way to tmux.
      await page.locator('#draft').click();
      await page.keyboard.insertText(evilText);
      await page.click('#submit');
      await L.until(() => x.tm.sent().length === 2, 3000, 'send');
      assert.deepEqual(x.tm.sent()[0], { type: 'paste', pane: '%1', text: evilText, bracketed: true, raw: true });
      for (const call of x.tm.calls()) for (const a of call.argv) assert.ok(!a.includes(evilName), 'the session name is never passed to tmux by the e-ink service');
      assert.ok(!fs.existsSync(marker) && !fs.existsSync(marker + '2'), 'no shell interpreted the name or the text');
      // The RM2 client renders the same text as glyphs (it has no markup at all).
      const snap = await x.snap();
      assert.equal(snap.sessions[0].label, `${evilProject} · ${evilName}`);
      // Secrets: never in URLs, logs, error bodies.
      const token = await page.evaluate(() => localStorage.getItem('matrix-control-token'));
      assert.match(token, /^mx_controller_/);
      assert.ok(urls.length > 5 && urls.every((u) => !u.includes(token) && !/token=|mx_/.test(u)), 'no credential in any request URL');
      const errors = [];
      for (const [m, p, tok, body] of [['POST', '/submit', token, { session_id: sid }], ['POST', '/select', token, { session_id: 'bad' }], ['GET', '/snapshot', token.slice(0, -2) + 'zz'], ['POST', '/hook', token, {}], ['PUT', '/draft', x.tok.device, { session_id: sid, text: 'x', revision: 1 }], ['POST', '/pair', null, { code: token }]]) {
        errors.push((await L.http(m, `${x.srv.api}${p}`, { token: tok, body })).text);
      }
      const all = [errors.join('\n'), x.srv.readLog(), ...['state.json', 'drafts.json', 'commands.jsonl', 'outbox.json'].map((f) => { try { return fs.readFileSync(path.join(x.srv.home, 'eink', f), 'utf8'); } catch { return ''; } })].join('\n');
      for (const secret of [token, x.tok.device, x.tok.hook, x.tok.controller]) assert.ok(!all.includes(secret), 'no token in error responses, server log or state files');
      const stored = fs.readFileSync(path.join(x.srv.home, 'eink', 'tokens.json'), 'utf8');
      assert.ok(!stored.includes(token) && /"hash":"[0-9a-f]{64}"/.test(stored), 'tokens are stored only as hashes');
      // A plaintext endpoint is refused by the client configuration: there is no downgrade path.
      const cfg = path.join(L.tmp('cfg'), 'c.json');
      fs.writeFileSync(cfg, JSON.stringify({ endpoints: [{ name: 'plain', url: `http://127.0.0.1:${x.srv.port}` }], token: x.tok.device }));
      const pr = L.spawnSync(L.hostBin(), ['probe', '--config', cfg], { encoding: 'utf8' });
      assert.equal(pr.status, 2);
      assert.match(pr.stderr, /plaintext is refused/);
      assert.ok(!pr.stderr.includes(x.tok.device));
      t.note(`hostile session name/project/prompt/message/file path rendered as text in WebKit (0 elements created, no script ran); submit carried exact text, 0 shell execution; ${urls.length} request URLs, 6 error bodies, server log and state files contain no token; tokens stored hashed; plaintext endpoint refused`);
    },

    async persistence_failure(t) {
      const real = require('fs');
      let failing = null;
      const fsImpl = new Proxy(real, { get(target, prop) {
        if (prop === 'openSync') return (file, ...rest) => { if (failing && String(file).includes(failing)) { const e = new Error('EIO: i/o error, write'); e.code = 'EIO'; throw e; } return target.openSync(file, ...rest); };
        return target[prop];
      } });
      const tm = L.fakeTmux(); const pane = tm.pane({}); tm.setPanes([pane]);
      process.env.FAKE_TMUX_DIR = tm.dir;
      const home = L.tmp('persist');
      const { build } = require(path.join(L.candidate, 'server/lib/eink'));
      const mk = () => build({ home, tmuxBin: tm.bin, sendPush: async () => {}, vapidReady: () => true, transcriptRoot: home, fs: fsImpl });
      let sys = mk();
      await sys.evidence.collect();
      const sid = L.sessionId(pane);
      const ev = (name, extra = {}) => ({ v: 1, event_id: `per-evt-${name}-${extra.n || 1}`, seq: Date.now() + (extra.n || 0), hook_event_name: name, session_id: 'conv-persist-01', cwd: home, pane: { server_pid: pane.pid, pane_id: pane.pane_id }, ...extra });
      await sys.evidence.ingest(ev('UserPromptSubmit', { prompt: 'first' }));
      sys.service.select({ session_id: sid, base_revision: 1 });
      sys.service.putDraft({ session_id: sid, text: 'saved draft', revision: 1 });
      let events = 0;
      sys.service.addClient(() => { events += 1; });
      const view = () => { const s = sys.service.snapshot(); return JSON.stringify([s.selection, s.view, s.sessions[0].draft, s.sessions[0].state, s.sessions[0].prompt.text]); };
      const before = view();
      const { StoreError } = require(path.join(L.candidate, 'server/lib/eink/store'));
      // State document cannot be written.
      failing = 'state.json';
      assert.throws(() => sys.service.select({ session_id: sid, base_revision: 2 }), StoreError);
      assert.throws(() => sys.service.setView({ digest_page: 4, row_page: 0, draft_page: -1 }), StoreError);
      await assert.rejects(() => sys.evidence.ingest(ev('Stop', { last_assistant_message: 'LOST?' })), StoreError);
      assert.equal(view(), before, 'selection, view and digest state are unchanged in memory when the write failed');
      assert.equal(events, 0, 'nothing was announced to the devices');
      // Draft document cannot be written.
      failing = 'drafts.json';
      assert.throws(() => sys.service.putDraft({ session_id: sid, text: 'NOT SAVED', revision: 2 }), /cannot write drafts\.json/);
      assert.equal(view(), before);
      // Command journal cannot be written: nothing is sent and success is not claimed.
      failing = 'commands.jsonl';
      await assert.rejects(() => sys.service.submit({ session_id: sid, selection_revision: 2, draft_revision: 1, idempotency_id: 'persist-submit-1' }), /cannot append to commands\.jsonl/);
      assert.deepEqual(tm.sent(), [], 'no delivery without a durable journal entry');
      assert.equal(sys.service.drafts()[sid].text, 'saved draft', 'the draft is still there');
      // The offline spool keeps an event that could not be applied.
      failing = 'state.json';
      const spoolFile = path.join(home, 'eink', 'spool', '000000000000009-1-abcdef.json');
      real.writeFileSync(spoolFile, JSON.stringify(ev('Stop', { last_assistant_message: 'kept in spool', n: 2 })));
      await assert.rejects(() => sys.evidence.drainSpool(), StoreError);
      assert.ok(real.existsSync(spoolFile), 'the event stays in the spool while it cannot be saved');
      failing = null;
      await sys.evidence.drainSpool();
      assert.ok(!real.existsSync(spoolFile));
      assert.deepEqual([sys.service.snapshot().sessions[0].state, sys.service.snapshot().sessions[0].message.text], ['done', 'kept in spool'], 'applied once the disk works');
      // After recovery the same commands succeed.
      assert.equal((await sys.service.submit({ session_id: sid, selection_revision: 2, draft_revision: 1, idempotency_id: 'persist-submit-1' })).status, 200);
      assert.equal(tm.sent().filter((q) => q.type === 'paste').length, 1);
      // A corrupt state file is never read as an empty state.
      real.writeFileSync(path.join(home, 'eink', 'state.json'), '{"selection": {"session_id": "s_', 'utf8');
      assert.throws(() => mk(), /state\.json is corrupt .*refusing to continue with an empty state/);
      delete process.env.FAKE_TMUX_DIR;
      // Through the real server: a corrupt state file makes the API say so, with 503, instead of serving an empty list.
      const srv = await L.startServer({ home, env: tm.env });
      const r = await L.http('GET', `${srv.api}/snapshot`, { token: 'anything' });
      assert.equal(r.status, 503);
      assert.match(r.data.error, /e-ink service not started: state\.json is corrupt/);
      assert.match(srv.readLog(), /\[eink\] NOT STARTED: state\.json is corrupt/);
      assert.equal((await L.http('GET', `${srv.base}/`)).status, 200, 'the rest of Matrix still runs');
      // A corrupt token store fails closed.
      const home2 = L.tmp('tok');
      real.mkdirSync(path.join(home2, 'eink'), { recursive: true });
      real.writeFileSync(path.join(home2, 'eink', 'tokens.json'), 'garbage');
      const srv2 = await L.startServer({ home: home2, env: tm.env });
      const r2 = await L.http('GET', `${srv2.api}/snapshot`, { token: 'mx_device_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      assert.equal(r2.status, 500, 'an unreadable token store never authenticates anyone');
      t.note('EIO on state.json/drafts.json/commands.jsonl: 5 commands fail visibly, memory unchanged, 0 broadcasts, 0 sends; spool keeps the event until the disk works; corrupt state.json → service refuses to start (503 through the real server); corrupt token store → 500, no access');
    },
  };
};
