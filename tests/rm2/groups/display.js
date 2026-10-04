// Display group: the host build of the production client (same layout,
// rasteriser, scheduler and QTFB encoder as the ARM build). Observations are
// the refresh commands decoded after encoding, and the pixels actually written
// to the framebuffer; pixel checks here are done independently in this file.
module.exports = (L) => {
  const { assert, fs, path } = L;
  const W = 1404; const H = 1872;
  const P = 0x10; const R = 0x11; const U = 0x12; // QTFB touch press / release / update
  const cfg = (o = {}) => ({ typing_coalesce_ms: 100, clean_after_partials: 100, quiet_ms: 3000, ...o });
  const two = { selected: 'A', sessions: [{ id: 'A', state: 'working', prompt: 'Explain the parser', message: 'Previous complete answer' }, { id: 'B', state: 'working', prompt: 'Second session', message: 'Second answer' }] };
  const inside = (r, b) => r[2] > 0 && r[3] > 0 && r[0] >= b[0] && r[1] >= b[1] && r[0] + r[2] <= b[0] + b[2] && r[1] + r[3] <= b[1] + b[3];
  const center = (r) => [Math.floor(r[0] + r[2] / 2), Math.floor(r[1] + r[3] / 2)];
  const tap = (x, y, at, id = 0) => [{ op: 'touch', touch: [P, id, x, y], at_ms: at }, { op: 'touch', touch: [R, id, x, y], at_ms: at + 40 }];

  // Bounding box of pixels that differ between two frames, computed here.
  function changedBox(a, b) {
    let x0 = W; let y0 = H; let x1 = -1; let y1 = -1; let n = 0;
    for (let i = 0; i < a.pix.length; i++) {
      if (a.pix[i] !== b.pix[i]) { const x = i % W; const y = (i - x) / W; n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return n ? { n, rect: [x0, y0, x1 - x0 + 1, y1 - y0 + 1] } : { n: 0, rect: null };
  }

  function sessionObj(id, o = {}) {
    const none = { available: true, reason: '', note: '', entries: [] };
    return { id, label: `session-${id}`, present: true, state: 'working', state_reason: '', prompt: { available: true, text: `prompt ${id}`, reason: '' }, message: { available: true, text: `message ${id}`, reason: '' }, question: { pending: false, id: '', kind: '', text: '', options: [], choices_available: false, reason: '' }, files: { tool: none, worktree: none }, draft: { text: '', revision: 0, status: '' }, ...o };
  }
  const snapshotOf = (sessions, selected, rev = 1) => ({ protocol: 1, epoch: 'e1', revision: rev, collector: { ok: true, error: '' }, selection: { session_id: selected, revision: 1 }, view: { digest_page: 0, row_page: 0, draft_page: -1 }, sessions });

  return {
    async pixels_and_modes(t) {
      const frames = path.join(t.dir, 'frames');
      const steps = [
        { op: 'tick', at_ms: 1 },
        ...[0, 1, 2, 3, 4].map((i) => ({ op: 'stream', session: 'A', text: `tok ${i}`, at_ms: 100 + i * 100 })),
        { op: 'complete_message', session: 'A', text: 'New complete answer', state: 'working', at_ms: 1000 },
        { op: 'state', session: 'B', state: 'needs_input', at_ms: 1200 },
        { op: 'draft', session: 'A', text: 'h', at_ms: 1400 },
        { op: 'draft', session: 'A', text: 'hello wörld', at_ms: 1600 },
        { op: 'tick', at_ms: 4599 },
        { op: 'tick', at_ms: 4601 },
        { op: 'invalid_rect', at_ms: 4700 },
      ];
      const out = L.script({ screen: [W, H], initial: two, config: cfg({ clean_after_partials: 3 }), steps, frames_dir: frames });
      const f = out.steps.map((s) => L.readPGM(s.frame));
      const black = (fr) => { let n = 0; for (const v of fr.pix) if (v === 0) n++; return n; };
      assert.ok(black(f[0]) > 5000, 'the frame holds real rendered ink');
      assert.ok(new Set(f[0].pix).size === 2, 'framebuffer is strictly monochrome');
      const expect = { 6: 'digest', 7: 'row:B', 8: 'typed', 9: 'typed' };
      let checked = 0;
      for (let i = 1; i < steps.length - 1; i++) {
        const diff = changedBox(f[i - 1], f[i]);
        const st = out.steps[i];
        if (expect[i]) {
          const region = out.regions[expect[i]];
          assert.ok(diff.n > 0, `step ${i}: pixels changed`);
          assert.ok(inside(diff.rect, region), `step ${i}: changed pixels ${diff.rect} stay inside ${expect[i]} ${region}`);
          assert.ok(st.refreshes.length >= 1 && st.refreshes.every((r) => r.mode === 'partial' && r.region === expect[i] && inside(r.rect, region)), `step ${i}: only ${expect[i]} refreshed`);
          const union = st.refreshes.map((r) => r.rect);
          assert.ok(union.some((r) => inside(diff.rect, r)), `step ${i}: the refreshed rectangle covers every changed pixel`);
          for (const r of st.refreshes) {
            assert.deepEqual(r.rect, [r.sent_rect[0], r.sent_rect[1], r.sent_rect[2] + 1, r.sent_rect[3] + 1], 'panel rectangle = wire rectangle grown by AppLoad\'s one pixel');
            assert.equal(r.refresh_mode, 1, 'partials use the FAST display mode set through MESSAGE_SET_REFRESH_MODE');
          }
          checked++;
        } else {
          assert.equal(diff.n, 0, `step ${i} (${steps[i].op}): no pixel changed`);
          if (i !== 11) assert.deepEqual(st.refreshes, [], `step ${i} (${steps[i].op}): no refresh`);
        }
      }
      const clean = out.steps[11].refreshes;
      assert.equal(clean.length, 1);
      assert.deepEqual([clean[0].mode, clean[0].region, clean[0].rect], ['clean', 'screen', [0, 0, W, H]], 'clean = the panel full-refresh request, whole screen');
      assert.deepEqual(out.steps[10].refreshes, [], 'no clean before the quiet deadline');
      const bad = out.steps[12];
      assert.match(bad.fatal, /refusing invalid partial rectangle/, 'a null rectangle is refused by the encoder');
      assert.deepEqual(bad.refreshes, [], 'and never becomes a full paint');
      assert.equal(bad.full_paints, 1, 'only the launch full paint happened');
      t.note(`${checked} region-isolation pixel checks; 5 stream steps 0 changed pixels; clean at 4601 not 4599; invalid rect refused`);
    },

    async real_touch(t) {
      const probe = L.script({ screen: [W, H], initial: two, config: cfg(), steps: [] });
      const rb = probe.regions['row:B']; const ra = probe.regions['row:A']; const dg = probe.regions.digest;
      const [bx, by] = center(rb); const [ax, ay] = center(ra); const [dx, dy] = center(dg);
      const frames = path.join(t.dir, 'frames');
      const steps = [
        { op: 'tick', at_ms: 1 },
        ...tap(bx, by, 100), // 1,2: plain tap on row B
        ...tap(dx, dy - 200, 300), // 3,4: tap outside any control
        { op: 'touch', touch: [P, 0, ax, ay], at_ms: 500 }, { op: 'touch', touch: [U, 0, ax, ay + 30], at_ms: 520 }, { op: 'touch', touch: [U, 0, bx, by], at_ms: 540 }, { op: 'touch', touch: [R, 0, bx, by], at_ms: 560 }, // 5-8: drag A → B
        { op: 'touch', touch: [P, 0, bx, by], at_ms: 700 }, { op: 'touch', touch: [P, 1, ax, ay], at_ms: 710 }, { op: 'touch', touch: [R, 1, ax, ay], at_ms: 720 }, { op: 'touch', touch: [R, 0, bx, by], at_ms: 730 }, // 9-12: two fingers
        ...tap(0, rb[1], 900), // 13,14: top-left corner of row B
        ...tap(W - 1, rb[1] + rb[3] - 1, 1000), // 15,16: bottom-right corner of row B
        ...tap(W, by, 1100), // 17,18: one pixel off the screen edge
        ...tap(bx, rb[1] + rb[3] + 1, 1200), // 19,20: the gap below row B
        { op: 'touch', touch: [0x20, 0, bx, by], at_ms: 1300 }, { op: 'touch', touch: [0x21, 0, bx, by], at_ms: 1340 }, // 21,22: pen events are not touch
      ];
      const out = L.script({ screen: [W, H], initial: two, config: cfg(), steps, frames_dir: frames });
      const sel = (i) => (out.steps[i].commands || []).filter((c) => c.Kind === 'select');
      const all = out.steps.flatMap((s) => (s.commands || []).filter((c) => c.Kind === 'select'));
      assert.deepEqual(sel(2), [{ Kind: 'select', SessionID: 'B', SelectionRevision: 1, View: { digest_page: 0, row_page: 0, draft_page: 0 } }].map((c) => ({ ...c, View: sel(2)[0].View })), 'tap on row B selects B exactly once');
      assert.equal(sel(2).length, 1);
      assert.equal(sel(4).length, 0, 'outside tap selects nothing');
      assert.equal(sel(8).length, 0, 'a drag that ends on another row selects nothing');
      assert.equal(sel(11).length + sel(12).length, 0, 'multitouch selects nothing');
      assert.deepEqual(sel(14).map((c) => c.SessionID), ['B'], 'top-left corner pixel of the row hits the row');
      assert.deepEqual(sel(16).map((c) => c.SessionID), ['B'], 'bottom-right corner pixel of the row hits the row');
      assert.equal(sel(18).length, 0, 'a point outside the screen selects nothing');
      assert.equal(sel(20).length, 0, 'the gap between rows selects nothing');
      assert.equal(sel(22).length, 0, 'pen input is not a touch selection');
      assert.equal(all.length, 3, 'exactly three selections in the whole sequence');
      const first = L.readPGM(out.steps[0].frame); const last = L.readPGM(out.steps[out.steps.length - 1].frame);
      assert.equal(changedBox(first, last).n, 0, 'touch draws nothing: no pointer cursor and no optimistic mark');
      assert.ok(out.steps.every((s) => s.refreshes.length === 0), 'touch causes no refresh');
      t.note('9 touch scenarios via QTFB-encoded input: 3 selections (center + both corners), 6 rejections; 0 pixels drawn');
    },

    async pagination(t) {
      const ids = Array.from({ length: 17 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
      const message = Array.from({ length: 150 }, (_, i) => `message-line-${i + 1}`).join('\n');
      const files = Array.from({ length: 30 }, (_, i) => ({ status: 'W', path: `/repo/src/file-${i + 1}.js` }));
      const options = Array.from({ length: 12 }, (_, i) => ({ key: String(i + 1), label: `option-number-${i + 1}` }));
      const draft = Array.from({ length: 40 }, (_, i) => `draft-line-${i + 1}`).join('\n');
      const sessions = ids.map((id) => sessionObj(id));
      sessions[0] = sessionObj('S01', {
        message: { available: true, text: message, reason: '' },
        question: { pending: true, id: 'q', kind: 'question', text: 'Pick one', options, choices_available: true, reason: '' },
        files: { tool: { available: true, reason: '', note: '', entries: files }, worktree: { available: true, reason: '', note: '', entries: [] } },
        draft: { text: draft, revision: 3, status: 'unsent' },
      });
      const initial = { snapshot: snapshotOf(sessions, 'S01') };
      const probe = L.script({ screen: [W, H], initial, config: cfg(), steps: [] });
      const rp = probe.regions.rowpager; const dp = probe.digest_pager; const ty = probe.regions.typed;
      const next = (r) => [r[0] + r[2] - 60, Math.floor(r[1] + r[3] / 2)];
      const prev = (r) => [r[0] + 60, Math.floor(r[1] + r[3] / 2)];
      // Session rows: page forward twice with real taps on the pager.
      let at = 100; const steps = [];
      for (let i = 0; i < 2; i++) { steps.push(...tap(...next(rp), at)); at += 200; }
      // A row state update for a session on another page, then page back.
      steps.push({ op: 'session', raw: sessionObj('S02', { state: 'needs_input' }), at_ms: at }); at += 200;
      const afterRows = steps.length;
      // Digest: page forward until the end.
      for (let i = 0; i < 12; i++) { steps.push(...tap(...next(dp), at)); at += 200; }
      const afterDigest = steps.length;
      // Draft: page backwards through the whole draft (upper half = older).
      for (let i = 0; i < 6; i++) { steps.push(...tap(Math.floor(W / 2), ty[1] + 20, at)); at += 200; }
      // iPad paging: an explicit view event.
      steps.push({ op: 'view', raw: { digest_page: 1, row_page: 0, draft_page: -1 }, at_ms: at });
      const out = L.script({ screen: [W, H], initial, config: cfg(), steps });

      const rowsSeen = new Set(Object.keys(probe.regions).filter((k) => k.startsWith('row:')).map((k) => k.slice(4)));
      const rowSteps = out.steps.slice(0, afterRows);
      rowSteps.forEach((s) => Object.keys(s.visible_text).filter((k) => k.startsWith('row:')).forEach((k) => rowsSeen.add(k.slice(4))));
      assert.deepEqual([...rowsSeen].sort(), ids, 'every one of the 17 session rows is reachable by paging');
      for (const s of rowSteps) for (const r of s.refreshes) assert.ok(r.mode === 'partial' && (/^(row:|slot:)/.test(r.region) || r.region === 'rowpager'), `row paging refreshed only rows/pager, got ${r.region}`);
      assert.deepEqual(rowSteps[rowSteps.length - 1].refreshes, [], 'a state update for a row on another page paints nothing');
      assert.ok(Object.keys(rowSteps[3].visible_text).includes('row:S15'), 'third page shows the last sessions');
      assert.equal(out.steps[afterRows - 1].states.S02, 'needs_input');

      const digestPages = [probe.steps.length ? '' : '', ...out.steps.slice(afterRows, afterDigest).map((s) => s.visible_text.digest)];
      const firstDigest = L.script({ screen: [W, H], initial, config: cfg(), steps: [{ op: 'tick', at_ms: 1 }] }).steps[0].visible_text.digest;
      const allDigest = [firstDigest, ...digestPages].join('\n');
      for (let i = 1; i <= 150; i++) assert.ok(allDigest.includes(`message-line-${i}\n`) || allDigest.endsWith(`message-line-${i}`), `message line ${i} reachable`);
      for (const f of files) assert.ok(allDigest.includes(f.path), `${f.path} reachable`);
      for (const o of options) assert.ok(allDigest.includes(`[${o.key}] ${o.label}`), `option ${o.key} reachable`);
      for (const s of out.steps.slice(afterRows, afterDigest)) for (const r of s.refreshes) assert.equal(r.region, 'digest', 'digest paging refreshes only the digest region');
      assert.ok(!/…/.test(allDigest), 'no truncation marker in digest text');

      const draftSteps = out.steps.slice(afterDigest, afterDigest + 12);
      const pages = [probe && L.script({ screen: [W, H], initial, config: cfg(), steps: [{ op: 'tick', at_ms: 1 }] }).steps[0].visible_text.typed];
      draftSteps.forEach((s, i) => { if (i % 2 === 1 && s.visible_text.typed !== pages[pages.length - 1]) pages.push(s.visible_text.typed); });
      const rebuilt = pages.reverse().join('');
      assert.equal(rebuilt, draft, 'paging back through the draft reproduces it exactly');
      for (const s of draftSteps) for (const r of s.refreshes) assert.equal(r.region, 'typed', 'draft paging refreshes only the typed region');

      const viewStep = out.steps[out.steps.length - 1];
      assert.ok(viewStep.refreshes.length > 0 && viewStep.refreshes.every((r) => ['digest', 'typed'].includes(r.region) || /^(row:|slot:)/.test(r.region) || r.region === 'rowpager'), 'iPad view event repaints only the paged regions');
      assert.ok(viewStep.visible_text.digest.includes('message-line-') , 'iPad paging moved the digest');
      const order = Object.entries(probe.regions).filter(([k]) => k.startsWith('row:')).sort((a, b) => a[1][1] - b[1][1]).map(([k]) => k);
      assert.deepEqual(order, ids.slice(0, 7).map((i) => `row:${i}`), 'rows keep their order');
      t.note(`17 rows over 3 pages; digest ${digestPages.length} pages: 150 message lines, 30 files, 12 options all present; draft 40 lines rebuilt from ${pages.length} pages`);
    },

    async quiet_boundaries(t) {
      const d = (text, at, session = 'A') => ({ op: 'draft', session, text, at_ms: at });
      const tick = (at) => ({ op: 'tick', at_ms: at });
      const [dx, dy] = [700, 1000];
      const steps = [
        d('a', 0), d('ab', 200), tick(3199), tick(3201), tick(4000), tick(9000), // 0-5
        d('abc', 10000), d('abcd', 10200), { op: 'stream', session: 'B', text: 'x', at_ms: 13100 }, tick(13201), tick(16099), tick(16101), // 6-11
        d('abcde', 20000), d('abcdef', 20200), ...tap(dx, dy, 23000), tick(23201), tick(26039), tick(26041), // 12-18  (tap = 2 steps, release at 23040)
        d('1', 30000), d('12', 30200), d('123', 33190), tick(33201), tick(36189), tick(36191), // 19-24
        d('x', 40000), d('xy', 40050), tick(40099), tick(40101), // 25-28 coalescing
      ];
      const out = L.script({ screen: [W, H], initial: two, config: cfg({ clean_after_partials: 2 }), steps });
      const modes = (i) => out.steps[i].refreshes.map((r) => r.mode);
      assert.deepEqual(modes(2), [], 'no clean at last activity + 2999ms');
      assert.deepEqual(modes(3), ['clean'], 'exactly one clean at + 3001ms');
      assert.deepEqual([modes(4), modes(5)], [[], []], 'later idle ticks do not repeat the clean');
      assert.deepEqual([modes(9), modes(10)], [[], []], 'streaming on the other session defers the clean');
      assert.deepEqual(modes(11), ['clean'], 'clean 3001ms after the stream');
      assert.deepEqual([modes(16), modes(17)], [[], []], 'touch defers the clean (still none 2999ms after the release)');
      assert.deepEqual(modes(18), ['clean'], 'clean 3001ms after the touch release');
      assert.deepEqual(modes(21), ['partial'], 'typing at the threshold paints a partial, not a clean');
      assert.deepEqual([modes(22), modes(23)], [[], []], 'typing deferred the clean');
      assert.deepEqual(modes(24), ['clean']);
      assert.deepEqual(out.steps[25].refreshes.map((r) => r.at_ms), [40000], 'first keystroke flushes immediately');
      assert.deepEqual(out.steps[26].refreshes.map((r) => r.at_ms), [40100], 'second keystroke within the window is coalesced to +100ms (≤150ms after its stimulus)');
      const cleans = out.steps.flatMap((s) => s.refreshes).filter((r) => r.mode === 'clean').length;
      assert.equal(cleans, 4, 'four cleans in total, none repeated');
      t.note('quiet rule: no clean at +2999, one at +3001; deferred by other-session stream, touch and typing; coalesced flush at +100ms; 4 cleans total');
    },

    async lifecycle(t) {
      const snapMsg = (rev) => JSON.stringify({ protocol: 1, epoch: 'e1', revision: rev, snapshot: snapshotOf([sessionObj('A'), sessionObj('B')], 'A', rev) });
      const steps = [
        { op: 'net', net: 'connecting', text: 'lan', at_ms: 10 },
        { op: 'net', net: 'message', type: 'snapshot', raw: JSON.parse(snapMsg(5)), at_ms: 20 }, // 1 fresh
        { op: 'net', net: 'closed', text: 'connection reset', at_ms: 1000 }, // 2 transport failure
        { op: 'suspend', at_ms: 2000 }, // 3
        { op: 'resume', at_ms: 9000 }, // 4
        { op: 'net', net: 'connecting', text: 'lan', at_ms: 9100 }, // 5: reconnect attempt alone
        { op: 'net', net: 'message', type: 'heartbeat', raw: { protocol: 1, epoch: 'e1', revision: 5 }, at_ms: 9200 }, // 6: heartbeat before snapshot
        { op: 'net', net: 'message', type: 'snapshot', raw: JSON.parse(snapMsg(6)), at_ms: 9300 }, // 7
        { op: 'fail_panel', fail_at: 1, at_ms: 9400 }, // 8: backend breaks
        { op: 'draft', session: 'A', text: 'x', at_ms: 9500 }, // 9
      ];
      const out = L.script({ screen: [W, H], initial: { snapshot: snapshotOf([sessionObj('A'), sessionObj('B')], 'A') }, config: cfg(), steps, conn: { Status: 'connecting', Endpoint: 'lan' } });
      const s = out.steps;
      assert.equal(s[1].conn, 'fresh');
      assert.equal(s[2].conn, 'disconnected');
      assert.match(s[2].visible_text.status, /DISCONNECTED/);
      assert.ok(s[2].refreshes.length === 1 && s[2].refreshes[0].region === 'status', 'transport loss repaints only the status region');
      assert.ok(s[2].visible_text.digest.includes('message A'), 'content is retained when disconnected');
      assert.equal(s[3].conn, 'suspended');
      assert.match(s[3].visible_text.status, /SUSPENDED — content below is not live/);
      assert.ok(s[3].refreshes.every((r) => r.mode === 'partial' && r.region === 'status'), 'suspend is shown with a status-only partial');
      assert.equal(s[4].conn, 'stale', 'resume starts stale');
      assert.match(s[4].visible_text.status, /STALE/);
      assert.deepEqual(s[4].refreshes.map((r) => r.mode), ['init'], 'resume is one of the allowed full paints');
      assert.equal(s[4].full_paints, 2);
      assert.notEqual(s[5].conn, 'fresh', 'reconnecting alone is not fresh');
      assert.notEqual(s[6].conn, 'fresh', 'a heartbeat before the snapshot is not fresh');
      assert.equal(s[7].conn, 'fresh', 'fresh only after the authoritative snapshot');
      const inits = s.flatMap((x) => x.refreshes).filter((r) => r.mode === 'init').length;
      assert.equal(inits, 1, 'no other full paint happened');
      assert.match(s[9].fatal, /panel link write failed/, 'a backend failure is surfaced as fatal');

      // Real process: a display backend failure ends the client (AppLoad then closes the window: stock UI).
      const tm = L.fakeTmux(); tm.setPanes([tm.pane({})]);
      const srv = await L.startServer({ env: tm.env, tls: true });
      const client = await L.startClient({ endpoints: [srv.endpoint()], token: srv.token('device') });
      await client.waitDump((d) => d.conn.Status === 'fresh', 10000, 'client fresh');
      client.send({ fail_panel: 1 });
      const ctl = srv.token('controller');
      const sid = L.sessionId(tm.pane({}));
      await L.http('POST', `${srv.api}/select`, { token: ctl, body: { session_id: sid, base_revision: 1 } });
      await L.until(() => client.exited(), 8000, 'client to exit after the backend failure');
      assert.equal(client.proc.exitCode, 1);
      assert.match(client.stderr, /display backend failed/);

      // Launcher watchdog: a frozen client is killed, so the window closes instead of showing a frozen "live" screen.
      const app = L.tmp('app');
      fs.copyFileSync(L.hostBin(), path.join(app, 'matrix-rm2'));
      fs.copyFileSync(path.join(L.candidate, 'rm2/app/launch.sh'), path.join(app, 'launch.sh'));
      const state = path.join(app, 'state'); fs.mkdirSync(state);
      const root = L.fixtureRoot();
      fs.writeFileSync(path.join(app, 'config.json'), JSON.stringify({ endpoints: [srv.endpoint()], token: srv.token('device') }));
      const ver = L.spawnSync(L.hostBin(), ['version'], { encoding: 'utf8' }).stdout.split(' ')[1];
      fs.writeFileSync(path.join(state, `firstrun-ok-3.28.0.162-${ver}`), 'x');
      const launcher = L.spawn('sh', [path.join(app, 'launch.sh')], { stdio: 'ignore', env: { ...process.env, MATRIX_RM2_STATE: state, MATRIX_RM2_CONFIG: path.join(app, 'config.json'), MATRIX_RM2_WATCHDOG_SECONDS: '3', MATRIX_RM2_EXTRA_ARGS: `--backend capture --root ${root}` } });
      const done = new Promise((r) => launcher.once('exit', (code) => r(code)));
      const child = await L.until(() => { const r = L.spawnSync('pgrep', ['-P', String(launcher.pid), 'matrix-rm2'], { encoding: 'utf8' }); return r.stdout.trim().split('\n')[0] || null; }, 5000, 'client under the launcher');
      await L.until(() => fs.existsSync(path.join(state, 'heartbeat')) && /T/.test(fs.readFileSync(path.join(state, 'heartbeat'), 'utf8')), 5000, 'client heartbeat');
      process.kill(Number(child), 'SIGSTOP'); // the client freezes
      const code = await Promise.race([done, L.wait(15000).then(() => 'timeout')]);
      try { process.kill(Number(child), 'SIGKILL'); } catch { /* already gone */ }
      assert.equal(code, 70, 'the watchdog ended the frozen client');
      assert.match(fs.readFileSync(path.join(state, 'client.log'), 'utf8'), /watchdog: client stopped responding/);
      t.note('status-only partials for disconnect/suspend; resume = 1 allowed full paint, stale until snapshot; backend failure → process exit 1; frozen client killed by launcher watchdog (exit 70)');
    },
  };
};
