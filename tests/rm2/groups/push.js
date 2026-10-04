// Push group: the real reducer, evidence ingestion and durable outbox with an
// injected clock; the push provider (and, for one case, the disk) is the only
// double. Worker handlers are executed from the shipped worker source.
module.exports = (L) => {
  const { assert, fs, path } = L;
  const vm = require('vm');
  const sub = (n) => ({ endpoint: `https://push.example.test/send/device-${n}`, keys: { p256dh: 'k', auth: 'a' } });

  function system({ home = L.tmp('push'), sender, vapid = true, fsImpl } = {}) {
    const tm = L.fakeTmux();
    const pane = tm.pane({});
    tm.setPanes([pane]);
    process.env.FAKE_TMUX_DIR = tm.dir;
    const clock = { now: 5_000_000 };
    const sent = [];
    const send = sender || (async (s, payload) => { sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload), raw: payload }); });
    const { build } = require(path.join(L.candidate, 'server/lib/eink'));
    const mk = () => build({ home, now: () => clock.now, tmuxBin: tm.bin, sendPush: (s, p) => send(s, p, sent), vapidReady: () => vapid, transcriptRoot: home, fs: fsImpl });
    let sys = mk();
    let n = 0;
    const api = {
      tm, pane, clock, sent, home, sid: L.sessionId(pane),
      get sys() { return sys; },
      restart: async () => { sys = mk(); await sys.evidence.collect(); },
      raw: (name, extra = {}) => ({ v: 1, event_id: extra.event_id || `push-evt-${++n}`, seq: clock.now + (++n) / 1000, hook_event_name: name, session_id: extra.conv || 'conv-push-00001', cwd: home, pane: { server_pid: pane.pid, pane_id: pane.pane_id }, ...extra }),
      ev: async (name, extra) => { const r = api.raw(name, extra); await sys.evidence.ingest(r); await sys.evidence.queuePump(); return r; },
      pump: async () => { await sys.evidence.tick(); await sys.evidence.queuePump(); },
    };
    return api;
  }
  const question = { questions: [{ question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }] };

  return {
    async all_transitions(t) {
      const x = system();
      await x.sys.evidence.collect();
      x.sys.push.subscribe(sub(1)); x.sys.push.subscribe(sub(2));
      x.sys.service.putDraft({ session_id: x.sid, text: 'DRAFT-SECRET-TEXT', revision: 1 });
      await x.ev('UserPromptSubmit', { prompt: 'PROMPT-SECRET-TEXT' });
      assert.equal(x.sent.length, 0, 'working is not a notification');
      await x.ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: question }); // working → needs_input
      await x.ev('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' });
      await x.ev('Stop', { last_assistant_message: 'MESSAGE-SECRET-TEXT' }); // working → done
      await x.ev('UserPromptSubmit', { prompt: 'again' });
      await x.ev('StopFailure', { error: 'server_error' }); // working → stuck
      const kinds = x.sent.map((s) => `${s.endpoint.slice(-8)}:${s.payload.kind}`).sort();
      assert.deepEqual(kinds, ['device-1:done', 'device-1:needs_input', 'device-1:stuck', 'device-2:done', 'device-2:needs_input', 'device-2:stuck'], 'exactly one notification per transition per subscription');
      const hookToken = x.sys.auth.issueToken('hook').token;
      for (const s of x.sent) {
        assert.equal(s.payload.target, x.sid, 'canonical target = the concrete session id');
        assert.ok(s.payload.event_id && s.payload.tag === s.payload.event_id, 'stable event id and tag');
        assert.match(s.payload.url, /^\/control\/\?session=s_[0-9a-f]{12}$/);
        for (const secret of ['DRAFT-SECRET', 'PROMPT-SECRET', 'MESSAGE-SECRET', hookToken, 'mx_']) assert.ok(!s.raw.includes(secret), `payload must not contain ${secret}`);
        assert.ok(s.payload.title.startsWith('alpha '), 'title names the session');
      }
      assert.equal(new Set(x.sent.map((s) => s.payload.event_id)).size, 3, 'three distinct transition ids');
      delete process.env.FAKE_TMUX_DIR;
      t.note('3 transitions × 2 subscriptions = 6 deliveries, 3 distinct event ids; no draft/prompt/message/token text in any payload');
    },

    async durable_dedup(t) {
      const x = system();
      await x.sys.evidence.collect();
      x.sys.push.subscribe(sub(1)); x.sys.push.subscribe(sub(2));
      const e1 = await x.ev('UserPromptSubmit', { prompt: 'same prompt' });
      const e2 = await x.ev('Stop', { last_assistant_message: 'same answer' });
      assert.equal(x.sent.length, 2);
      const count = () => x.sent.length;
      // Duplicate hook deliveries.
      for (const e of [e1, e2, e2, e1]) { await x.sys.evidence.ingest(e); await x.sys.evidence.queuePump(); }
      assert.equal(count(), 2, 'duplicate hooks');
      // Repeated polls, with time passing.
      for (let i = 0; i < 5; i++) { x.clock.now += 60000; await x.pump(); }
      assert.equal(count(), 2, 'repeated polls');
      // Display clients connecting and reconnecting.
      for (let i = 0; i < 3; i++) { const drop = x.sys.service.addClient(() => {}); x.sys.service.snapshot(x.sys.push.health); drop(); }
      await x.pump();
      assert.equal(count(), 2, 'client reconnects');
      // Transcript replay: the spool re-delivers the same events after a restart.
      const spool = path.join(x.home, 'eink', 'spool');
      await x.restart();
      fs.writeFileSync(path.join(spool, '000000000000001-1-aaaaaa.json'), JSON.stringify(e1));
      fs.writeFileSync(path.join(spool, '000000000000002-1-bbbbbb.json'), JSON.stringify(e2));
      await x.pump(); await x.pump();
      assert.equal(count(), 2, 'restart with the same persisted state + replayed events');
      assert.deepEqual(fs.readdirSync(spool), [], 'replayed spool events were consumed');
      // A genuinely new turn with identical text notifies again.
      x.clock.now += 1000;
      await x.ev('UserPromptSubmit', { prompt: 'same prompt' });
      await x.ev('Stop', { last_assistant_message: 'same answer' });
      assert.equal(count(), 4, 'a new turn with the same text is a new event');
      const ids = x.sent.map((s) => s.payload.event_id);
      assert.notEqual(ids[0], ids[2]);
      delete process.env.FAKE_TMUX_DIR;

      // The legacy phone alert path has its own subscriber list: a Control subscriber is never on it.
      const tm = L.fakeTmux(); tm.setPanes([tm.pane({})]);
      const srv = await L.startServer({ env: tm.env });
      const ctl = srv.token('controller');
      const r = await L.http('POST', `${srv.api}/push/subscribe`, { token: ctl, body: { subscription: sub(9) } });
      assert.equal(r.status, 200);
      const legacy = await L.http('POST', `${srv.base}/api/notify`, { body: { project: 'alpha', session: 'alpha', message: 'needs input' } });
      assert.ok(legacy.status < 500, `legacy notify still answers (${legacy.status})`);
      const legacyFile = path.join(srv.home, 'push-subscriptions.json');
      const legacySubs = fs.existsSync(legacyFile) ? fs.readFileSync(legacyFile, 'utf8') : '[]';
      assert.ok(!legacySubs.includes('device-9'), 'the Control subscription is not in the legacy list, so a legacy hook cannot double-notify it');
      const outbox = JSON.parse(fs.readFileSync(path.join(srv.home, 'eink', 'outbox.json'), 'utf8'));
      assert.deepEqual([outbox.subscriptions.length, outbox.transitions.length], [1, 0], 'the legacy hook created no Control notification');
      t.note('2 deliveries stayed 2 across 4 duplicate hooks, 5 polls, 3 reconnects, restart + spool replay; identical-text new turn → 2 more with a new id; legacy hook path cannot reach a Control subscriber');
    },

    async failure_health(t) {
      // Missing VAPID and no subscription are visible.
      let x = system({ vapid: false });
      await x.sys.evidence.collect();
      let h = x.sys.push.health();
      assert.equal(h.ok, false);
      assert.match(h.detail, /VAPID keys are not configured/);
      assert.match(h.detail, /no device has enabled notifications/);
      x.sys.push.subscribe(sub(1));
      await x.ev('UserPromptSubmit', { prompt: 'p' }); await x.ev('Stop', { last_assistant_message: 'm' });
      assert.equal(x.sent.length, 0, 'nothing is sent, and nothing is claimed sent, without VAPID');
      assert.equal(x.sys.push.health().pending, 1);
      assert.equal(x.sys.service.snapshot(x.sys.push.health).notifications.ok, false, 'the snapshot carries the notification problem to the devices');

      // Provider 500: bounded retry with a stable tag, visible while failing.
      const calls = [];
      let mode = 'fail';
      x = system({ sender: async (s, payload) => { calls.push({ endpoint: s.endpoint, payload: JSON.parse(payload) }); if (mode === 'fail' && s.endpoint.endsWith('-1')) { const e = new Error('provider said 500'); e.statusCode = 500; throw e; } if (s.endpoint.endsWith('-3')) { const e = new Error('gone'); e.statusCode = 410; throw e; } if (s.endpoint.endsWith('-4')) { const e = new Error('not found'); e.statusCode = 404; throw e; } } });
      await x.sys.evidence.collect();
      x.sys.push.subscribe(sub(1)); x.sys.push.subscribe(sub(2)); x.sys.push.subscribe(sub(3)); x.sys.push.subscribe(sub(4));
      await x.ev('UserPromptSubmit', { prompt: 'p' }); await x.ev('Stop', { last_assistant_message: 'm' });
      const by = (n) => calls.filter((c) => c.endpoint.endsWith(`-${n}`));
      assert.deepEqual([by(1).length, by(2).length, by(3).length, by(4).length], [1, 1, 1, 1]);
      h = x.sys.push.health();
      // Expired subscriptions: HTTP 410 (device 3) and HTTP 404 (device 4) are each pruned; nothing else is.
      const left = x.sys.push._doc().subscriptions.map((q) => q.sub.endpoint.slice(-8)).sort();
      assert.deepEqual(left, ['device-1', 'device-2'], 'exactly the 404 and the 410 subscription were pruned');
      const dropped = x.sys.push._doc().transitions[0].deliveries.filter((q) => q.status === 'dropped');
      assert.equal(dropped.length, 2, 'the 404 and the 410 delivery are recorded as dropped, never as delivered');
      assert.match(h.detail, /expired \(HTTP (404|410)\) and was removed; re-enable notifications on that device/, 'the expired subscription stays visible in health');
      assert.equal(by(2).filter((c) => c.payload.kind === 'done').length, 1, 'the healthy subscription received its transition exactly once');
      assert.equal(h.subscriptions, 2);
      assert.equal(h.ok, false);
      assert.equal(h.pending, 1, 'the failed delivery is scheduled, not dropped and not claimed');
      await x.pump();
      assert.equal(by(1).length, 1, 'no retry before the backoff elapses');
      x.clock.now += 5000; await x.pump();
      x.clock.now += 30000; await x.pump();
      x.clock.now += 120000; await x.pump();
      x.clock.now += 120000; await x.pump();
      assert.equal(by(1).length, 4, 'retries are bounded (4 attempts)');
      assert.equal(new Set(by(1).map((c) => c.payload.tag)).size, 1, 'every retry carries the same notification tag, so a late duplicate replaces rather than stacks');
      h = x.sys.push.health();
      assert.deepEqual([h.failed, h.pending], [1, 0]);
      assert.match(h.detail, /failed permanently/);
      assert.equal(by(2).length, 1, 'the healthy subscription got exactly one');
      // A transient failure that recovers delivers exactly once.
      mode = 'fail';
      await x.ev('UserPromptSubmit', { prompt: 'p2' }); await x.ev('StopFailure', { error: 'overloaded' });
      mode = 'ok'; x.clock.now += 5000; await x.pump(); x.clock.now += 600000; await x.pump();
      assert.equal(by(1).filter((c) => c.payload.kind === 'stuck').length, 2, 'one failed attempt then one success');
      assert.equal(by(2).filter((c) => c.payload.kind === 'stuck').length, 1);

      // Disk write failure: the notification is not claimed, the problem is visible, and it goes out once the disk works.
      const real = require('fs');
      let broken = false;
      const fsImpl = new Proxy(real, { get(target, prop) {
        if (prop === 'openSync') return (file, ...rest) => { if (broken && String(file).includes('outbox.json')) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return target.openSync(file, ...rest); };
        return target[prop];
      } });
      x = system({ fsImpl });
      await x.sys.evidence.collect();
      x.sys.push.subscribe(sub(1));
      broken = true;
      await x.ev('UserPromptSubmit', { prompt: 'p' }); await x.ev('Stop', { last_assistant_message: 'm' });
      assert.equal(x.sent.length, 0, 'no delivery is attempted for a transition that could not be made durable');
      h = x.sys.push.health();
      assert.equal(h.ok, false);
      assert.match(h.detail, /cannot save 1 notification\(s\) to disk: .*ENOSPC/);
      assert.equal(JSON.parse(real.readFileSync(path.join(x.home, 'eink', 'outbox.json'), 'utf8')).transitions.length, 0, 'the outbox on disk does not claim it');
      broken = false;
      await x.pump();
      assert.equal(x.sent.length, 1, 'delivered once after the disk recovered');
      assert.ok(!/cannot save/.test(x.sys.push.health().detail));
      delete process.env.FAKE_TMUX_DIR;
      t.note('no VAPID / no subscription visible; 500 → 4 bounded attempts with one tag then "failed permanently"; 404 and 410 each pruned only their own subscription, health keeps saying so; recovery delivers once; ENOSPC on outbox → not claimed, visible, delivered after recovery');
    },

    async click_routing(t) {
      // Executes the shipped worker sources with a double for the browser's worker runtime.
      function worker(file, scope, windows) {
        const handlers = {}; const shown = []; const opened = []; const posted = []; const focused = [];
        const self = {
          addEventListener: (n, fn) => { handlers[n] = fn; }, skipWaiting() {}, location: new URL('http://matrix.test/'),
          registration: { scope, showNotification: async (title, o) => { shown.push({ title, ...o }); } },
          clients: { claim: async () => {}, matchAll: async () => windows.map((url) => ({ url, focus: async function focus() { focused.push(url); return this; }, postMessage: (m) => posted.push({ url, m }) })), openWindow: async (u) => { opened.push(String(u)); } },
        };
        self.clients.matchAll = self.clients.matchAll.bind(self.clients);
        vm.runInNewContext(fs.readFileSync(path.join(L.candidate, 'server/public', file), 'utf8'), { self, clients: self.clients, caches: { keys: async () => [] }, URL, fetch: () => {}, Promise, console });
        const fire = async (name, ev) => { let p; handlers[name]({ ...ev, waitUntil: (q) => { p = q; } }); await p; };
        return { fire, shown, opened, posted, focused };
      }
      const payload = { title: 'alpha needs your input', body: 'Open Control to answer.', tag: 'ev-1', event_id: 'ev-1', kind: 'needs_input', target: 's_0123456789ab', url: '/control/?session=s_0123456789ab' };
      // Control worker: push shows one notification carrying the target.
      let w = worker('control/sw.js', 'http://matrix.test/control/', []);
      await w.fire('push', { data: { json: () => payload } });
      assert.deepEqual(w.shown.map((s) => [s.title, s.tag, s.data.target]), [['alpha needs your input', 'ev-1', 's_0123456789ab']]);
      // Click with no window: open Control on that session.
      await w.fire('notificationclick', { notification: { close() {}, data: w.shown[0].data } });
      assert.deepEqual(w.opened, ['http://matrix.test/control/?session=s_0123456789ab']);
      // Click with a phone window and a Control window open: only the Control window is used.
      w = worker('control/sw.js', 'http://matrix.test/control/', ['http://matrix.test/', 'http://matrix.test/control/']);
      await w.fire('notificationclick', { notification: { close() {}, data: { target: 's_0123456789ab' } } });
      assert.deepEqual([w.focused, w.opened, w.posted], [['http://matrix.test/control/'], [], [{ url: 'http://matrix.test/control/', m: { type: 'control-open-session', target: 's_0123456789ab' } }]]);
      // Click with only a phone window open: Control opens its own window, it does not hijack the phone view.
      w = worker('control/sw.js', 'http://matrix.test/control/', ['http://matrix.test/']);
      await w.fire('notificationclick', { notification: { close() {}, data: { target: 's_0123456789ab' } } });
      assert.deepEqual([w.focused, w.opened], [[], ['http://matrix.test/control/?session=s_0123456789ab']]);
      // Legacy phone worker: its notification still opens the phone view, even when Control is the only open window.
      w = worker('sw.js', 'http://matrix.test/', ['http://matrix.test/control/']);
      await w.fire('notificationclick', { notification: { close() {}, data: { targetSession: 'tmux-7', project: 'p' } } });
      assert.deepEqual([w.focused, w.posted, w.opened], [[], [], ['/?open=tmux-7']], 'legacy alert opens the phone view and never talks to Control');
      w = worker('sw.js', 'http://matrix.test/', ['http://matrix.test/control/', 'http://matrix.test/']);
      await w.fire('notificationclick', { notification: { close() {}, data: { targetSession: 'tmux-7', project: 'p' } } });
      assert.deepEqual(w.focused, ['http://matrix.test/'], 'legacy alert focuses the phone window');

      // Real page routing in WebKit.
      const tm = L.fakeTmux();
      const panes = [tm.pane({ session_id: '$1', session_name: 'one', pane_id: '%1' }), tm.pane({ session_id: '$2', session_name: 'two', pane_id: '%2' })];
      tm.setPanes(panes);
      const srv = await L.startServer({ env: tm.env });
      const [a, b] = panes.map(L.sessionId);
      const page = await L.openControl(srv);
      const selected = () => page.evaluate(() => { const li = document.querySelector('#sessions li[aria-selected="true"]'); return li ? li.dataset.session : ''; });
      // No window open → the worker opens this URL: the page selects that exact session.
      await page.goto(`${srv.base}/control/?session=${b}`);
      await L.until(async () => (await selected()) === b, 5000, 'deep link selects the session');
      assert.ok(!page.url().includes('session='), 'the target is consumed from the URL');
      // Existing window → the worker posts a message.
      await page.evaluate((target) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'control-open-session', target } })), a);
      await L.until(async () => (await selected()) === a, 3000, 'message selects the session');
      // A target that no longer exists is reported, and nothing similar is opened instead.
      await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'control-open-session', target: 's_ffffffffffff' } })));
      await page.waitForFunction(() => /missing/.test(document.getElementById('notice').textContent));
      assert.equal(await selected(), a, 'selection unchanged for a missing target');
      t.note('control worker: push→1 notification; click→open /control/?session=ID (no window) or focus+message (Control window), never the phone window; legacy worker never targets Control; real page: deep link, message and missing target handled');
    },
  };
};
