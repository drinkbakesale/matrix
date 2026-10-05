// Evidence group: deterministic state and extractive fields, driven through
// the real hook script, the real HTTP ingestion route, the real transcript
// reader and (for the timer rules) the real reducer with an injected clock.
module.exports = (L) => {
  const { assert, fs, path } = L;

  async function setup(panes) {
    const tm = L.fakeTmux();
    const list = panes.map((p) => tm.pane(p));
    tm.setPanes(list);
    const srv = await L.startServer({ env: tm.env });
    L.hookToken(srv);
    const ctl = srv.token('controller');
    const snap = async () => (await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data;
    const sess = async (pane) => { const s = await snap(); return s.sessions.find((x) => x.id === L.sessionId(pane)); };
    await L.until(async () => (await snap()).sessions.length === new Set(list.map((p) => p.session_id)).size, 5000, 'sessions to be collected');
    const transcript = (conv) => { const d = path.join(srv.transcripts, 'proj'); fs.mkdirSync(d, { recursive: true }); return path.join(d, `${conv}.jsonl`); };
    const fire = (pane, conv, name, extra = {}) => L.hook(srv, pane, { session_id: conv, transcript_path: transcript(conv), hook_event_name: name, ...extra });
    let seq = 1000;
    const raw = (pane, conv, name, extra = {}) => ({ v: 1, event_id: `evt-${conv}-${++seq}`, seq: extra.seq || seq, hook_event_name: name, session_id: conv, transcript_path: transcript(conv), cwd: pane.pane_current_path, pane: { server_pid: pane.pid, pane_id: pane.pane_id }, ...extra });
    const post = (body) => L.http('POST', `${srv.api}/hook`, { token: fs.readFileSync(path.join(srv.home, 'eink', 'hook-token'), 'utf8').trim(), body });
    return { tm, srv, list, ctl, snap, sess, transcript, fire, raw, post };
  }
  const jl = (o) => JSON.stringify(o) + '\n';
  const userRec = (text) => jl({ type: 'user', isSidechain: false, uuid: `u-${text.length}`, message: { role: 'user', content: text } });
  const asstRec = (id, blocks, extra = {}) => jl({ type: 'assistant', isSidechain: false, uuid: `a-${id}`, message: { id, role: 'assistant', content: blocks }, ...extra });
  const text = (t) => ({ type: 'text', text: t });

  // A14-1: a transcript read that ends inside a multi-byte character must not damage it. Driven through the
  // production collector (polls while working), reducer, final digest, and the RM client's rendered digest.
  async function splitCharacters(t) {
    const tm = L.fakeTmux(); const p = tm.pane({}); tm.setPanes([p]);
    const srv = await L.startServer({ env: tm.env, tls: true });
    L.hookToken(srv);
    const ctl = srv.token('controller'); const sid = L.sessionId(p);
    const sess = async () => ((await L.http('GET', `${srv.api}/snapshot`, { token: ctl })).data.sessions.find((q) => q.id === sid));
    await L.until(sess, 5000, 'the session to be collected');
    assert.equal((await L.http('POST', `${srv.api}/select`, { token: ctl, body: { session_id: sid, base_revision: 1 } })).status, 200);
    const conv = 'conv-utf8-split-01';
    const file = path.join(srv.transcripts, 'proj', `${conv}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '');
    const fire = (name, extra = {}) => L.hook(srv, p, { session_id: conv, transcript_path: file, hook_event_name: name, ...extra });
    const client = await L.startClient({ endpoints: [srv.endpoint()], token: srv.token('device') });
    const polls = () => L.wait(400); // at least two collector polls (every 150ms) while the session is working
    const finish = async (body, what) => {
      fire('Stop', { stop_hook_active: false }); // no last_assistant_message: the text can only come from the transcript
      const s = await sess();
      assert.deepEqual([s.state, s.message.available, s.message.text, s.message.reason], ['done', true, body, ''], `${what}: the final digest is the exact source text`);
      const d = await client.waitDump((q) => (q.visible.digest || '').includes(body), 6000, `the RM2 to render ${JSON.stringify(body)} (${what})`);
      assert.ok(!d.visible.digest.includes('\uFFFD'), `${what}: no replacement character is rendered`);
    };
    let n = 0; let previous = null; const seen = [];
    for (const [ch, source] of [['é', 'Complete café response'], ['✓', 'Checked ✓ twice'], ['😀', 'Smile 😀 end']]) {
      const width = Buffer.byteLength(ch);
      for (let k = 1; k < width; k++) {
        n += 1;
        const body = `${source} #${n}`; const prompt = `split turn ${n}`;
        fire('UserPromptSubmit', { prompt });
        const rec = Buffer.from(asstRec(`m-split-${n}`, [text(body)]));
        const cut = rec.indexOf(Buffer.from(ch)) + k; // the record stops k bytes into the character
        fs.appendFileSync(file, Buffer.concat([Buffer.from(userRec(prompt)), rec.subarray(0, cut)]));
        await polls();
        const s = await sess();
        assert.equal(s.state, 'working');
        if (previous === null) assert.equal(s.message.available, false, 'nothing is shown from a partial record');
        else assert.deepEqual([s.message.available, s.message.text], [true, previous], 'the preceding complete message is intact while the new record is partial');
        fs.appendFileSync(file, rec.subarray(cut));
        await finish(body, `${width}-byte ${ch} split after byte ${k}`);
        previous = body; seen.push(`${width}b@${k}`);
      }
    }
    // Successive one-byte appends across all three characters, with polls that find no growth in between.
    const body = 'A é ✓ 😀 Z'; const rec = Buffer.from(asstRec('m-bytewise', [text(body)]));
    const from = rec.indexOf(Buffer.from('é')); const to = rec.indexOf(Buffer.from('😀')) + 4;
    fire('UserPromptSubmit', { prompt: 'bytewise' });
    fs.appendFileSync(file, Buffer.concat([Buffer.from(userRec('bytewise')), rec.subarray(0, from)]));
    for (let i = from; i < to; i++) { fs.appendFileSync(file, rec.subarray(i, i + 1)); await L.wait(i % 3 === 0 ? 500 : 200); }
    assert.equal((await sess()).message.text, previous, 'still the preceding message after byte-by-byte growth of a partial record');
    fs.appendFileSync(file, rec.subarray(to));
    await finish(body, `${to - from} one-byte appends`);
    // Pending bytes do not leak into a truncated or replaced file; invalid bytes are reported, not shown.
    const { createTranscriptReader } = require(path.join(L.candidate, 'server/lib/eink/transcript'));
    for (const how of ['truncated', 'replaced']) {
      const f = path.join(L.tmp('transcript'), 't.jsonl');
      const old = Buffer.from(asstRec('old', [text(`${'x'.repeat(300)} café`)]));
      fs.writeFileSync(f, Buffer.concat([Buffer.from(userRec('p1')), old.subarray(0, old.indexOf(Buffer.from('é')) + 1)]));
      const r = createTranscriptReader({ path: f });
      r.poll();
      assert.equal(r.view().hasPartialLine, true, 'the cut record is pending');
      const fresh = userRec('p2') + asstRec('new', [text('new ✓ text')]);
      if (how === 'replaced') { fs.writeFileSync(`${f}.new`, fresh); fs.renameSync(`${f}.new`, f); } else { fs.truncateSync(f, 0); fs.writeFileSync(f, fresh); }
      r.poll();
      const v = r.view();
      assert.deepEqual([v.prompt, v.assistantText, v.malformed, v.hasPartialLine], ['p2', 'new ✓ text', 0, false], `${how}: the pending byte did not leak into the new contents`);
      assert.match(v.error, new RegExp(how), `${how} is still reported`);
    }
    const bad = path.join(L.tmp('transcript'), 'bad.jsonl');
    fs.writeFileSync(bad, Buffer.concat([Buffer.from(userRec('p')), Buffer.from([0x7b, 0xff, 0xfe, 0x0a])]));
    const rb = createTranscriptReader({ path: bad }); rb.poll();
    assert.deepEqual([rb.view().malformed, /not valid UTF-8/.test(rb.view().error), rb.view().assistantText], [1, true, null], 'a complete line that is not UTF-8 is reported as malformed');
    t.note(`UTF-8 across polls: ${seen.join(' ')} and ${to - from} one-byte appends → exact text in the final digest and on the RM2, preceding message intact while partial; truncation/replacement drop pending bytes; invalid UTF-8 reported`);
  }

  return {
    async full_turn(t) {
      const x = await setup([{}]);
      const [p] = x.list;
      const conv = 'conv-fullturn-01';
      const prompt = 'Fix the parser\nplease — keep "quotes" & <tags>';
      x.fire(p, conv, 'UserPromptSubmit', { prompt });
      let s = await x.sess(p);
      assert.equal(s.state, 'working', 'working after the prompt');
      assert.equal(s.prompt.text, prompt, 'prompt preserved exactly');
      assert.equal(s.message.available, false, 'no message is claimed before a turn has ended');

      const final = asstRec('m2', [text('Done: parser fixed.\n\nSecond paragraph.')]);
      const half = final.slice(0, 60); // a record still being written: no trailing newline
      fs.writeFileSync(x.transcript(conv), userRec(prompt)
        + asstRec('m1', [text('Looking at the parser now'), { type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: '/w/a.js', content: 'SECRET TOOL JSON' } }])
        + jl({ type: 'assistant', isSidechain: true, uuid: 'side', message: { id: 's1', role: 'assistant', content: [text('SUBAGENT TEXT')] } })
        + half);
      x.fire(p, conv, 'PreToolUse', { tool_name: 'Write', tool_use_id: 'tu1', tool_input: { file_path: '/w/a.js', content: 'SECRET TOOL JSON' } });
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Write', tool_use_id: 'tu1', tool_input: { file_path: '/w/a.js' }, tool_response: { success: true } });
      x.fire(p, conv, 'PreToolUse', { tool_name: 'Read', tool_use_id: 'tu2', tool_input: { file_path: '/w/b.js' } });
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Read', tool_use_id: 'tu2', tool_input: { file_path: '/w/b.js' }, tool_response: 'file text' });
      x.fire(p, conv, 'SubagentStop', { last_assistant_message: 'SUBAGENT TEXT' });
      s = await x.sess(p);
      assert.equal(s.state, 'working', 'still working before Stop (tool and subagent events do not end the turn)');
      assert.equal(s.message.available, false, 'partial/tool/subagent content is never shown as the message');
      assert.deepEqual(s.files.tool.entries.map((e) => e.path), ['/w/a.js'], 'only the successful write is a changed file; Read is not');

      fs.appendFileSync(x.transcript(conv), final.slice(60)); // the record completes
      x.fire(p, conv, 'Stop', { stop_hook_active: false });
      s = await x.sess(p);
      assert.equal(s.state, 'done', 'done only at the main-agent Stop');
      assert.equal(s.message.text, 'Done: parser fixed.\n\nSecond paragraph.', 'last complete main-agent message, exact');
      for (const bad of ['SUBAGENT', 'SECRET TOOL JSON', 'Looking at the parser']) assert.ok(!JSON.stringify(s).includes(bad), `${bad} must not appear`);
      assert.equal(s.prompt.text, prompt);

      // Second turn: the typed Stop field is the complete-message event; the previous message stays visible while working.
      x.fire(p, conv, 'UserPromptSubmit', { prompt: 'again' });
      s = await x.sess(p);
      assert.equal(s.state, 'working');
      assert.equal(s.message.text, 'Done: parser fixed.\n\nSecond paragraph.', 'previous complete message retained during the next turn');
      assert.deepEqual(s.files.tool, { available: true, reason: '', note: '', entries: [] }, 'known-empty changed files for the new turn');
      x.fire(p, conv, 'Stop', { last_assistant_message: 'Second answer.' });
      s = await x.sess(p);
      assert.deepEqual([s.state, s.message.text, s.prompt.text], ['done', 'Second answer.', 'again']);
      await L.cleanup();
      await splitCharacters(t);
      t.note('states working→done only at Stop; prompt/message exact; 3 forbidden strings absent; 1 write path, Read excluded');
    },

    async questions_permissions(t) {
      const x = await setup([{}]);
      const [p] = x.list;
      const conv = 'conv-question-01';
      x.fire(p, conv, 'UserPromptSubmit', { prompt: 'set it up' });
      const questions = [
        { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'server' }, { label: 'SQLite', description: 'file' }] },
        { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Search' }, { label: 'Export' }] },
      ];
      x.fire(p, conv, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: { questions } });
      let s = await x.sess(p);
      assert.equal(s.state, 'needs_input');
      assert.equal(s.question.pending, true);
      assert.ok(s.question.text.includes('Which database?') && s.question.text.includes('Which features?'), 'both question texts shown');
      assert.deepEqual(s.question.options.map((o) => `${o.key}=${o.label}`), ['1.1=Postgres — server', '1.2=SQLite — file', '2.1=Auth', '2.2=Search', '2.3=Export'], 'exact options, no invented ones');
      assert.equal(s.question.choices_available, true);
      // Unrelated tool activity (a parallel call, a subagent) does not resolve the pending question.
      const pendingQ = JSON.stringify(s.question);
      x.fire(p, conv, 'PreToolUse', { tool_name: 'Read', tool_use_id: 'other-read-1', tool_input: { file_path: '/w/x.js' } });
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Read', tool_use_id: 'other-read-1', tool_input: { file_path: '/w/x.js' }, tool_response: 'x' });
      x.fire(p, conv, 'PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'other-bash-1', tool_input: { command: 'false' }, error: 'exit 1' });
      x.fire(p, conv, 'SubagentStop', { last_assistant_message: 'sub done' });
      s = await x.sess(p);
      assert.equal(s.state, 'needs_input', 'still waiting on the question after unrelated tool completions');
      assert.equal(JSON.stringify(s.question), pendingQ, 'same pending id, text and options');
      x.fire(p, conv, 'PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask1', tool_input: { questions }, tool_response: { answers: {} } });
      s = await x.sess(p);
      assert.deepEqual([s.state, s.question.pending], ['working', false], 'answering clears the question');

      // Permission prompt: choices come from the terminal, never from permission_suggestions.
      x.tm.setCapture(p.pane_id, [' Bash command', '', '   rm -rf build', '', ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for rm commands", '   3. No, and tell Claude what to do differently (esc)', ''].join('\n'));
      x.fire(p, conv, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'rm -rf build' } });
      x.fire(p, conv, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'SUGGESTED-RULE' }], behavior: 'allow', destination: 'localSettings' }] });
      s = await L.until(async () => { const v = await x.sess(p); return v.question.choices_available ? v : null; }, 4000, 'terminal choices to be read');
      assert.equal(s.state, 'needs_input');
      assert.equal(s.question.kind, 'permission');
      assert.deepEqual(s.question.options, [{ key: '1', label: 'Yes' }, { key: '2', label: "Yes, and don't ask again for rm commands" }, { key: '3', label: 'No, and tell Claude what to do differently (esc)' }]);
      assert.ok(!JSON.stringify(s).includes('SUGGESTED-RULE'), 'permission suggestions are not advertised as choices');
      assert.ok(s.question.text.includes('Do you want to proceed?'));
      // Unrelated completions, and another Bash call that is not the one waiting, leave the permission prompt pending.
      const pendingP = JSON.stringify(s.question);
      x.fire(p, conv, 'PreToolUse', { tool_name: 'Grep', tool_use_id: 'other-grep-1', tool_input: { pattern: 'x' } });
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Grep', tool_use_id: 'other-grep-1', tool_input: { pattern: 'x' }, tool_response: 'x' });
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'b0-earlier', tool_input: { command: 'ls' }, tool_response: {} });
      s = await x.sess(p);
      assert.equal(s.state, 'needs_input', 'still waiting on the permission after unrelated tool completions');
      assert.equal(JSON.stringify(s.question), pendingP, 'same pending permission id and terminal options');
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'rm -rf build' }, tool_response: {} });
      s = await x.sess(p);
      assert.deepEqual([s.state, s.question.pending], ['working', false], 'tool completion resolves the permission prompt');

      // Unknown terminal layout: choices are unavailable, with a reason; nothing invented.
      x.tm.setCapture(p.pane_id, 'A brand new dialog\n  [a] Maybe   [b] Perhaps\n');
      x.fire(p, conv, 'PreToolUse', { tool_name: 'Write', tool_use_id: 'w9', tool_input: { file_path: '/w/z' } });
      x.fire(p, conv, 'PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/w/z' } });
      await L.wait(500);
      s = await x.sess(p);
      assert.equal(s.state, 'needs_input');
      assert.equal(s.question.choices_available, false);
      assert.deepEqual(s.question.options, []);
      assert.ok(/unavailable/i.test(s.question.reason) && s.question.reason.length > 20, `reason given: ${s.question.reason}`);

      // Unknown or ambiguous ownership is never guessed: such a prompt stays pending until a turn boundary.
      x.fire(p, conv, 'UserPromptSubmit', { prompt: 'ownership cases' });
      // (a) two identical unfinished Bash uses: the request cannot be tied to one of them.
      x.fire(p, conv, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'twin-1', tool_input: { command: 'make' } });
      x.fire(p, conv, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'twin-2', tool_input: { command: 'make' } });
      x.fire(p, conv, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'make' } });
      const ambiguousId = (await x.sess(p)).question.id;
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'twin-2', tool_input: { command: 'make' }, tool_response: {} });
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'twin-1', tool_input: { command: 'make' }, tool_response: {} });
      s = await x.sess(p);
      assert.deepEqual([s.state, s.question.pending, s.question.id], ['needs_input', true, ambiguousId], 'ambiguous owner: same-name completions do not resolve the prompt');
      x.fire(p, conv, 'Stop', { last_assistant_message: 'done' });
      assert.deepEqual([(await x.sess(p)).state, (await x.sess(p)).question.pending], ['done', false], 'the turn boundary resolves it');
      // (b) a request with no matching started tool use at all (different input): owner unknown.
      x.fire(p, conv, 'UserPromptSubmit', { prompt: 'ownership cases 2' });
      x.fire(p, conv, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'solo-1', tool_input: { command: 'ls' } });
      x.fire(p, conv, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/other' } });
      const unknownId = (await x.sess(p)).question.id;
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'solo-1', tool_input: { command: 'ls' }, tool_response: {} });
      x.fire(p, conv, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/other' }, tool_response: {} }); // no id at all
      s = await x.sess(p);
      assert.deepEqual([s.state, s.question.pending, s.question.id], ['needs_input', true, unknownId], 'unknown owner: a missing id or a same-name completion is never treated as a match');
      // A new turn clears the pending prompt; and nothing was ever sent to the pane (no auto-approval).
      x.fire(p, conv, 'UserPromptSubmit', { prompt: 'never mind' });
      s = await x.sess(p);
      assert.deepEqual([s.state, s.question.pending], ['working', false]);
      assert.deepEqual(x.tm.sent(), [], 'the observer never types into the pane');
      t.note('AskUserQuestion: 2 questions/5 options exact, kept across 4 unrelated events; permission: 3 terminal options, suggestion excluded, kept across 3 unrelated events; unknown layout → unavailable; ambiguous and unknown ownership stay pending until a turn boundary; 0 keys sent');
    },

    async identity_isolation(t) {
      const shared = { '@matrix_project': 'proj', pane_current_path: L.tmp('same-project') };
      const x = await setup([
        { session_id: '$1', session_name: 'proj', pane_id: '%1', ...shared },
        { session_id: '$2', session_name: 'proj-2', pane_id: '%2', ...shared },
        { session_id: '$2', session_name: 'proj-2', pane_id: '%3', ...shared },
        { session_id: '$3', session_name: 'plain', pane_id: '%4' },
      ]);
      const [a, b1, b2, plain] = x.list;
      // Interleaved records from three conversations.
      x.fire(a, 'conv-aaaaaaaa', 'UserPromptSubmit', { prompt: 'PROMPT-A' });
      x.fire(b1, 'conv-bbbbbbbb', 'UserPromptSubmit', { prompt: 'PROMPT-B1' });
      x.fire(b2, 'conv-cccccccc', 'UserPromptSubmit', { prompt: 'PROMPT-B2' });
      x.fire(a, 'conv-aaaaaaaa', 'Stop', { last_assistant_message: 'ANSWER-A' });
      x.fire(b2, 'conv-cccccccc', 'Stop', { last_assistant_message: 'ANSWER-B2' });
      const sa = await x.sess(a);
      assert.deepEqual([sa.state, sa.prompt.text, sa.message.text], ['done', 'PROMPT-A', 'ANSWER-A']);
      assert.ok(!JSON.stringify(sa).includes('B1') && !JSON.stringify(sa).includes('B2'), 'no cross-session content');
      assert.notEqual(L.sessionId(a), L.sessionId(b1), 'same project, distinct session identities');

      let sb = await x.sess(b1);
      assert.equal(sb.state, 'unavailable', 'two Claude panes: no guess');
      assert.deepEqual(sb.ambiguous_panes.sort(), ['%2', '%3']);
      assert.equal(sb.prompt.available, false);
      assert.ok(/choose one/i.test(sb.state_reason));
      const sel = (await x.snap()).selection;
      let r = await L.http('POST', `${x.srv.api}/select`, { token: x.ctl, body: { session_id: sb.id, base_revision: sel.revision } });
      assert.equal(r.status, 200);
      r = await L.http('PUT', `${x.srv.api}/draft`, { token: x.ctl, body: { session_id: sb.id, text: 'hello', revision: 1 } });
      r = await L.http('POST', `${x.srv.api}/submit`, { token: x.ctl, body: { session_id: sb.id, selection_revision: r.status === 200 ? (await x.snap()).selection.revision : 0, draft_revision: 1, idempotency_id: 'ambiguous-submit-1' } });
      assert.equal(r.status, 409, 'an ambiguous session cannot receive commands');

      r = await L.http('POST', `${x.srv.api}/bind`, { token: x.ctl, body: { session_id: sb.id, pane_id: '%3' } });
      assert.equal(r.status, 200);
      sb = await x.sess(b1);
      assert.deepEqual([sb.state, sb.prompt.text, sb.message.text, sb.pane_id], ['done', 'PROMPT-B2', 'ANSWER-B2', '%3'], 'explicit pane choice followed; other pane not mixed in');

      const sp = await x.sess(plain);
      assert.equal(sp.state, 'unavailable');
      assert.ok(/No Claude evidence/.test(sp.state_reason));
      const sel2 = (await x.snap()).selection;
      await L.http('POST', `${x.srv.api}/select`, { token: x.ctl, body: { session_id: sp.id, base_revision: sel2.revision } });
      await L.http('PUT', `${x.srv.api}/draft`, { token: x.ctl, body: { session_id: sp.id, text: 'hello', revision: 1 } });
      r = await L.http('POST', `${x.srv.api}/submit`, { token: x.ctl, body: { session_id: sp.id, selection_revision: (await x.snap()).selection.revision, draft_revision: 1, idempotency_id: 'unbound-submit-1' } });
      assert.equal(r.status, 409, 'an unbound session cannot receive commands');
      assert.deepEqual(x.tm.sent(), [], 'nothing was sent anywhere');
      t.note('3 conversations interleaved across 3 panes/2 same-project sessions: 0 cross-contamination; ambiguous and unbound → unavailable + 409');
    },

    async corruption_unknown(t) {
      const x = await setup([{ session_id: '$1', pane_id: '%1' }, { session_id: '$2', session_name: 'nohook', pane_id: '%2' }]);
      const [p, nohook] = x.list;
      const outcomes = [];
      const turn = async (name, conv, prepare, check) => {
        x.fire(p, conv, 'UserPromptSubmit', { prompt: `turn ${name}` });
        await prepare(x.transcript(conv));
        x.fire(p, conv, 'Stop', {});
        const s = await x.sess(p);
        assert.equal(s.state, 'done', `${name}: state comes from hook evidence, not from a damaged transcript`);
        assert.equal(s.prompt.text, `turn ${name}`);
        check(s);
        assert.equal(s.message.available === false ? s.message.text : 'x', s.message.available === false ? '' : 'x', `${name}: an unavailable field carries no fabricated text`);
        outcomes.push(`${name}:${s.message.available ? 'available' : 'unavailable(' + s.message.reason + ')'}`);
      };
      const unavailable = (re) => (s) => { assert.equal(s.message.available, false); assert.match(s.message.reason, re); };

      await turn('missing', 'conv-missing-01', async () => {}, unavailable(/missing/));
      await turn('malformed', 'conv-malformed-1', async (f) => fs.writeFileSync(f, userRec('turn malformed') + '{this is not json}\n' + asstRec('m', [text('after damage')])), unavailable(/malformed/));
      await turn('unsupported', 'conv-unsupported', async (f) => fs.writeFileSync(f, userRec('turn unsupported') + jl({ type: 'assistant', message: { id: 'q', role: 'assistant', content: 'a bare string body' } })), unavailable(/unsupported transcript schema/));
      await turn('partial', 'conv-partial-001', async (f) => fs.writeFileSync(f, userRec('turn partial') + asstRec('m', [text('PARTIAL-ONLY')]).slice(0, -12)), (s) => { assert.equal(s.message.available, false); assert.ok(!JSON.stringify(s).includes('PARTIAL-ONLY')); assert.match(s.message.reason, /no text message/); });
      await turn('unreadable', 'conv-unreadable-', async (f) => { fs.writeFileSync(f, userRec('x') + asstRec('m', [text('HIDDEN')])); fs.chmodSync(f, 0o000); }, unavailable(/unreadable/));
      fs.chmodSync(x.transcript('conv-unreadable-'), 0o600);

      // Truncated and replaced: the reader has already read the file once.
      const conv = 'conv-truncate-01';
      await turn('first-read', conv, async (f) => fs.writeFileSync(f, userRec('turn first-read') + asstRec('m1', [text('A fairly long first answer that will be cut off later')])), (s) => assert.equal(s.message.text, 'A fairly long first answer that will be cut off later'));
      await turn('truncated', conv, async (f) => fs.writeFileSync(f, userRec('t')), unavailable(/truncated/));
      await turn('replaced', conv, async (f) => { fs.writeFileSync(f + '.new', userRec('turn replaced, a new file that is longer than before') + asstRec('m9', [text('x')]).slice(0, 5)); fs.renameSync(f + '.new', f); }, unavailable(/replaced/));
      await turn('recovered', conv, async (f) => fs.appendFileSync(f, '\n' + userRec('turn recovered') + asstRec('m3', [text('Clean again.')])), (s) => assert.equal(s.message.text, 'Clean again.'));

      // Missing hook: explicit reason, known-empty files are a different thing from unavailable files.
      const sn = await x.sess(nohook);
      assert.deepEqual([sn.state, sn.prompt.available, sn.files.tool.available], ['unavailable', false, false]);
      assert.ok(sn.state_reason.length > 20);
      const sp = await x.sess(p);
      assert.deepEqual([sp.files.tool.available, sp.files.tool.entries.length], [true, 0], 'known empty set is available and empty');

      // Collector failure: explicit error, sessions are kept, never an empty success.
      x.tm.set('listfail.json', { message: 'lost connection to tmux server' });
      const bad = await L.until(async () => { const s = await x.snap(); return s.collector.ok ? null : s; }, 4000, 'collector error to surface');
      assert.match(bad.collector.error, /lost connection/);
      assert.equal(bad.sessions.length, 2, 'the list is not emptied by a collector failure');
      assert.equal(bad.sessions.find((s) => s.id === L.sessionId(p)).state, 'done');
      t.note(`${outcomes.length} transcript cases: ${outcomes.join('; ')}; collector failure kept 2 sessions with explicit error`);
    },

    async stuck_rules(t) {
      const tm = L.fakeTmux();
      const pane = tm.pane({});
      tm.setPanes([pane]);
      let now = 1_000_000;
      const home = L.tmp('inproc');
      const { build } = require(path.join(L.candidate, 'server/lib/eink'));
      const sys = build({ home, now: () => now, tmuxBin: tm.bin, sendPush: async () => {}, vapidReady: () => true, transcriptRoot: home });
      process.env.FAKE_TMUX_DIR = tm.dir;
      await sys.evidence.collect();
      let n = 0;
      const ev = (name, extra = {}) => sys.evidence.ingest({ v: 1, event_id: `stuck-evt-${++n}`, seq: now + n / 1000, hook_event_name: name, session_id: 'conv-stuck-0001', cwd: home, pane: { server_pid: pane.pid, pane_id: pane.pane_id }, ...extra });
      const state = () => sys.service.snapshot().sessions[0];
      const t0 = now;
      await ev('UserPromptSubmit', { prompt: 'long job' });
      now = t0 + 599999; await sys.evidence.tick();
      assert.equal(state().state, 'working', 'working at 599999ms');
      now = t0 + 600000; await sys.evidence.tick();
      assert.deepEqual([state().state, state().state_reason], ['stuck', 'No progress observed for 10 minutes'], 'stuck at exactly 600000ms with the plain reason');
      // Tool progress resets the deadline (and un-sticks a no-progress stuck).
      now = t0 + 700000; await ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'x1' });
      assert.equal(state().state, 'working', 'progress resumes working');
      now = t0 + 700000 + 599999; await sys.evidence.tick();
      assert.equal(state().state, 'working', 'deadline restarted from the progress event');
      now += 1; await sys.evidence.tick();
      assert.equal(state().state, 'stuck');
      // needs_input never times out.
      await ev('UserPromptSubmit', { prompt: 'q' });
      await ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'a1', tool_input: { questions: [{ question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }] } });
      now += 5 * 3600 * 1000; await sys.evidence.tick();
      assert.equal(state().state, 'needs_input', 'needs_input does not time out');
      // done never times out.
      await ev('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'a1' });
      await ev('Stop', { last_assistant_message: 'ok' });
      now += 5 * 3600 * 1000; await sys.evidence.tick();
      assert.equal(state().state, 'done', 'done does not time out');
      // Explicit error ends the turn as stuck.
      await ev('UserPromptSubmit', { prompt: 'again' });
      await ev('StopFailure', { error: 'rate_limit' });
      assert.equal(state().state, 'stuck');
      assert.match(state().state_reason, /rate_limit/);
      // A disconnect of every display changes nothing.
      await ev('UserPromptSubmit', { prompt: 'third' });
      const drop = sys.service.addClient(() => {});
      drop();
      await sys.evidence.tick();
      assert.equal(state().state, 'working', 'client disconnect never changes task state');
      // The bound pane dies during a working turn.
      tm.setPanes([]);
      await sys.evidence.tick();
      const all = sys.service.st.bindings[`${pane.pid}:${pane.pane_id}`].reducer;
      assert.deepEqual([all.state, all.state_reason], ['stuck', 'The pane running Claude ended during a working turn']);
      delete process.env.FAKE_TMUX_DIR;
      t.note('fake clock: working@599999, stuck@600000, progress reset, needs_input/done no timeout (5h), StopFailure→stuck, pane death→stuck, disconnect no change');
    },

    async files_provenance(t) {
      const repo = L.tmp('repo');
      const git = (...a) => { const r = L.spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); };
      for (const f of ['old.txt', 'a.txt', 'c.txt', 'readonly.txt']) fs.writeFileSync(path.join(repo, f), f);
      git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'base');
      fs.writeFileSync(path.join(repo, 'old.txt'), 'changed before the session'); // pre-existing dirty file
      git('mv', 'a.txt', 'b.txt'); git('rm', '-q', 'c.txt');
      fs.writeFileSync(path.join(repo, 'new file.txt'), 'untracked');
      const plainDir = L.tmp('plain');
      const x = await setup([
        { session_id: '$1', pane_id: '%1', pane_current_path: repo },
        { session_id: '$2', session_name: 'nogit', pane_id: '%2', pane_current_path: plainDir },
        { session_id: '$3', session_name: 'gone', pane_id: '%3', pane_current_path: '/nonexistent-dir-for-test' },
        { session_id: '$4', session_name: 'sharer', pane_id: '%4', pane_current_path: repo },
      ]);
      const [p, nogit, gone, sharer] = x.list;
      x.fire(p, 'conv-files-0001', 'UserPromptSubmit', { prompt: 'edit' });
      fs.writeFileSync(path.join(repo, 'edited.js'), 'new');
      x.fire(p, 'conv-files-0001', 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: path.join(repo, 'edited.js') }, tool_response: {} });
      x.fire(p, 'conv-files-0001', 'PostToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: path.join(repo, 'readonly.txt') }, tool_response: 'x' });
      x.fire(p, 'conv-files-0001', 'PostToolUseFailure', { tool_name: 'Write', tool_use_id: 'f1', tool_input: { file_path: path.join(repo, 'failed.js') }, error: 'denied' });
      x.fire(nogit, 'conv-nogit-0001', 'UserPromptSubmit', { prompt: 'x' });
      x.fire(gone, 'conv-gone-00001', 'UserPromptSubmit', { prompt: 'x' });
      x.fire(sharer, 'conv-share-0001', 'UserPromptSubmit', { prompt: 'x' });
      const s = await L.until(async () => { const v = await x.sess(p); return v.files.worktree.available && /shared with/.test(v.files.worktree.note || '') ? v : (x.fire(p, 'conv-files-0001', 'PostToolUse', { tool_name: 'Bash', tool_use_id: `n${Date.now()}` }), null); }, 6000, 'worktree to be collected with the shared note');
      assert.deepEqual(s.files.tool.entries, [{ status: 'W', path: path.join(repo, 'edited.js') }], 'observed tool paths: the successful Edit only (no Read, no failed Write)');
      const wt = Object.fromEntries(s.files.worktree.entries.map((e) => [e.path, e.status]));
      assert.deepEqual(wt, { 'old.txt': 'M', 'a.txt -> b.txt': 'R', 'c.txt': 'D', 'new file.txt': '??', 'edited.js': '??' }, 'staged, unstaged, renamed, deleted and untracked all listed; none lost');
      assert.match(s.files.worktree.note, /shared with .*cannot be attributed/, 'shared ownership is labelled');
      const sn = await x.sess(nogit);
      assert.deepEqual([sn.files.worktree.available, sn.files.worktree.reason], [false, 'not a Git repository']);
      const sg = await L.until(async () => { const v = await x.sess(gone); return /git failed/.test(v.files.worktree.reason) ? v : null; }, 4000, 'git failure to be labelled');
      assert.equal(sg.files.worktree.available, false);
      t.note(`tool paths 1 (Edit); worktree 5 entries ${JSON.stringify(wt)}; non-Git, git failure and shared worktree each labelled`);
    },

    async replay_order(t) {
      const x = await setup([{}]);
      const [p] = x.list;
      const c1 = 'conv-replay-0001';
      const ok = async (body) => { const r = await x.post(body); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
      const turnOf = () => JSON.parse(fs.readFileSync(path.join(x.srv.home, 'eink', 'state.json'), 'utf8')).bindings[`${p.pid}:${p.pane_id}`].reducer.turn;
      const first = x.raw(p, c1, 'UserPromptSubmit', { prompt: 'same text', seq: 10 });
      await ok(first); await ok(first); await ok({ ...first }); // exact duplicates
      assert.equal(turnOf(), 1, 'a duplicated hook event is applied once');
      await ok(x.raw(p, c1, 'Stop', { last_assistant_message: 'ANSWER-1', seq: 30 }));
      // Out of order: events from before the Stop arrive late.
      await ok(x.raw(p, c1, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'late-q', tool_input: { questions: [{ question: 'LATE?', options: [{ label: 'a' }, { label: 'b' }] }] }, seq: 25 }));
      await ok(x.raw(p, c1, 'PostToolUse', { tool_name: 'Write', tool_use_id: 'late-w', tool_input: { file_path: '/w/late.js' }, seq: 20 }));
      await ok(x.raw(p, c1, 'UserPromptSubmit', { prompt: 'OLD PROMPT', seq: 5 }));
      let s = await x.sess(p);
      assert.deepEqual([s.state, s.prompt.text, s.message.text, s.question.pending], ['done', 'same text', 'ANSWER-1', false], 'late events cannot regress state, prompt, message or question');
      assert.deepEqual(s.files.tool.entries.map((e) => e.path), ['/w/late.js'], 'a late successful write from this turn is still recorded');
      // The same text again is a genuinely new turn.
      await ok(x.raw(p, c1, 'UserPromptSubmit', { prompt: 'same text', seq: 40 }));
      s = await x.sess(p);
      assert.deepEqual([turnOf(), s.state, s.message.text], [2, 'working', 'ANSWER-1']);
      await ok(x.raw(p, c1, 'Stop', { last_assistant_message: 'ANSWER-2', seq: 50 }));
      // Resume of the same conversation keeps everything.
      await ok(x.raw(p, c1, 'SessionStart', { source: 'resume', seq: 60 }));
      s = await x.sess(p);
      assert.deepEqual([s.state, s.prompt.text, s.message.text], ['done', 'same text', 'ANSWER-2'], 'resume preserves the digest');
      // A new conversation in the pane replaces the binding; the old one can no longer write.
      const c2 = 'conv-replay-0002';
      await ok(x.raw(p, c2, 'SessionStart', { source: 'clear', seq: 70 }));
      await ok(x.raw(p, c2, 'UserPromptSubmit', { prompt: 'NEW CONVERSATION', seq: 80 }));
      const old = await ok(x.raw(p, c1, 'UserPromptSubmit', { prompt: 'FROM OLD EPOCH', seq: 65 }));
      assert.equal(old.ignored, 'older conversation');
      s = await x.sess(p);
      assert.deepEqual([s.state, s.prompt.text], ['working', 'NEW CONVERSATION']);
      assert.equal(s.message.available, false, 'the old conversation\'s message does not leak into the new one');
      // Reload from disk: same state after a server restart.
      const before = JSON.stringify([s.state, s.prompt, s.message, s.question]);
      await x.srv.stop();
      const again = await L.startServer({ home: x.srv.home, env: x.tm.env });
      const ctl = again.token('controller');
      const s2 = await L.until(async () => { const d = (await L.http('GET', `${again.api}/snapshot`, { token: ctl })).data; const v = d.sessions.find((q) => q.id === L.sessionId(p)); return v && v.state !== 'unavailable' ? v : null; }, 5000, 'state after restart');
      assert.equal(JSON.stringify([s2.state, s2.prompt, s2.message, s2.question]), before, 'persisted state reloads identically');
      t.note('duplicate x3 → 1 turn; 3 late events ignored for state (late write kept); same-text new turn → turn 2; resume kept; old conversation ignored; restart identical');
    },
  };
};
