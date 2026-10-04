// Recovery group: connection loss, resync, draft persistence, the command
// journal under crashes, and tmux session survival.
module.exports = (L) => {
  const { assert, fs, path } = L;
  const W = 1404; const H = 1872;
  const cfg = { typing_coalesce_ms: 100, clean_after_partials: 100, quiet_ms: 3000 };
  const none = { available: true, reason: '', note: '', entries: [] };
  const sess = (id, o = {}) => ({ id, label: id, present: true, state: 'working', state_reason: '', prompt: { available: true, text: `prompt ${id}`, reason: '' }, message: { available: true, text: `message ${id}`, reason: '' }, question: { pending: false, id: '', kind: '', text: '', options: [], choices_available: false, reason: '' }, files: { tool: none, worktree: none }, draft: { text: '', revision: 0, status: '' }, ...o });
  const snapshot = (epoch, rev, sel = 'A', sessions = [sess('A'), sess('B')]) => ({ protocol: 1, epoch, revision: rev, collector: { ok: true, error: '' }, selection: { session_id: sel, revision: rev }, view: { digest_page: 0, row_page: 0, draft_page: -1 }, sessions });
  const msg = (type, raw, at) => ({ op: 'net', net: 'message', type, raw, at_ms: at });
  const snapMsg = (epoch, rev, at, sel, sessions) => msg('snapshot', { protocol: 1, epoch, revision: rev, snapshot: snapshot(epoch, rev, sel, sessions) }, at);
  const run = (steps) => L.script({ screen: [W, H], initial: { snapshot: snapshot('e1', 1) }, config: cfg, steps, conn: { Status: 'connecting', Endpoint: 'lan' } });

  return {
    async stale_and_reconnect(t) {
      const out = run([
        { op: 'net', net: 'connecting', text: 'lan', at_ms: 10 },
        snapMsg('e1', 5, 100), // 1
        msg('heartbeat', { protocol: 1, epoch: 'e1', revision: 5 }, 2000), // 2: last valid message
        { op: 'tick', at_ms: 7999 }, // 3: 5999ms of silence, connection not closed
        { op: 'tick', at_ms: 8000 }, // 4: 6000ms
        { op: 'tick', at_ms: 60000 }, // 5: still silent
        { op: 'net', net: 'connecting', text: 'lan', at_ms: 60100 }, // 6
        snapMsg('e1', 6, 60200), // 7
        { op: 'net', net: 'closed', text: 'connection reset by peer', at_ms: 61000 }, // 8
        { op: 'net', net: 'connecting', text: 'travel', at_ms: 62000 }, // 9: reconnect attempt
        msg('heartbeat', { protocol: 1, epoch: 'e1', revision: 6 }, 62100), // 10: transport is up, no snapshot yet
        msg('session', { protocol: 1, epoch: 'e1', revision: 7, session: sess('A', { state: 'done' }) }, 62150), // 11: delta before snapshot
        snapMsg('e1', 7, 62200), // 12
      ]);
      const s = out.steps;
      assert.equal(s[1].conn, 'fresh');
      assert.equal(s[3].conn, 'fresh', 'still fresh at 5999ms without a heartbeat');
      assert.equal(s[4].conn, 'stale', 'stale at 6000ms without a heartbeat, with the connection still open');
      assert.ok(s[4].refreshes.length === 1 && s[4].refreshes[0].region === 'status', 'only the status region repaints');
      assert.match(s[4].visible_text.status, /STALE — last confirmed t\+2000ms/, 'the last confirmed time is shown');
      assert.ok(s[4].visible_text.digest.includes('message A'), 'stale content is retained');
      assert.deepEqual(s[5].refreshes, [], 'no ticking age counter');
      assert.equal(s[6].conn, 'stale', 'a reconnect attempt alone does not clear stale');
      assert.equal(s[7].conn, 'fresh', 'a full valid snapshot does');
      assert.equal(s[8].conn, 'disconnected', 'transport close is shown immediately, in the same step');
      assert.match(s[8].visible_text.status, /DISCONNECTED/);
      assert.equal(s[9].conn, 'disconnected');
      assert.equal(s[10].conn, 'disconnected', 'a heartbeat on the new connection is not enough');
      assert.equal(s[11].conn, 'disconnected');
      assert.equal(s[11].states.A, 'working', 'a delta before the snapshot is not applied');
      assert.equal(s[12].conn, 'fresh');
      assert.match(s[12].visible_text.status, /LIVE · travel/, 'the status names the endpoint in use');

      // Real transport: Matrix goes away and comes back; the client recovers by itself within 35s.
      const tm = L.fakeTmux(); tm.setPanes([tm.pane({})]);
      const srv = await L.startServer({ env: tm.env, tls: true });
      const client = await L.startClient({ endpoints: [srv.endpoint()], token: srv.token('device') });
      await client.waitDump((d) => d.conn.Status === 'fresh', 10000, 'fresh');
      await srv.stop('SIGKILL');
      const lost = Date.now();
      await client.waitDump((d) => d.conn.Status === 'disconnected', 3000, 'disconnected after the server died');
      const lostMs = Date.now() - lost;
      const d = await client.dump();
      assert.ok(Object.keys(d.states).length === 1, 'the session list is not emptied by the disconnect');
      await L.wait(9000); // several failed attempts: the backoff grows
      const back = await L.startServer({ home: srv.home, env: tm.env, tls: true, port: srv.port, tlsPort: srv.tlsPort });
      const t0 = Date.now();
      await client.waitDump((q) => q.conn.Status === 'fresh', 36000, 'fresh again');
      const ms = Date.now() - t0;
      assert.ok(ms <= 35000, `recovered ${ms}ms after the endpoint returned (limit 35000)`);
      assert.ok(back.port === srv.port);
      t.note(`fake clock: fresh@5999, stale@6000, disconnected at close, fresh only after snapshot; real transport: disconnected ${lostMs}ms after server kill, recovered ${ms}ms after it returned`);
    },

    async epoch_gap(t) {
      const out = run([
        snapMsg('e1', 5, 100), // 0
        msg('session', { protocol: 1, epoch: 'e1', revision: 6, session: sess('A', { state: 'needs_input' }) }, 200), // 1 applied
        msg('session', { protocol: 1, epoch: 'e1', revision: 8, session: sess('A', { state: 'done' }) }, 300), // 2 gap (7 lost)
        msg('session', { protocol: 1, epoch: 'e1', revision: 9, session: sess('B', { state: 'stuck' }) }, 310), // 3 arrives before the resync snapshot
        snapMsg('e1', 9, 400, 'B', [sess('A', { state: 'done' }), sess('B', { state: 'stuck' })]), // 4 resynced
        msg('session', { protocol: 1, epoch: 'e1', revision: 7, session: sess('A', { state: 'working' }) }, 500), // 5 late old message
        msg('selection', { protocol: 1, epoch: 'e1', revision: 8, selection: { session_id: 'A', revision: 2 } }, 510), // 6 late old selection
        snapMsg('e1', 3, 520, 'A'), // 7 an older snapshot
        msg('draft', { protocol: 1, epoch: 'e1', revision: 10, session_id: 'B', draft: { text: 'typed', revision: 4, status: 'unsent' } }, 600), // 8 in order
        msg('draft', { protocol: 1, epoch: 'e1', revision: 10, session_id: 'B', draft: { text: 'DUPLICATE', revision: 5, status: 'unsent' } }, 610), // 9 duplicate revision
        msg('heartbeat', { protocol: 1, epoch: 'e2', revision: 1 }, 700), // 10 the server restarted
        msg('session', { protocol: 1, epoch: 'e2', revision: 2, session: sess('A', { state: 'stuck' }) }, 710), // 11 new-epoch delta before snapshot
        snapMsg('e2', 2, 800, 'A', [sess('A', { state: 'working' })]), // 12
        msg('session', { protocol: 1, epoch: 'e1', revision: 11, session: sess('A', { state: 'done' }) }, 900), // 13 old epoch
        msg('heartbeat', { protocol: 2, epoch: 'e2', revision: 2 }, 1000), // 14 wrong protocol
      ]);
      const s = out.steps;
      assert.equal(s[1].states.A, 'needs_input');
      assert.deepEqual([s[2].resync, s[2].states.A], [true, 'needs_input'], 'a revision gap forces a resync and is not applied');
      assert.equal(s[3].states.B, 'working', 'nothing is applied between the gap and the new snapshot');
      assert.deepEqual([s[4].states.A, s[4].states.B, s[4].conn], ['done', 'stuck', 'fresh']);
      assert.deepEqual([s[5].resync, s[5].states.A], [false, 'done'], 'an old message is ignored');
      assert.ok(s[6].visible_text['row:B'].startsWith('> '), 'an old selection does not replace the newer one');
      assert.ok(s[7].visible_text['row:B'].startsWith('> ') && s[7].states.B === 'stuck', 'an older snapshot does not replace newer state');
      assert.equal(s[8].visible_text.typed, 'typed');
      assert.equal(s[9].visible_text.typed, 'typed', 'a duplicate revision is ignored');
      assert.equal(s[10].resync, true, 'a new epoch forces a resync');
      assert.equal(s[11].states.A, 'done', 'new-epoch deltas wait for the snapshot');
      assert.deepEqual([s[12].states, s[12].conn], [{ A: 'working' }, 'fresh']);
      assert.equal(s[13].states.A, 'working', 'a message from the old epoch is ignored');
      assert.equal(s[14].conn, 'error');
      assert.match(s[14].visible_text.status, /ERROR: Matrix speaks protocol 2; this client understands 1/);
      assert.match(s[14].sync_error, /protocol 2 not supported/);
      t.note('gap → resync; 2 old deltas, 1 old selection, 1 older snapshot, 1 duplicate, 1 old-epoch message all ignored; epoch change → resync; wrong protocol → explicit error on screen');
    },

    async draft_persistence(t) {
      const tm = L.fakeTmux();
      const panes = [tm.pane({ session_id: '$1', session_name: 'one', pane_id: '%1' }), tm.pane({ session_id: '$2', session_name: 'two', pane_id: '%2' })];
      tm.setPanes(panes);
      const [a, b] = panes.map(L.sessionId);
      let srv = await L.startServer({ env: tm.env, tls: true });
      const client = await L.startClient({ endpoints: [srv.endpoint()], token: srv.token('device') });
      const page = await L.openControl(srv);
      const ctl = srv.token('controller');
      await L.http('POST', `${srv.api}/select`, { token: ctl, body: { session_id: a, base_revision: 1 } });
      await page.waitForFunction(() => !document.getElementById('draft').disabled);
      await page.locator('#draft').click();
      await page.keyboard.type('first half');
      await client.waitDump((d) => d.visible.typed === 'first half', 3000, 'RM echo');
      // The connection drops while composing.
      await srv.stop('SIGKILL');
      await page.waitForFunction(() => /DISCONNECTED/.test(document.getElementById('conn').textContent), null, { timeout: 8000 });
      await page.keyboard.type(' — second half ✓\nline 2');
      const full = 'first half — second half ✓\nline 2';
      assert.equal(await page.inputValue('#draft'), full);
      await page.waitForFunction(() => /NOT SENT — offline, kept on this device/.test(document.getElementById('draft-status').textContent));
      assert.equal(await page.isDisabled('#submit'), true, 'send is disabled while disconnected');
      await page.keyboard.press('Meta+Enter');
      // Selecting another row while offline neither submits nor loses the draft.
      await page.click(`#sessions li[data-session="${b}"]`);
      await page.waitForFunction(() => /Cannot select: disconnected/.test(document.getElementById('notice').textContent));
      assert.equal(await page.inputValue('#draft'), full);
      const mid = await client.dump();
      assert.equal(mid.conn.Status, 'disconnected');
      assert.equal(mid.visible.typed, 'first half', 'the RM keeps the last confirmed draft, marked not live');
      // Matrix restarts; the browser is reloaded.
      srv = await L.startServer({ home: srv.home, env: tm.env, tls: true, port: srv.port, tlsPort: srv.tlsPort });
      const mark = client.refreshes.length;
      await page.reload();
      await page.waitForFunction(() => document.getElementById('conn').textContent === 'Live', null, { timeout: 15000 });
      await page.waitForFunction((want) => document.getElementById('draft').value === want, full);
      const snap = await L.until(async () => { const d = (await L.http('GET', `${srv.api}/snapshot`, { token: srv.token('controller') })).data; return d.sessions.find((q) => q.id === a).draft.text === full ? d : null; }, 8000, 'the exact draft to reach the Mac after reconnect');
      assert.equal(snap.sessions.find((q) => q.id === a).draft.status, 'unsent', 'visibly unsent');
      assert.equal(snap.selection.session_id, a);
      assert.match(await page.textContent('#draft-status'), /not sent/);
      assert.deepEqual(tm.sent(), [], 'reconnect, reload, restart and selection never submit');
      await client.waitDump((d) => d.conn.Status === 'fresh' && d.visible.typed === full, 36000, 'RM shows the exact draft after reconnect');
      const after = client.refreshes.slice(mark);
      const regionOf = (r) => (r.rect[1] + r.rect[3] <= 64 ? 'status' : r.rect[1] >= 1516 ? 'typed' : 'other');
      assert.ok(after.length >= 2 && after.every((r) => r.mode === 'partial' && regionOf(r) !== 'other'), `after reconnect only status and the draft strip were repainted: ${JSON.stringify(after.map((r) => [r.mode, regionOf(r)]))}`);
      // A restarted Matrix answers nothing until it has asked tmux once: a client that reconnects at
      // once is never shown an empty session list (which would blank and repaint every row).
      await srv.stop('SIGKILL');
      tm.hold('list-panes');
      const running = () => srv.readLog().split('Matrix running').length;
      const startsBefore = running();
      srv = await L.startServer({ home: srv.home, env: tm.env, port: srv.port, tlsPort: srv.tlsPort, waitReady: false });
      let early = null;
      const first = L.until(() => L.http('GET', `${srv.api}/snapshot`, { token: ctl }), 15000, 'the restarted server to answer').then((r) => { early = r; return r; });
      await L.until(() => tm.held() === 1 && running() > startsBefore, 4000, 'the restarted server to listen while its first collection is blocked');
      await L.wait(300);
      assert.equal(early, null, 'no snapshot is served before the first session collection');
      tm.release();
      const firstSnap = (await first).data;
      assert.deepEqual([firstSnap.collector.ok, firstSnap.sessions.length, firstSnap.selection.session_id], [true, 2, a], 'the first snapshot after a restart already lists the sessions and the selection');
      t.note(`draft of ${full.length} chars typed half offline: kept in the browser across disconnect/selection attempt/reload/server restart, then exact on Mac and RM; 0 sends; RM repainted only status+typed (${after.length} partials)`);
    },

    async uncertain_delivery(t) {
      // (1) Disk failure between "pending" and "sending": definitely not sent.
      const real = require('fs');
      let breakAfter = -1; let appends = 0;
      const fsImpl = new Proxy(real, { get(target, prop) {
        if (prop === 'openSync') return (file, flags, ...rest) => { if (String(file).endsWith('commands.jsonl') && flags === 'a') { appends += 1; if (breakAfter >= 0 && appends > breakAfter) { const e = new Error('EIO: disk failed'); e.code = 'EIO'; throw e; } } return target.openSync(file, flags, ...rest); };
        return target[prop];
      } });
      const tm0 = L.fakeTmux(); const pane0 = tm0.pane({}); tm0.setPanes([pane0]);
      process.env.FAKE_TMUX_DIR = tm0.dir;
      const home0 = L.tmp('journal');
      const { build } = require(path.join(L.candidate, 'server/lib/eink'));
      const mk = () => build({ home: home0, tmuxBin: tm0.bin, sendPush: async () => {}, vapidReady: () => true, transcriptRoot: home0, fs: fsImpl });
      let sys = mk();
      await sys.evidence.collect();
      const sid0 = L.sessionId(pane0);
      await sys.evidence.ingest({ v: 1, event_id: 'unc-evt-0001', seq: 1, hook_event_name: 'UserPromptSubmit', session_id: 'conv-unc-00001', prompt: 'p', cwd: home0, pane: { server_pid: pane0.pid, pane_id: pane0.pane_id } });
      sys.service.select({ session_id: sid0, base_revision: 1 });
      sys.service.putDraft({ session_id: sid0, text: 'never sent', revision: 1 });
      breakAfter = 1; // "pending" is written, "sending" fails
      await assert.rejects(() => sys.service.submit({ session_id: sid0, selection_revision: 2, draft_revision: 1, idempotency_id: 'crash-before-0001' }), /cannot append/);
      assert.deepEqual(tm0.sent(), [], 'nothing reached tmux');
      breakAfter = -1;
      sys = mk(); // restart
      await sys.evidence.collect();
      assert.equal(sys.service.journal.get('crash-before-0001').state, 'unsent', 'restart classifies a pending-only command as unsent');
      assert.equal(sys.service.drafts()[sid0].text, 'never sent', 'the draft is retained');
      await L.wait(50); await sys.evidence.tick();
      assert.deepEqual(tm0.sent(), [], 'an unsent command is not sent on its own after restart');
      const again = await sys.service.submit({ session_id: sid0, selection_revision: 2, draft_revision: 1, idempotency_id: 'crash-before-0001' });
      assert.equal(again.status, 200, 'the user can send it again explicitly');
      assert.equal(tm0.sent().filter((s) => s.type === 'paste').length, 1);
      delete process.env.FAKE_TMUX_DIR;

      // (2) The server dies after the text reached the pane but before the acknowledgement.
      const tm = L.fakeTmux(); const pane = tm.pane({}); tm.setPanes([pane]);
      const sid = L.sessionId(pane);
      let srv = await L.startServer({ env: tm.env });
      L.hookToken(srv);
      L.hook(srv, pane, { session_id: 'conv-unc-00002', hook_event_name: 'UserPromptSubmit', prompt: 'p' });
      let ctl = srv.token('controller');
      await L.http('POST', `${srv.api}/select`, { token: ctl, body: { session_id: sid, base_revision: 1 } });
      await L.http('PUT', `${srv.api}/draft`, { token: ctl, body: { session_id: sid, text: 'sent once', revision: 1 } });
      tm.set('kill.json', { command: 'send-keys', when: 'after' });
      const died = await L.http('POST', `${srv.api}/submit`, { token: ctl, body: { session_id: sid, selection_revision: 2, draft_revision: 1, idempotency_id: 'crash-after-send1' } }).then((r) => r.status, () => 'connection lost');
      assert.equal(died, 'connection lost', 'the server crashed mid-command');
      await L.until(() => srv.exited(), 3000, 'server exit');
      tm.set('kill.json', null);
      assert.deepEqual(tm.sent().map((s) => s.type), ['paste', 'key'], 'the text and Enter did reach the pane');
      srv = await L.startServer({ home: srv.home, env: tm.env });
      ctl = srv.token('controller');
      const snap = await L.until(async () => { const d = (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data; return d.sessions.length ? d : null; }, 5000, 'snapshot after restart');
      assert.deepEqual([snap.sessions[0].draft.text, snap.sessions[0].draft.status], ['sent once', 'uncertain'], 'the draft is kept and marked delivery-uncertain');
      await L.wait(1200); // several collector cycles
      assert.equal(tm.sent().length, 2, 'an uncertain command is never retransmitted automatically');
      let r = await L.http('POST', `${srv.api}/submit`, { token: ctl, body: { session_id: sid, selection_revision: snap.selection.revision, draft_revision: 1, idempotency_id: 'crash-after-send1' } });
      assert.deepEqual([r.status, r.data.state], [409, 'uncertain'], 'the same command id reports uncertain');
      r = await L.http('POST', `${srv.api}/submit`, { token: ctl, body: { session_id: sid, selection_revision: snap.selection.revision, draft_revision: 1, idempotency_id: 'crash-after-send2' } });
      assert.equal(r.status, 409, 'a new id for the same unedited draft is refused too');
      assert.match(r.data.error, /sent once without confirmation/);
      assert.equal(tm.sent().length, 2, 'still exactly one send');

      // (3) Crash after the acknowledgement: a duplicate returns the original result without sending.
      await L.http('PUT', `${srv.api}/draft`, { token: ctl, body: { session_id: sid, text: 'edited and resent', revision: 2 } });
      r = await L.http('POST', `${srv.api}/submit`, { token: ctl, body: { session_id: sid, selection_revision: snap.selection.revision, draft_revision: 2, idempotency_id: 'crash-after-ack01' } });
      assert.deepEqual([r.status, r.data.state], [200, 'acknowledged']);
      assert.equal(tm.sent().length, 4);
      await srv.stop('SIGKILL');
      srv = await L.startServer({ home: srv.home, env: tm.env });
      ctl = srv.token('controller');
      const s3 = (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data;
      r = await L.http('POST', `${srv.api}/submit`, { token: ctl, body: { session_id: sid, selection_revision: s3.selection.revision, draft_revision: 2, idempotency_id: 'crash-after-ack01' } });
      assert.deepEqual([r.status, r.data.state, r.data.replayed], [200, 'acknowledged', true]);
      assert.equal(tm.sent().length, 4, 'the duplicate acknowledged command caused no extra send');
      // (4) A7-1: a draft edited while its predecessor is being delivered is newer, unsent text. An
      // uncertain outcome belongs to the command that was sent and must not overwrite or mark it.
      const post = (route, body, method = 'POST') => L.http(method, `${srv.api}${route}`, { token: ctl, body });
      const draftNow = async () => (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data.sessions[0].draft;
      const onDisk = () => JSON.parse(fs.readFileSync(path.join(srv.home, 'eink', 'drafts.json'), 'utf8'))[sid];
      const sel = s3.selection.revision;
      const NEW = 'NEW text typed while sending';
      await L.until(async () => (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data.sessions.length === 1, 5000, 'the session list after the restart');
      assert.equal((await post('/draft', { session_id: sid, text: 'original draft', revision: 4 }, 'PUT')).status, 200);
      tm.set('fail.json', { command: 'paste-buffer', message: 'injected: lost connection to tmux mid-send' });
      tm.hold('paste-buffer');
      let before = tm.sent().length;
      const sending = post('/submit', { session_id: sid, selection_revision: sel, draft_revision: 4, idempotency_id: 'edit-uncertain-01' });
      await L.until(() => tm.held() === 1, 3000, 'the delivery to block in tmux paste-buffer');
      assert.equal((await post('/draft', { session_id: sid, text: NEW, revision: 5 }, 'PUT')).status, 200, 'the newer draft is saved during delivery');
      tm.release();
      r = await sending;
      assert.deepEqual([r.status, r.data.state], [502, 'uncertain'], 'the send ended uncertain');
      tm.set('fail.json', null);
      assert.deepEqual(await draftNow(), { text: NEW, revision: 5, status: 'unsent' }, 'the newer draft is exactly as typed, not marked uncertain');
      assert.deepEqual([onDisk().text, onDisk().revision, onDisk().status], [NEW, 5, 'unsent'], 'and so is drafts.json');
      r = await post('/submit', { session_id: sid, selection_revision: sel, draft_revision: 4, idempotency_id: 'edit-uncertain-01' });
      assert.deepEqual([r.status, r.data.state], [409, 'uncertain'], 'the uncertain command is still never replayed');
      assert.equal(tm.sent().length, before, 'nothing was resent');
      await srv.stop('SIGKILL');
      srv = await L.startServer({ home: srv.home, env: tm.env });
      ctl = srv.token('controller');
      await L.until(async () => (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data.sessions.length === 1, 5000, 'snapshot after restart');
      assert.deepEqual(await draftNow(), { text: NEW, revision: 5, status: 'unsent' }, 'the newer draft survives a restart unchanged');
      r = await post('/submit', { session_id: sid, selection_revision: sel, draft_revision: 4, idempotency_id: 'edit-uncertain-01' });
      assert.deepEqual([r.status, r.data.state], [409, 'uncertain'], 'still uncertain after the restart');
      r = await post('/submit', { session_id: sid, selection_revision: sel, draft_revision: 5, idempotency_id: 'edit-newer-00001' });
      assert.equal(r.status, 200, 'the newer draft can be sent as its own command');
      assert.deepEqual(tm.sent().slice(before).map((q) => q.text || q.key), [NEW, 'Enter'], 'and is sent exactly once');
      // The server dies while a send is in flight and a newer draft is already saved.
      assert.equal((await post('/draft', { session_id: sid, text: 'second original', revision: 7 }, 'PUT')).status, 200);
      tm.hold('paste-buffer');
      const lost = post('/submit', { session_id: sid, selection_revision: sel, draft_revision: 7, idempotency_id: 'edit-crash-00001' }).then((q) => q.status, () => 'connection lost');
      await L.until(() => tm.held() === 1, 3000, 'the second delivery to block');
      assert.equal((await post('/draft', { session_id: sid, text: 'typed before the crash', revision: 8 }, 'PUT')).status, 200);
      await srv.stop('SIGKILL');
      assert.equal(await lost, 'connection lost');
      tm.release();
      srv = await L.startServer({ home: srv.home, env: tm.env });
      ctl = srv.token('controller');
      await L.until(async () => (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data.sessions.length === 1, 5000, 'snapshot after the crash');
      assert.deepEqual(await draftNow(), { text: 'typed before the crash', revision: 8, status: 'unsent' }, 'the newer draft is not the one marked uncertain after a crash');
      r = await post('/submit', { session_id: sid, selection_revision: sel, draft_revision: 7, idempotency_id: 'edit-crash-00001' });
      assert.deepEqual([r.status, r.data.state], [409, 'uncertain'], 'the interrupted command is uncertain and not replayed');
      before = tm.sent().length;
      await L.wait(600);
      assert.equal(tm.sent().length, before, 'nothing is sent on its own after the crash');
      const states = fs.readFileSync(path.join(srv.home, 'eink', 'commands.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((q) => `${q.id.slice(-9)}:${q.state}`);
      t.note(`journal: pending-only → unsent (0 sends, resend allowed); killed after send → uncertain (1 send, never retried, dup+new id → 409); acknowledged + restart → replayed 200 (0 extra); draft edited during an uncertain send and during a crash → newer text/revision kept, status unsent, across restart, old id 409 uncertain. Persisted: ${states.join(', ')}`);
    },

    async session_survival(t) {
      const which = L.spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout.trim();
      assert.ok(which, 'a real tmux is required for this case');
      const sock = L.tmp('tmuxsock');
      const shimDir = L.tmp('shim');
      const calls = path.join(shimDir, 'calls.log');
      fs.writeFileSync(path.join(shimDir, 'tmux'), `#!/bin/sh\necho "$@" >> "${calls}"\nexec "${which}" "$@"\n`, { mode: 0o755 });
      const env = { TMUX_TMPDIR: sock, TMUX: '', TMUX_PANE: '', PATH: `${shimDir}:${process.env.PATH}`, MATRIX_TMUX: path.join(shimDir, 'tmux') };
      const direct = (...a) => L.spawnSync(which, a, { encoding: 'utf8', env: { ...process.env, TMUX_TMPDIR: sock, TMUX: '' } });
      try {
        assert.equal(direct('new-session', '-d', '-s', 'survivor', '-x', '120', '-y', '40', 'cat').status, 0);
        const info = direct('list-panes', '-a', '-F', '#{pid} #{session_id} #{session_created} #{pane_id} #{pane_pid} #{window_width}x#{window_height}').stdout.trim().split(' ');
        const [pid, session_id, session_created, pane_id, pane_pid, size] = info;
        const sid = L.sessionId({ pid, session_id, session_created });
        let srv = await L.startServer({ env, tls: true });
        L.hookToken(srv);
        L.hook(srv, { pid, pane_id, pane_current_path: sock }, { session_id: 'conv-survive-01', hook_event_name: 'UserPromptSubmit', prompt: 'p' });
        const client = await L.startClient({ endpoints: [srv.endpoint()], token: srv.token('device') });
        const page = await L.openControl(srv);
        let ctl = srv.token('controller');
        const snap0 = (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data;
        assert.ok(snap0.sessions.some((q) => q.id === sid && q.state === 'working'), 'the real session is listed with its evidence');
        await L.http('POST', `${srv.api}/select`, { token: ctl, body: { session_id: sid, base_revision: snap0.selection.revision } });
        // Both devices drop, Matrix is killed and restarted.
        await client.stop();
        await page.context().close();
        await srv.stop('SIGKILL');
        srv = await L.startServer({ home: srv.home, env, tls: true });
        ctl = srv.token('controller');
        const after = direct('list-panes', '-a', '-F', '#{pid} #{session_id} #{session_created} #{pane_id} #{pane_pid} #{window_width}x#{window_height}').stdout.trim();
        assert.equal(after, info.join(' '), 'the tmux session, its process and its size are untouched');
        assert.equal(size, '120x40');
        assert.equal(L.spawnSync('kill', ['-0', pane_pid]).status, 0, 'the process inside the pane is still alive');
        const snap1 = await L.until(async () => { const d = (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data; return d.sessions.some((q) => q.id === sid && q.present) ? d : null; }, 5000, 'the surviving session to be listed again');
        assert.equal(snap1.sessions.find((q) => q.id === sid).state, 'working', 'same concrete session, state preserved');
        // Real delivery into the surviving pane.
        await L.http('PUT', `${srv.api}/draft`, { token: ctl, body: { session_id: sid, text: 'still here', revision: 1 } });
        const r = await L.http('POST', `${srv.api}/submit`, { token: ctl, body: { session_id: sid, selection_revision: snap1.selection.revision, draft_revision: 1, idempotency_id: 'survive-submit-01' } });
        assert.equal(r.status, 200);
        await L.until(() => direct('capture-pane', '-p', '-t', pane_id).stdout.includes('still here'), 3000, 'the text to appear in the real pane');
        const logged = fs.readFileSync(calls, 'utf8');
        const destructive = logged.split('\n').filter((l) => /^(kill-|resize-|respawn-|detach|new-session|rename|set-option|setw|attach)/.test(l) || /\b(kill-session|kill-server|kill-pane|kill-window|resize-pane|resize-window|refresh-client -C)\b/.test(l));
        assert.deepEqual(destructive, [], 'Matrix issued no destructive or resizing tmux command');
        // The session ends: it is shown as missing, not silently dropped, and cannot receive input.
        direct('kill-session', '-t', 'survivor');
        const gone = await L.until(async () => { const d = (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data; const q = d.sessions.find((v) => v.id === sid); return q && !q.present ? d : null; }, 5000, 'the ended session to be marked missing');
        assert.equal(gone.selection.session_id, sid);
        await L.http('PUT', `${srv.api}/draft`, { token: ctl, body: { session_id: sid, text: 'to nobody', revision: 5 } });
        const dead = await L.http('POST', `${srv.api}/submit`, { token: ctl, body: { session_id: sid, selection_revision: gone.selection.revision, draft_revision: 5, idempotency_id: 'survive-submit-02' } });
        assert.ok([409, 410].includes(dead.status), `submit to the ended session is refused (${dead.status})`);
        t.note(`real tmux: session ${sid} survived both devices dropping and a Matrix SIGKILL+restart unchanged (pid, size 120x40); text delivered into the real pane; ${logged.split('\n').filter(Boolean).length} tmux calls, 0 destructive; ended session shown missing and refuses input`);
      } finally {
        direct('kill-server');
      }
    },
  };
};
