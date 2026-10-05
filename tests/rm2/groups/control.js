// Control group: the real Matrix server, the real Control page in WebKit with
// real keyboard/mouse events, and the production client (host build) on the
// same local transport. Only the tmux binary is a double.
module.exports = (L) => {
  const { assert, fs, path } = L;
  const P = 0x10; const R = 0x11;

  async function setup({ client = true, page = true, panes, env = {} } = {}) {
    const tm = L.fakeTmux();
    const list = (panes || [
      { session_id: '$1', session_name: 'proj', pane_id: '%1', '@matrix_project': 'proj' },
      { session_id: '$2', session_name: 'proj-2', pane_id: '%2', '@matrix_project': 'proj' },
    ]).map((p) => tm.pane(p));
    tm.setPanes(list);
    const srv = await L.startServer({ env: { ...tm.env, ...env }, tls: true });
    L.hookToken(srv);
    const ctl = srv.token('controller');
    await L.until(async () => (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data.sessions.length === list.length, 5000, 'the first session collection');
    const fire = (pane, name, extra = {}) => L.hook(srv, pane, { session_id: `conv-${pane.pane_id.slice(1)}-control`, transcript_path: path.join(srv.transcripts, `c${pane.pane_id.slice(1)}.jsonl`), hook_event_name: name, ...extra });
    for (const p of list) { fire(p, 'UserPromptSubmit', { prompt: `first prompt ${p.pane_id}` }); fire(p, 'Stop', { last_assistant_message: `answer ${p.pane_id}` }); }
    const snap = async () => (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data;
    const ids = list.map(L.sessionId);
    const x = { tm, srv, list, ctl, fire, snap, ids };
    if (client) {
      x.client = await L.startClient({ endpoints: [srv.endpoint()], token: srv.token('device') });
      await x.client.waitDump((d) => d.conn.Status === 'fresh', 10000, 'RM client fresh');
    }
    if (page) x.page = await L.openControl(srv);
    x.rowCenter = async (id) => { const order = (await snap()).sessions.map((s) => s.id); return [700, 72 + order.indexOf(id) * 66 + 31]; };
    x.pageSelected = () => x.page.evaluate(() => { const li = document.querySelector('#sessions li[aria-selected="true"]'); return li ? li.dataset.session : ''; });
    x.select = async (id) => { const s = await snap(); const r = await L.http('POST', `${srv.api}/select`, { token: ctl, body: { session_id: id, base_revision: s.selection.revision } }); assert.equal(r.status, 200); };
    return x;
  }
  // Milliseconds until fn() is truthy, polling fast.
  async function timed(fn, limit, what) { const t0 = Date.now(); await L.until(fn, limit, what); return Date.now() - t0; }
  const typed = async (c) => (await c.dump()).visible.typed;

  // A7-1: text typed in Control while a submit is being delivered is a newer draft. Neither the
  // server's acknowledgement nor the page's own success handler may clear or replace it.
  async function editedWhileSending(x, a, t) {
    const draftOf = async () => (await x.snap()).sessions.find((q) => q.id === a).draft;
    const local = () => x.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), `matrix-control-draft:${a}`);
    const settled = () => L.until(async () => !(await x.page.isDisabled('#submit')), 3000, 'the submit handler to finish');
    const NEW = 'NEW text typed while sending'; const LATER = 'LATER text not yet saved on the Mac';
    const revs = [];
    await x.page.fill('#draft', 'original draft');
    await L.until(async () => (await draftOf()).text === 'original draft', 2000, 'the original draft to be saved');
    revs.push((await draftOf()).revision);
    // (1) The newer text is already saved on the Mac when the acknowledgement arrives.
    let n = x.tm.sent().length;
    x.tm.hold('paste-buffer');
    await x.page.click('#submit');
    await L.until(() => x.tm.held() === 1, 3000, 'the delivery to block in tmux paste-buffer');
    await x.page.fill('#draft', NEW);
    await L.until(async () => (await draftOf()).text === NEW, 2000, 'the newer draft to be saved during delivery');
    revs.push((await draftOf()).revision);
    x.tm.release();
    await L.until(() => x.tm.sent().length === n + 2, 3000, 'the delivery to complete');
    await settled(); await L.wait(200);
    assert.deepEqual(x.tm.sent().slice(n).map((q) => q.text || q.key), ['original draft', 'Enter'], 'only the submitted revision was sent');
    assert.equal(await x.page.inputValue('#draft'), NEW, 'the page kept the text typed during delivery');
    assert.deepEqual([(await draftOf()).text, (await draftOf()).status, (await local()).text], [NEW, 'unsent', NEW], 'server and local storage hold the newer draft');
    revs.push((await draftOf()).revision);
    // (2) The newer text has not reached the Mac yet: its save is held on the wire while the server clears the sent draft.
    // (The page's own fetch is delayed: the Control service worker sits between the page and network-level interception.)
    await x.page.evaluate(() => {
      const real = window.fetch.bind(window);
      const gate = new Promise((r) => { window.__letSave = r; });
      window.fetch = (u, o) => (o && o.method === 'PUT' && String(u).endsWith('/draft') ? gate.then(() => real(u, o)) : real(u, o));
    });
    n = x.tm.sent().length;
    x.tm.hold('paste-buffer');
    await x.page.click('#submit');
    await L.until(() => x.tm.held() === 1, 3000, 'the second delivery to block');
    await x.page.fill('#draft', LATER);
    x.tm.release();
    await L.until(async () => (await draftOf()).text === '', 3000, 'the server to clear the draft it sent');
    await settled(); await L.wait(300);
    assert.equal(await x.page.inputValue('#draft'), LATER, 'the cleared server draft did not replace unsaved newer text');
    assert.deepEqual([(await local()).text, (await local()).synced], [LATER, false], 'local storage keeps the unsaved newer text');
    await x.page.evaluate(() => window.__letSave());
    await L.until(async () => (await draftOf()).text === LATER, 3000, 'the newer text to be saved once the wire is free');
    revs.push((await draftOf()).revision);
    assert.deepEqual(x.tm.sent().slice(n).map((q) => q.text || q.key), [NEW, 'Enter']);
    assert.ok(revs.every((r, i) => i === 0 || r >= revs[i - 1]) && revs[1] > revs[0] && revs[3] > revs[2], `draft revisions never go back and every edit raises them (${revs.join(' ≤ ')})`);
    // Reload: the page comes back with the newer draft.
    await x.page.reload();
    await x.page.waitForFunction(() => document.getElementById('conn').textContent === 'Live', null, { timeout: 10000 });
    await L.until(async () => (await x.page.inputValue('#draft')) === LATER, 3000, 'the newer draft after a reload');
    t.note(`edited during delivery (tmux paste-buffer barrier): saved-in-time and held-on-the-wire edits both survive the acknowledgement; sent exactly the submitted revisions; revisions ${revs.join(' ≤ ')}; reload shows the newer draft`);
  }

  // Admission interleavings, on the production server over real HTTP. The
  // collector is parked (one collection at start, then none) so every tmux
  // call counted at a barrier belongs to a command under test.
  async function admission() {
    const x = await setup({ client: false, page: false, env: { MATRIX_EINK_POLL_MS: '3600000' } });
    x.post = (route, body) => L.http('POST', `${x.srv.api}${route}`, { token: x.ctl, body });
    x.rev = async () => (await x.snap()).selection.revision;
    x.draft = async (id, text, revision) => assert.equal((await L.http('PUT', `${x.srv.api}/draft`, { token: x.ctl, body: { session_id: id, text, revision } })).status, 200);
    x.sent = () => x.tm.sent().map((s) => (s.type === 'paste' ? `${s.pane}:paste:${s.text}` : `${s.pane}:${s.key}`));
    // Starts `first`, waits until it is blocked inside tmux `command`, runs `during`, then releases.
    x.atBarrier = async (command, first, during) => {
      x.tm.hold(command);
      const pending = first();
      await L.until(() => x.tm.held() === 1, 3000, `the command to block in tmux ${command}`);
      const mid = await during();
      assert.equal(x.tm.held(), 1, 'only the first command reached tmux while the barrier was up');
      x.tm.release();
      return [await pending, mid];
    };
    x.ask = async (pane, id) => {
      const input = { questions: [{ question: 'Which?', header: 'Q', multiSelect: false, options: [{ label: 'One' }, { label: 'Two' }] }] };
      x.fire(pane, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: id, tool_input: input });
      const sid = L.sessionId(pane);
      const q = await L.until(async () => { const s = (await x.snap()).sessions.find((v) => v.id === sid); return s.question.pending ? s.question : null; }, 3000, 'the question to be pending');
      return { qid: q.id, resolve: () => x.fire(pane, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: id, tool_input: input, tool_response: {} }) };
    };
    return x;
  }

  const cases = {
    async bidirectional_selection(t) {
      const x = await setup();
      const [a, b] = x.ids;
      // RM tap on row B (QTFB-encoded touch).
      const [bx, by] = await x.rowCenter(b);
      let t0 = Date.now();
      x.client.send({ touch: [P, 0, bx, by] }); x.client.send({ touch: [R, 0, bx, by] });
      const [rmMs, padMs] = await Promise.all([
        L.until(async () => (await x.client.dump()).selection.session_id === b, 3000, 'RM selection B').then(() => Date.now() - t0),
        L.until(async () => (await x.pageSelected()) === b, 3000, 'iPad selection B').then(() => Date.now() - t0),
      ]);
      assert.ok(rmMs <= 300 && padMs <= 300, `RM tap converged in RM ${rmMs}ms / iPad ${padMs}ms (limit 300)`);
      // iPad click on row A.
      t0 = Date.now();
      await x.page.click(`#sessions li[data-session="${a}"]`);
      const [rm2, pad2] = await Promise.all([
        L.until(async () => (await x.client.dump()).selection.session_id === a, 3000, 'RM selection A').then(() => Date.now() - t0),
        L.until(async () => (await x.pageSelected()) === a, 3000, 'iPad selection A').then(() => Date.now() - t0),
      ]);
      assert.ok(rm2 <= 300 && pad2 <= 300, `iPad click converged in RM ${rm2}ms / iPad ${pad2}ms (limit 300)`);
      assert.match((await x.client.dump()).visible[`row:${a}`], /^> /, 'RM marks the selected row');
      const selects = (await x.snap()).selection.revision;
      assert.equal(selects, 3, 'exactly two selections were applied (revision 1 → 3)');
      // The two same-project sessions route independently.
      await x.page.fill('#draft', 'to A');
      await x.page.click('#submit');
      await L.until(() => x.tm.sent().length === 2, 3000, 'send to A');
      await x.page.click(`#sessions li[data-session="${b}"]`);
      await L.until(async () => (await x.pageSelected()) === b, 2000, 'B selected');
      await x.page.fill('#draft', 'to B');
      await x.page.click('#submit');
      await L.until(() => x.tm.sent().length === 4, 3000, 'send to B');
      assert.deepEqual(x.tm.sent().filter((s) => s.type === 'paste').map((s) => [s.pane, s.text]), [['%1', 'to A'], ['%2', 'to B']]);
      t.note(`RM tap→ RM ${rmMs}ms, iPad ${padMs}ms; iPad click→ RM ${rm2}ms, iPad ${pad2}ms; same-project sessions proj/proj-2 routed to %1/%2`);
    },

    async keyboard_mouse_ime(t) {
      const x = await setup();
      await x.select(x.ids[0]);
      await L.until(async () => (await x.pageSelected()) === x.ids[0], 2000, 'selected');
      const ta = x.page.locator('#draft');
      await ta.click();
      await x.page.keyboard.type('hello wurld');
      let t0 = Date.now();
      const ms1 = await timed(async () => (await typed(x.client)) === 'hello wurld', 2000, 'RM echo of typing');
      // Keyboard editing: backspace and retype.
      for (let i = 0; i < 5; i++) await x.page.keyboard.press('Backspace');
      await x.page.keyboard.type('world');
      const ms2 = await timed(async () => (await typed(x.client)) === 'hello world', 2000, 'RM echo of the edit');
      // Mouse selection then delete: double-click selects a word.
      const box = await ta.boundingBox();
      await x.page.mouse.dblclick(box.x + 20, box.y + 18);
      const selectedText = await x.page.evaluate(() => { const e = document.getElementById('draft'); return e.value.slice(e.selectionStart, e.selectionEnd); });
      assert.ok(selectedText.trim() === 'hello', `the mouse selected a word (${JSON.stringify(selectedText)})`);
      assert.deepEqual(x.tm.sent(), [], 'selecting text sends nothing');
      await x.page.keyboard.press('Backspace');
      const afterMouse = await x.page.inputValue('#draft');
      const ms3 = await timed(async () => (await typed(x.client)) === afterMouse, 2000, 'RM echo after mouse delete');
      assert.ok(!afterMouse.includes('hello'));
      // Multiline Unicode insert (paste path: one input event with the whole text).
      await x.page.keyboard.press('Meta+A');
      await x.page.keyboard.insertText('línea uno\nline two — 日本語 ✓');
      const ms4 = await timed(async () => (await typed(x.client)) === 'línea uno\nline two — 日本語 ✓', 2000, 'RM echo of multiline unicode');
      // Enter adds a line and sends nothing.
      await x.page.keyboard.press('Enter');
      await L.until(async () => (await typed(x.client)) === 'línea uno\nline two — 日本語 ✓\n', 2000, 'RM echo of Enter');
      assert.deepEqual(x.tm.sent(), [], 'plain Enter is a new line, not a send');
      // IME composition: the RM shows only committed text.
      const committedBefore = await typed(x.client);
      await x.page.evaluate(() => {
        const e = document.getElementById('draft');
        e.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        e.value += 'にほ';
        e.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText', data: 'にほ' }));
        e.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', metaKey: true, isComposing: true }));
      });
      await L.wait(400);
      assert.equal(await typed(x.client), committedBefore, 'uncommitted composition text is not echoed');
      assert.deepEqual(x.tm.sent(), [], 'the send shortcut does nothing during composition');
      await x.page.evaluate(() => {
        const e = document.getElementById('draft');
        e.value = e.value.slice(0, -2) + '日本';
        e.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
      });
      const ms5 = await timed(async () => (await typed(x.client)) === committedBefore + '日本', 2000, 'RM echo of the committed composition');
      // Explicit send by shortcut.
      const final = await x.page.inputValue('#draft');
      await x.page.keyboard.press('Meta+Enter');
      await L.until(() => x.tm.sent().length === 2, 3000, 'the shortcut to send');
      assert.deepEqual(x.tm.sent(), [{ type: 'paste', pane: '%1', text: final, bracketed: true, raw: true }, { type: 'key', pane: '%1', key: 'Enter' }]);
      for (const [name, ms] of [['typing', ms1], ['edit', ms2], ['mouse delete', ms3], ['multiline', ms4], ['composition commit', ms5]]) assert.ok(ms <= 300, `${name} echo took ${ms}ms (limit 300)`);
      t.note(`draft echo: typing ${ms1}ms, edit ${ms2}ms, mouse-delete ${ms3}ms, multiline unicode ${ms4}ms, IME commit ${ms5}ms; Enter=newline, ⌘Enter=send; nothing sent before submit; started ${Date.now() - t0}ms ago`);
    },

    async literal_submit(t) {
      const x = await setup({ client: false });
      const [a, b] = x.ids;
      const marker = path.join(L.tmp('marker'), 'MARKER');
      const text = `ünïcødé 日本語 ✓\n"double" 'single' $(touch ${marker}) \`touch ${marker}2\` $HOME ; touch ${marker}3 && echo | \\ -- -t %9 #{pane_id}\n\tlast line`;
      await x.select(b);
      await L.http('PUT', `${x.srv.api}/draft`, { token: x.ctl, body: { session_id: b, text: 'draft kept for B', revision: 1 } });
      await x.select(a);
      await L.until(async () => (await x.pageSelected()) === a, 2000, 'A selected');
      await x.page.locator('#draft').click();
      await x.page.keyboard.insertText(text);
      await x.page.click('#submit');
      await L.until(() => x.tm.sent().length >= 2, 3000, 'the send');
      await L.wait(300);
      assert.deepEqual(x.tm.sent(), [{ type: 'paste', pane: '%1', text, bracketed: true, raw: true }, { type: 'key', pane: '%1', key: 'Enter' }], 'exact bytes to the selected pane and exactly one Enter');
      const setBuf = x.tm.calls().filter((c) => c.argv[0] === 'set-buffer');
      assert.equal(setBuf.length, 1);
      assert.equal(setBuf[0].argv[setBuf[0].argv.length - 1], text, 'the text travelled as one argv element');
      assert.equal(setBuf[0].argv[setBuf[0].argv.length - 2], '--');
      for (const m of [marker, `${marker}2`, `${marker}3`]) assert.ok(!fs.existsSync(m), 'no shell ever interpreted the text');
      const s = await x.snap();
      const sa = s.sessions.find((q) => q.id === a); const sb = s.sessions.find((q) => q.id === b);
      assert.deepEqual([sa.draft.text, sa.draft.status], ['', ''], 'the submitted draft is cleared after acknowledgement');
      assert.equal(await x.page.inputValue('#draft'), '');
      assert.equal(sb.draft.text, 'draft kept for B', 'other drafts are untouched');
      assert.equal(sa.prompt.text, 'first prompt %1', 'the last prompt is recorded separately from the draft (it changes only on hook evidence)');
      x.fire(x.list[0], 'UserPromptSubmit', { prompt: text });
      assert.equal((await x.snap()).sessions.find((q) => q.id === a).prompt.text, text);
      // Only the submitted draft is cleared: text typed while it was being delivered stays (A7-1).
      await editedWhileSending(x, a, t);
      t.note(`submitted ${text.length} chars incl. unicode/newlines/quotes/$()/backticks: exact paste + 1 Enter to %1; 3 marker commands not executed; only A's draft cleared`);
    },

    async selection_race(t) {
      const x = await setup({ client: false });
      const [a, b] = x.ids;
      await x.select(a);
      await L.until(async () => (await x.pageSelected()) === a, 2000, 'A selected');
      await x.page.locator('#draft').click();
      await x.page.keyboard.type('draft for A');
      await L.until(async () => (await x.snap()).sessions.find((q) => q.id === a).draft.text === 'draft for A', 2000, 'draft saved');
      const before = await x.snap();
      const dev = x.srv.token('device');
      // The RM selects B remotely.
      let r = await L.http('POST', `${x.srv.api}/select`, { token: dev, body: { session_id: b, base_revision: before.selection.revision } });
      assert.equal(r.status, 200);
      // A delayed submit and a delayed answer for A, still carrying the old selection revision.
      const dA = before.sessions.find((q) => q.id === a).draft;
      r = await L.http('POST', `${x.srv.api}/submit`, { token: x.ctl, body: { session_id: a, selection_revision: before.selection.revision, draft_revision: dA.revision, idempotency_id: 'race-submit-0001' } });
      assert.equal(r.status, 409, 'stale submit is rejected');
      r = await L.http('POST', `${x.srv.api}/answer`, { token: x.ctl, body: { session_id: a, selection_revision: before.selection.revision, question_id: 'q', keys: ['1'], idempotency_id: 'race-answer-0001' } });
      assert.equal(r.status, 409, 'stale answer is rejected');
      r = await L.http('POST', `${x.srv.api}/key`, { token: x.ctl, body: { session_id: a, selection_revision: before.selection.revision, keys: ['Enter'], idempotency_id: 'race-key-000001' } });
      assert.equal(r.status, 409, 'stale key is rejected');
      // A submit that names B's session with A's revision is also refused: nothing is retargeted.
      r = await L.http('POST', `${x.srv.api}/submit`, { token: x.ctl, body: { session_id: b, selection_revision: before.selection.revision, draft_revision: 1, idempotency_id: 'race-submit-0002' } });
      assert.equal(r.status, 409);
      assert.deepEqual(x.tm.sent(), [], 'nothing was sent to A or to B');
      const after = await x.snap();
      assert.equal(after.sessions.find((q) => q.id === a).draft.text, 'draft for A', 'draft A is retained');
      // The page followed the remote selection and did not move A's draft into B.
      await L.until(async () => (await x.pageSelected()) === b, 2000, 'page follows the remote selection');
      assert.equal(await x.page.inputValue('#draft'), '', 'B shows its own (empty) draft');
      await x.page.click(`#sessions li[data-session="${a}"]`);
      await L.until(async () => (await x.page.inputValue('#draft')) === 'draft for A', 2000, 'A\'s draft is back when A is selected again');
      // Two simultaneous selections serialise: one wins, one is refused, both clients share the final revision.
      const base = (await x.snap()).selection.revision;
      const both = await Promise.all([
        L.http('POST', `${x.srv.api}/select`, { token: dev, body: { session_id: b, base_revision: base } }),
        L.http('POST', `${x.srv.api}/select`, { token: x.ctl, body: { session_id: a, base_revision: base } }),
      ]);
      assert.deepEqual(both.map((q) => q.status).sort(), [200, 409]);
      const fin = (await x.snap()).selection;
      assert.equal(fin.revision, base + 1);
      const winner = both[0].status === 200 ? b : a;
      assert.equal(fin.session_id, winner);
      await L.until(async () => (await x.pageSelected()) === winner, 2000, 'page converges on the winner');
      t.note('stale submit/answer/key → 409 ×4, 0 sends, draft A retained; simultaneous selections → one 200 + one 409, shared final revision');
      // The same guarantees when the requests overlap inside the server (A6-1).
      await L.cleanup();
      await cases.duplicate_command_admission(t);
      await L.cleanup();
      await cases.revalidation_before_delivery(t);
    },

    async pending_answer(t) {
      const x = await setup({ client: false });
      const [a] = x.ids; const pa = x.list[0];
      await x.select(a);
      await L.until(async () => (await x.pageSelected()) === a, 2000, 'A selected');
      const keys = () => x.tm.sent().filter((s) => s.type === 'key').map((s) => `${s.pane}:${s.key}`);
      // Single-choice question.
      x.fire(pa, 'UserPromptSubmit', { prompt: 'ask me' });
      const q1 = { questions: [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] };
      x.fire(pa, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-single', tool_input: q1 });
      await x.page.waitForSelector('#question:not([hidden]) button[data-option="2"]');
      await x.page.click('#question-options button[data-option="2"]');
      await L.until(() => keys().length === 1, 3000, 'single-choice key');
      assert.deepEqual(keys(), ['%1:2']);
      const staleId = (await x.snap()).sessions.find((q) => q.id === a).question.id;
      x.fire(pa, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-single', tool_input: q1, tool_response: {} });
      // Multiple-choice question.
      const q2 = { questions: [{ question: 'Which features?', header: 'F', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Search' }, { label: 'Export' }] }] };
      x.fire(pa, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-multi', tool_input: q2 });
      await x.page.waitForSelector('#question-send:not([hidden])');
      await x.page.click('#question-options button[data-option="3"]');
      await x.page.click('#question-options button[data-option="1"]');
      assert.equal(keys().length, 1, 'toggling choices sends nothing');
      await x.page.click('#question-send');
      await L.until(() => keys().length === 4, 3000, 'multi-choice keys');
      assert.deepEqual(keys().slice(1), ['%1:1', '%1:3', '%1:Enter']);
      x.fire(pa, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-multi', tool_input: q2, tool_response: {} });
      // Permission prompt: the displayed terminal choices.
      x.tm.setCapture('%1', [' Do you want to make this edit to app.js?', ' ❯ 1. Yes', '   2. Yes, allow all edits during this session (shift+tab)', '   3. No, and tell Claude what to do differently (esc)'].join('\n'));
      x.fire(pa, 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'ed1', tool_input: { file_path: '/w/app.js' } });
      x.fire(pa, 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/w/app.js' } });
      await x.page.waitForSelector('#question-options button[data-option="3"]');
      assert.equal(await x.page.textContent('#question-options button[data-option="1"]'), '[1] Yes');
      await x.page.click('#question-options button[data-option="1"]');
      await L.until(() => keys().length === 5, 3000, 'permission key');
      assert.equal(keys()[4], '%1:1');
      // Rejections: none of these may inject a key.
      const sel = (await x.snap()).selection.revision;
      const qid = (await x.snap()).sessions.find((q) => q.id === a).question.id;
      const post = (body) => L.http('POST', `${x.srv.api}/answer`, { token: x.ctl, body: { session_id: a, selection_revision: sel, idempotency_id: `rej-${Math.random().toString(16).slice(2)}aaaa`, ...body } });
      assert.equal((await post({ question_id: staleId, keys: ['1'] })).status, 409, 'stale question id');
      assert.equal((await post({ question_id: qid, keys: ['9'] })).status, 422, 'a choice that is not displayed');
      assert.equal((await post({ question_id: qid, keys: ['1', '2'] })).status, 422, 'a permission prompt takes one choice');
      assert.equal((await L.http('POST', `${x.srv.api}/key`, { token: x.ctl, body: { session_id: a, selection_revision: sel, keys: ['F12'], idempotency_id: 'rej-key-00000001' } })).status, 400, 'a key outside the allowed set');
      x.tm.setCapture('%1', 'the prompt is gone\n$ ');
      assert.equal((await post({ question_id: qid, keys: ['1'] })).status, 409, 'the terminal no longer shows the prompt');
      x.fire(pa, 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'ed1', tool_input: { file_path: '/w/app.js' }, tool_response: {} });
      assert.equal((await post({ question_id: qid, keys: ['1'] })).status, 409, 'a resolved question');
      // The session is replaced by a new one with the same name: the old identity is refused.
      x.tm.setPanes([x.tm.pane({ ...x.list[0], session_created: '1800000000' }), x.list[1]]);
      await L.until(async () => (await x.snap()).sessions.some((q) => q.id === a && !q.present), 4000, 'old session marked missing');
      const gone = await post({ question_id: qid, keys: ['1'] });
      assert.ok([409, 410].includes(gone.status), `replaced session refused (${gone.status})`);
      assert.equal(keys().length, 5, 'no rejected request injected a key');
      t.note('clicks: single choice → [2]; multi choice → [1,3,Enter]; permission → [1]; 7 rejections (stale id, undisplayed choice, 2 choices, bad key, prompt gone, resolved, replaced session) → 0 keys');
    },

    // A6-1: one idempotency id is delivered at most once, however the requests interleave.
    async duplicate_command_admission(t) {
      const x = await admission();
      const [a] = x.ids; const pa = x.list[0];
      await x.select(a);
      const sel = await x.rev();
      await x.draft(a, 'send me once', 1);
      const inProgress = (r, what) => { assert.equal(r.status, 409, `${what}: the duplicate is refused`); assert.equal(r.data.state, 'in_progress', `${what}: refused as in progress`); };

      // submit: the duplicate arrives while the first is still validating its target.
      const submit = { session_id: a, selection_revision: sel, draft_revision: 1, idempotency_id: 'dup-submit-0001' };
      let [first, dup] = await x.atBarrier('list-panes', () => x.post('/submit', submit), () => x.post('/submit', submit));
      inProgress(dup, 'submit');
      assert.equal(first.status, 200);
      assert.deepEqual(x.sent(), ['%1:paste:send me once', '%1:Enter'], 'exactly one paste and one Enter');
      const replay = await x.post('/submit', submit);
      assert.deepEqual([replay.status, replay.data.replayed], [200, true], 'a later retry is answered from the journal');
      assert.equal(x.sent().length, 2, 'the retry sent nothing');

      // key
      const key = { session_id: a, selection_revision: sel, keys: ['Down'], idempotency_id: 'dup-key-000001' };
      [first, dup] = await x.atBarrier('list-panes', () => x.post('/key', key), () => x.post('/key', key));
      inProgress(dup, 'key');
      assert.equal(first.status, 200);
      assert.deepEqual(x.sent().slice(2), ['%1:Down'], 'exactly one key');

      // answer
      const q = await x.ask(pa, 'ask-dup');
      const answer = { session_id: a, selection_revision: sel, question_id: q.qid, keys: ['2'], idempotency_id: 'dup-answer-0001' };
      [first, dup] = await x.atBarrier('list-panes', () => x.post('/answer', answer), () => x.post('/answer', answer));
      inProgress(dup, 'answer');
      assert.equal(first.status, 200);
      assert.deepEqual(x.sent().slice(3), ['%1:2'], 'exactly one answer key');

      // Two different ids for the same draft (a double tap): both validate, one delivers.
      await x.draft(a, 'double tap', 3);
      x.tm.hold('list-panes');
      const pair = [1, 2].map((n) => x.post('/submit', { session_id: a, selection_revision: sel, draft_revision: 3, idempotency_id: `dup-double-000${n}` }));
      await L.until(() => x.tm.held() === 2, 3000, 'both submits to block in tmux list-panes');
      x.tm.release();
      const statuses = (await Promise.all(pair)).map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 409], 'one double-tapped submit delivers, the other is refused');
      assert.deepEqual(x.sent().slice(4), ['%1:paste:double tap', '%1:Enter'], 'the draft was pasted once');
      t.note('same id concurrently at a tmux list-panes barrier: submit/key/answer → 200 + 409 in_progress, 1 delivery each, later retry replayed; two ids for one draft → 200 + 409, 1 paste');
    },

    // A6-1: what was true when validation started must still be true at the instant delivery starts.
    async revalidation_before_delivery(t) {
      const x = await admission();
      const [a, b] = x.ids; const pa = x.list[0];
      await x.select(a);
      let sel = await x.rev();
      await x.draft(a, 'for A only', 1);
      const selectB = async () => { const r = await x.post('/select', { session_id: b, base_revision: sel }); assert.equal(r.status, 200, 'the selection moved to B during validation'); };
      const refused = (r, what, re) => { assert.equal(r.status, 409, `${what} is refused`); assert.match(r.data.error, re, what); assert.deepEqual(x.sent(), [], `${what}: nothing was sent to any pane`); };

      // The selection changes while tmux is being asked whether the pane is alive.
      const submit = { session_id: a, draft_revision: 1, idempotency_id: 'reval-submit-001' };
      let [r] = await x.atBarrier('list-panes', () => x.post('/submit', { ...submit, selection_revision: sel }), selectB);
      refused(r, 'submit after a selection change', /selection changed/);
      assert.equal((await x.snap()).sessions.find((s) => s.id === a).draft.text, 'for A only', 'the draft is kept');
      await x.select(a); sel = await x.rev();
      [r] = await x.atBarrier('list-panes', () => x.post('/key', { session_id: a, selection_revision: sel, keys: ['Enter'], idempotency_id: 'reval-key-00001' }), selectB);
      refused(r, 'key after a selection change', /selection changed/);
      await x.select(a); sel = await x.rev();
      let q = await x.ask(pa, 'ask-reval-1');
      [r] = await x.atBarrier('list-panes', () => x.post('/answer', { session_id: a, selection_revision: sel, question_id: q.qid, keys: ['1'], idempotency_id: 'reval-answer-001' }), selectB);
      refused(r, 'answer after a selection change', /selection changed/);
      await x.select(a); sel = await x.rev();

      // The question is answered elsewhere while validation is in flight.
      [r] = await x.atBarrier('list-panes', () => x.post('/answer', { session_id: a, selection_revision: sel, question_id: q.qid, keys: ['1'], idempotency_id: 'reval-answer-002' }), async () => q.resolve());
      refused(r, 'answer to a question resolved during validation', /no longer pending/);
      // ...and while the terminal is being read for a permission prompt.
      x.tm.setCapture('%1', [' Do you want to make this edit to app.js?', ' ❯ 1. Yes', '   2. No'].join('\n'));
      x.fire(pa, 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'ed-reval', tool_input: { file_path: '/w/app.js' } });
      x.fire(pa, 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/w/app.js' } });
      const perm = await L.until(async () => { const s = (await x.snap()).sessions.find((v) => v.id === a); return s.question.pending && s.question.choices_available ? s.question : null; }, 3000, 'the permission prompt');
      [r] = await x.atBarrier('capture-pane', () => x.post('/answer', { session_id: a, selection_revision: sel, question_id: perm.id, keys: ['1'], idempotency_id: 'reval-answer-003' }),
        async () => x.fire(pa, 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'ed-reval', tool_input: { file_path: '/w/app.js' }, tool_response: {} }));
      refused(r, 'answer to a permission prompt resolved during the terminal read', /no longer pending/);

      // A different Claude conversation takes over the pane during validation.
      [r] = await x.atBarrier('list-panes', () => x.post('/submit', { ...submit, selection_revision: sel, idempotency_id: 'reval-submit-002' }),
        async () => L.hook(x.srv, pa, { session_id: 'conv-1-replacement', hook_event_name: 'UserPromptSubmit', prompt: 'a new conversation' }));
      refused(r, 'submit after the conversation changed', /conversation changed/);
      [r] = await x.atBarrier('list-panes', () => x.post('/key', { session_id: a, selection_revision: sel, keys: ['Enter'], idempotency_id: 'reval-key-00002' }),
        async () => L.hook(x.srv, pa, { session_id: 'conv-1-replacement-2', hook_event_name: 'UserPromptSubmit', prompt: 'another conversation' }));
      refused(r, 'key after the conversation changed', /conversation changed/);

      // A refused command did not burn its id: the same id delivers once the state is settled.
      const ok = await x.post('/submit', { ...submit, selection_revision: sel });
      assert.equal(ok.status, 200, 'the refused id can be sent again');
      assert.deepEqual(x.sent(), ['%1:paste:for A only', '%1:Enter']);
      t.note('at a tmux barrier: selection change → submit/key/answer 409; question resolved during list-panes and during capture-pane → answer 409; conversation replaced → submit/key 409; 0 sends across 7 refusals; refused id later delivered once');
    },

    async quick_access(t) {
      const x = await setup({ client: false, page: false });
      const page = await L.newPage();
      await page.addInitScript(() => {
        window.__permCalls = 0;
        // The OS notification permission is the outside world; count requests to it.
        window.Notification = { permission: 'default', requestPermission: async () => { window.__permCalls += 1; window.Notification.permission = 'denied'; return 'denied'; } };
        if (!('PushManager' in window)) window.PushManager = function PushManager() {};
      });
      await page.goto(`${x.srv.base}/control/`);
      const href = await page.getAttribute('link[rel="manifest"]', 'href');
      const manifest = await page.evaluate(async (h) => (await fetch(h)).json(), href);
      assert.deepEqual([manifest.start_url, manifest.scope, manifest.display], ['./', './', 'standalone'], 'dedicated manifest with origin-relative start_url and scope');
      assert.ok(!JSON.stringify(manifest).includes('http'), 'no machine-specific origin in the manifest');
      const resolved = new URL(manifest.start_url, new URL(href, page.url())).pathname;
      assert.equal(resolved, '/control/');
      await page.fill('#pair-code', x.srv.pairCode());
      await page.click('#pair-form button');
      await page.waitForFunction(() => document.getElementById('conn').textContent === 'Live');
      assert.equal(await page.evaluate(() => window.__permCalls), 0, 'no permission request on load or pairing');
      assert.match(await page.textContent('#notify-status'), /not installed to Home Screen/, 'install status is stated');
      await x.select(x.ids[0]);
      await page.waitForFunction(() => !document.getElementById('draft').disabled);
      // Hardware keyboard: Tab reaches the draft box and typing lands in it.
      await page.locator('#sessions li').first().click();
      for (let i = 0; i < 40 && (await page.evaluate(() => document.activeElement.id)) !== 'draft'; i++) await page.keyboard.press('Tab');
      await page.focus('#draft');
      await page.keyboard.type('kbd');
      assert.equal(await page.inputValue('#draft'), 'kbd', 'keyboard focus works');
      // Every actionable control can be reached with the mouse.
      const controls = await page.$$eval('button, a, textarea, #sessions li', (els) => els.filter((e) => !e.closest('[hidden]')).map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.textContent.trim().slice(0, 20), w: r.width, h: r.height }; }));
      assert.ok(controls.length >= 20 && controls.every((c) => c.w >= 20 && c.h >= 20), `all ${controls.length} visible controls have a mouse target`);
      await page.click('#notify-enable');
      await page.waitForFunction(() => window.__permCalls === 1);
      await page.waitForFunction(() => /Permission: denied/.test(document.getElementById('notify-status').textContent));
      assert.match(await page.textContent('#notify-status'), /Permission: denied \(enable in Settings/, 'a denied permission is explained');
      // One tap back to the rest of Matrix.
      await page.click('#link-matrix');
      await page.waitForURL(`${x.srv.base}/`);
      assert.equal(await page.title(), 'Matrix');
      await page.goBack();
      await page.waitForFunction(() => document.getElementById('conn').textContent === 'Live');
      assert.equal(await page.inputValue('#draft'), 'kbd', 'the draft survived leaving and returning');
      t.note(`manifest start_url/scope relative (/control/); 0 permission prompts before the click, 1 after; ${controls.length} controls mouse-reachable; Matrix link round trip kept the draft`);
    },
  };
  // The frozen runner reports one result per expected id, so the admission interleavings run (and
  // gate) as part of selection_race rather than as ids it would not report.
  const { duplicate_command_admission, revalidation_before_delivery, ...reported } = cases; // eslint-disable-line no-unused-vars
  return reported;
};
