// Brief:: acceptance cases — the pinned view on both clients, refresh and per-field edits,
// and cross-session isolation plus the truthful failure states.

import { emit, saveArtifact, announceStreamTarget, emptyWindowBindingCases } from './browser-support.mjs';
import {
  control, waitForControl, setPageClock,
  settleAndRefresh, waitForBrief, readBrief, openClient, editField, expectAge,
} from './browser-server.mjs';

export const F1 = { goal: 'improve copy generation quality', current: 'add a judging step to compare candidate copy' };
export const F2 = { goal: 'improve copy generation quality', current: 'fix inconsistent score normalization' };
export const F3 = { goal: 'reliable inventory tracking', current: 'repair barcode import validation' };

export async function pinnedBothClients(ctx, t) {
  const boxes = {};
  for (const kind of ['mobile', 'desktop']) {
    // A genuinely unseen session: earlier cases shared this store, so start a fresh incarnation to observe
    // the real first-open state rather than a warm cache. The generator is held slow so the pending state is
    // observed deterministically instead of racing a fast extractor.
    await fetch(`${ctx.origin}/__control/reincarnate?session=A`);
    await fetch(`${ctx.origin}/__control/mode?mode=slow`);
    const { context, page } = await openClient(ctx, kind);
    const initial = await readBrief(page);
    t.eq(['loading', 'generating'].includes(initial.status) ? 'pending' : initial.status, 'pending',
      `${kind}: an unseen brief first says it is generating`);
    t.ok(!initial.goal.includes('shared-project') && !initial.goal.includes('fixture'),
      `${kind}: the placeholder is never invented from the project name`);
    await fetch(`${ctx.origin}/__control/mode?mode=ok`);

    await settleAndRefresh(page);
    const brief = await readBrief(page);
    t.eq(brief.status, 'ok', `${kind}: the brief resolves`);
    t.eq(brief.goal, F1.goal, `${kind}: sentence 1 is the project goal from the session's own pane`);
    t.eq(brief.current, F1.current, `${kind}: sentence 2 is what this session is doing now`);
    t.includes(brief.age, 'updated', `${kind}: freshness is shown`);

    await emit(page, 'output', Array.from({ length: 200 }, (_, i) => `scroll filler ${i}`).join('\n') + '\n');
    await page.waitForTimeout(100);
    // The browser CLAMPS scrollTop to scrollHeight - clientHeight, so ASKING for 1.5 viewports is not
    // evidence that 1.5 viewports were travelled: with a short transcript the request silently becomes a few
    // pixels. Measure what actually moved, in whichever direction has room — the transcript is normally
    // already following the bottom when the filler lands, so the room is upwards.
    const layout = await page.evaluate(() => {
      const viewer = document.getElementById('terminal');
      const startTop = viewer.scrollTop;
      const clientHeight = viewer.clientHeight;
      const maxTop = viewer.scrollHeight - clientHeight;
      const down = Math.min(maxTop, startTop + clientHeight * 1.5);
      const up = Math.max(0, startTop - clientHeight * 1.5);
      viewer.scrollTop = Math.abs(down - startTop) >= Math.abs(startTop - up) ? down : up;
      viewer.dispatchEvent(new Event('scroll'));
      const b = document.getElementById('brief').getBoundingClientRect();
      const v = viewer.getBoundingClientRect();
      const copy = document.getElementById('copy-open').getBoundingClientRect();
      const input = (document.getElementById('text-input') || document.getElementById('chat-input')).getBoundingClientRect();
      return {
        brief: { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom },
        viewer: { y: v.y, bottom: v.bottom, height: v.height, scrollTop: viewer.scrollTop },
        copy: { y: copy.y, height: copy.height, bottom: copy.bottom },
        input: { y: input.y, height: input.height },
        innerHeight: window.innerHeight,
        scroll: { startTop, clientHeight, maxTop, endTop: viewer.scrollTop, moved: Math.abs(viewer.scrollTop - startTop) },
      };
    });
    boxes[kind] = layout;
    const { moved, clientHeight, maxTop } = layout.scroll;
    t.ok(maxTop >= clientHeight,
      `${kind}: the transcript holds more than one viewport of scrollable content (${Math.round(maxTop)}px of travel, viewport ${Math.round(clientHeight)}px)`);
    t.ok(moved >= clientHeight,
      `${kind}: the transcript actually scrolled by at least one viewport (moved ${Math.round(moved)}px, viewport ${Math.round(clientHeight)}px)`);
    t.ok(layout.brief.y >= 0 && layout.brief.bottom <= layout.innerHeight + 1, `${kind}: the brief stays inside the viewport while the transcript scrolls`);
    t.ok(layout.brief.bottom <= layout.viewer.y + 1, `${kind}: the brief is pinned above the transcript, not inside it`);
    t.ok(layout.copy.bottom <= layout.viewer.y + 1 && layout.copy.height > 0, `${kind}: the copy control is visible and does not overlap the transcript`);
    t.ok(layout.brief.bottom <= layout.input.y, `${kind}: the brief never covers the input`);

    await page.click('#brief-toggle');
    t.eq(await page.isVisible('#brief-body'), false, `${kind}: the brief collapses`);
    t.eq(await page.getAttribute('#brief-toggle', 'aria-expanded'), 'false', `${kind}: the collapsed state is announced`);
    await page.click('#brief-toggle');
    t.eq(await page.isVisible('#brief-body'), true, `${kind}: the brief expands again`);

    await page.focus('#brief-edit-goal');
    await page.keyboard.press('Enter');
    t.ok(await page.isVisible('#brief-input-goal'), `${kind}: the edit control is reachable and usable from the keyboard`);
    await page.keyboard.press('Escape');

    await page.screenshot({ path: `${ctx.artifactDir}/brief-${kind}.png` });

    // What the user actually reads for freshness, on BOTH clients. A failed refresh first
    // opens a gap between the two timestamps, because while they are equal no assertion
    // about the age line can tell which of them the renderer used.
    await fetch(`${ctx.origin}/__control/mode?mode=fail`);
    await fetch(`${ctx.origin}/__control/pane?session=A&pane=${encodeURIComponent(ctx.panes.f2)}`);
    await fetch(`${ctx.origin}/__control/advance?ms=31000`);
    await settleAndRefresh(page);
    const aged = await readBrief(page);
    t.eq(aged.generatedAt, brief.generatedAt, `${kind}: the failed refresh leaves the last successful generation in place`);
    t.ok(aged.evidenceAt > aged.generatedAt, `${kind}: and moves source freshness ahead of it (${aged.generatedAt} -> ${aged.evidenceAt})`);
    await expectAge(page, t, { at: aged.generatedAt + 600000, expected: 'updated 10 min ago', label: `${kind}: ten minutes after it` });
    await expectAge(page, t, { at: aged.generatedAt + 7200000, expected: 'updated 2 h ago', label: `${kind}: two hours after it` });
    // Hand the shared fixture back in a generated state: a recorded failure also arms the
    // service's retry backoff, which would otherwise silence the next case's first poll.
    await fetch(`${ctx.origin}/__control/mode?mode=ok`);
    await fetch(`${ctx.origin}/__control/pane?session=A&pane=${encodeURIComponent(ctx.panes.f1)}`);
    await fetch(`${ctx.origin}/__control/advance?ms=120000`);
    await settleAndRefresh(page);
    t.eq((await readBrief(page)).stale, false,
      `${kind}: the injected failure is cleared before the next case sees the fixture`);
    await context.close();
  }
  saveArtifact(ctx.artifactDir, 'brief-layout.json', boxes);
  t.note('briefLayout', boxes);
}

export async function updatesAndOverrides(ctx, t) {
  const { context, page } = await openClient(ctx, 'mobile');
  await settleAndRefresh(page);
  const first = await readBrief(page);
  t.eq(first.current, F1.current, 'the brief starts on fixture f1');

  // f1 → f2 with no change of session name, and NOTHING here asks the view to refresh: the
  // change has to arrive through the client's own polling, inside its configured interval.
  const pollMs = await page.evaluate(() => briefView.pollIntervalMs);
  t.ok(pollMs > 0 && pollMs <= 30000, `the client polls on a bounded configured interval (${pollMs}ms)`);
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f2 });
  await control(page, 'advance', { ms: 31000 });
  const polled = await waitForBrief(page, b => b.current === F2.current, pollMs + 3000, 'f1->f2 by polling');
  const second = polled.brief;
  t.ok(polled.elapsedMs <= pollMs + 3000,
    `current work reached the UI by client polling in ${polled.elapsedMs}ms, within the ${pollMs}ms interval plus generation`);
  t.eq(second.current, F2.current, 'current work refreshes within one evidence interval');
  t.eq(second.goal, F2.goal, 'the broad goal stays supported across the refresh');
  t.ok(second.generatedAt > first.generatedAt, 'generatedAt advances on a successful generation');
  // Different quantities, both carried: evidenceAt is source freshness, generatedAt is
  // when generation last succeeded.
  t.ok(second.evidenceAt > first.evidenceAt, `evidenceAt advances when the evidence changes (${first.evidenceAt} -> ${second.evidenceAt})`);

  // A failed refresh keeps the old text, marks it stale and does not move generatedAt.
  await control(page, 'mode', { mode: 'fail' });
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f3 });
  await control(page, 'advance', { ms: 31000 });
  await settleAndRefresh(page);
  const failed = await readBrief(page);
  t.eq(failed.current, F2.current, 'the last good text is kept when a refresh fails');
  t.eq(failed.generatedAt, second.generatedAt, 'the generation time does not move on failure');
  // Where they visibly come apart: the source moved on, the last success did not.
  t.ok(failed.evidenceAt > second.evidenceAt, `source freshness still advances on a failed refresh (${second.evidenceAt} -> ${failed.evidenceAt})`);
  t.ok(failed.evidenceAt !== failed.generatedAt, 'and evidenceAt is then not an echo of generatedAt');
  t.eq(failed.stale, true, 'the kept text is labelled stale');
  t.includes(failed.note, 'refresh failed', 'the failure is visible to the user');
  // AFTER FAILURE the visible age must still name the last success, not the source it just
  // re-read: the whole point of the stale label is that nothing new was generated.
  await expectAge(page, t, { at: failed.generatedAt + 7200000, expected: 'updated 2 h ago', label: 'after a failed refresh' });
  await setPageClock(page, ctx.server.clock.now());
  await control(page, 'mode', { mode: 'ok' }); await control(page, 'pane', { session: 'A', pane: ctx.panes.f2 });

  // Per-field edits.
  await editField(page, 'goal', 'ship the judging step');
  let brief = await readBrief(page);
  t.eq(brief.goal, 'ship the judging step', 'the goal edit is applied');
  t.eq(brief.current, F2.current, 'editing the goal leaves the current work alone');
  await editField(page, 'current', 'hand written current work');
  brief = await readBrief(page);
  t.eq(brief.current, 'hand written current work', 'the current-work edit is applied');

  // Repeated generation cannot clobber either edit.
  await control(page, 'advance', { ms: 31000 });
  await settleAndRefresh(page);
  brief = await readBrief(page);
  t.eq(brief.goal, 'ship the judging step', 'a later generation does not clobber the goal edit');
  t.eq(brief.current, 'hand written current work', 'a later generation does not clobber the current edit');

  // Reload the page and restart the service: the edits persist.
  await page.goto(`${ctx.origin}/?open=A`);
  await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
  await settleAndRefresh(page);   // reload: the overrides must come back from storage
  brief = await readBrief(page);
  t.eq(brief.goal, 'ship the judging step', 'edits survive a page reload');
  await control(page, 'restart');
  await settleAndRefresh(page);
  brief = await readBrief(page);
  t.eq(brief.goal, 'ship the judging step', 'edits survive a service restart');
  t.eq(brief.current, 'hand written current work', 'both edits survive a service restart');

  // Clear only the current field. The evidence moves to f3 FIRST and generates underneath
  // while the override is on screen, so "restores the NEWEST generated value" differs from
  // "restores what was there when you edited" — identical strings if evidence never moves,
  // which would let a freeze-while-overridden implementation pass.
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f3 });
  await control(page, 'advance', { ms: 31000 });
  await settleAndRefresh(page);
  brief = await readBrief(page);
  t.eq(brief.current, 'hand written current work', 'the override still shows while new evidence generates underneath it');
  await page.click('#brief-clear-current');
  await page.waitForTimeout(150);
  brief = await readBrief(page);
  t.eq(brief.current, F3.current, 'clearing one override restores that field\'s NEWEST generated value, not the one the edit replaced');
  t.ok(brief.current !== F2.current, 'and specifically not the pre-edit value');
  t.eq(brief.goal, 'ship the judging step', 'clearing one override leaves the other edit in place');

  // A generation ALREADY RUNNING when a newer edit lands. Two things make it a real race:
  // the evidence moves to a fixture neither field has carried (f3 again would hit the
  // unchanged-fingerprint early return and start no job), and the generator is held at an
  // explicit boundary, so the test can see generation entered and is still pending.
  // The gate goes on BEFORE the evidence moves, so the held job is the FIRST to see the new
  // source. Changing the pane first lets the client's own 3s poll generate it ungated, after
  // which the held job re-reads identical evidence and freshness correctly does not move.
  const beforeHold = await readBrief(page);
  // Anchor the page clock to a known bucket BEFORE the hold, and leave it there across the
  // whole race: with the reader's clock standing still, any change in the age line can only
  // come from the record behind it, so "did freshness move?" becomes directly observable.
  const anchor = beforeHold.generatedAt + 600000;
  await setPageClock(page, anchor);
  t.eq((await readBrief(page)).age, 'updated 10 min ago',
    'before the held job the age line reads ten minutes since the last success');
  const enteredBefore = (await control(page, 'genstate')).entered;
  await control(page, 'gate');
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f1 });
  await control(page, 'advance', { ms: 31000 });
  const racing = await waitForControl(page, 'genstate',
    g => g.entered > enteredBefore && g.pending > 0, 8000, 'held generation');
  t.ok(racing.entered > enteredBefore, `the held generation really started (entered ${racing.entered})`);
  t.ok(racing.pending > 0, 'and is still pending at the boundary, not already finished');
  // While that job is held, the displayed freshness must still describe the LAST SUCCESS,
  // not the job in flight, even though the source it is reading has already moved on.
  // Pull the record the client is holding straight from the server — `settleAndRefresh`
  // cannot be used here because `settle` waits for the very job this case is holding open.
  await page.evaluate(() => briefView.refresh());
  await page.waitForTimeout(150);
  const pending = await readBrief(page);
  t.eq(pending.generatedAt, beforeHold.generatedAt, 'a pending generation does not advance the displayed generation time');
  t.ok(pending.evidenceAt > beforeHold.evidenceAt, `while evidenceAt already describes the changed source (${beforeHold.evidenceAt} -> ${pending.evidenceAt})`);
  // DURING the hold, on the unmoved reader clock: the age line must not have budged.
  await expectAge(page, t, { at: anchor, expected: 'updated 10 min ago', label: 'while a generation is in flight' });
  await editField(page, 'current', 'saved while the job was mid-flight');
  t.eq((await readBrief(page)).current, 'saved while the job was mid-flight', 'the edit is accepted while generation is in flight');
  t.eq((await control(page, 'genstate')).pending, 1, 'the job was still held when the edit was saved');
  // Let fixture time pass while the job is still held, so the generation it eventually
  // records is stamped later than the source it read — otherwise the two timestamps would
  // coincide on completion and the age assertion after it could not discriminate.
  await control(page, 'advance', { ms: 120000 });
  await control(page, 'ungate');
  await settleAndRefresh(page);
  brief = await readBrief(page);
  t.ok(brief.generatedAt > beforeHold.generatedAt, 'the displayed generation time advances only once the job succeeded');
  t.eq(brief.current, 'saved while the job was mid-flight', 'the completing job cannot clobber an edit saved after it started');
  t.eq(brief.generated.current, F1.current, 'but the generated value underneath did complete and update');
  // AFTER the job succeeded, with the reader's clock still on the same anchor: the age line
  // must stop reading the pre-hold generation, and must read the new one.
  t.ok((await readBrief(page)).age !== 'updated 10 min ago',
    'once the job succeeds the age line stops reading the generation it replaced');
  // The minute bucket, not the hour bucket: here the source is EARLIER than the generation
  // that read it, so an evidenceAt renderer would print a LARGER age, and only a bucket fine
  // enough to resolve the 120s gap can tell the two apart.
  await expectAge(page, t, { at: brief.generatedAt + 600000, expected: 'updated 10 min ago', label: 'after the held job completed' });
  await setPageClock(page, ctx.server.clock.now());
  await control(page, 'restart');
  await settleAndRefresh(page);
  brief = await readBrief(page);
  t.eq(brief.current, 'saved while the job was mid-flight', 'the mid-flight edit survives a service restart');
  t.eq(brief.generated.current, F1.current, 'and so does the generated value that job wrote');
  t.eq(brief.goal, 'ship the judging step', 'the other override is untouched by the race');

  // A brief refresh or collapse must not disturb an active transcript selection.
  await emit(page, 'output', 'selectable transcript text\n');
  await page.evaluate(() => {
    const node = document.querySelector('#terminal .msg');
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.__sel = String(sel);
  });
  await page.click('#brief-toggle');
  await settleAndRefresh(page);
  const selection = await page.evaluate(() => ({ before: window.__sel, after: String(window.getSelection()) }));
  t.eq(selection.after, selection.before, 'a brief collapse and refresh leaves the transcript selection intact');
  await context.close();
}

export async function isolationAndFailures(ctx, t) {
  const { context, page } = await openClient(ctx, 'mobile');
  // Start from a clean incarnation of A so earlier cases' edits do not colour this one.
  await control(page, 'reincarnate', { session: 'A' });
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f1 });
  await page.evaluate(() => openTerminal('A'));
  await settleAndRefresh(page);
  t.eq((await readBrief(page)).goal, F1.goal, 'session A starts with its own brief');

  // ---- A held HTTP response for a session the user has left ---- A's answer is computed now and written
  // only when the test releases it, so this is a genuinely in-flight response, not a simulated one.
  await control(page, 'hold', { session: 'A' });
  await page.evaluate(() => briefView.open('A', ''));          // request for A: captured, held
  await page.waitForTimeout(150);
  t.ok((await control(page, 'held', { session: 'A' })).count >= 1, 'A\'s response is genuinely in flight');
  await page.evaluate(() => openTerminal('B'));                 // B answers normally
  await settleAndRefresh(page);
  t.eq((await readBrief(page)).goal, F3.goal, 'session B shows its own goal');
  await control(page, 'release', { session: 'A' });             // A's late answer arrives
  await page.waitForTimeout(300);
  const afterRelease = await readBrief(page);
  t.eq(afterRelease.goal, F3.goal, 'a released in-flight answer for A never lands on B');
  t.ok(!afterRelease.goal.includes('copy generation') && !afterRelease.current.includes('judging'),
    'session B never displays session A\'s brief');
  t.ok(!afterRelease.goal.includes('shared-project'), 'the shared project label is not used as a goal');

  // ---- A -> B -> A with TWO A answers in flight at once ---- The first one belongs to a superseded open of
  // the same session; releasing it before the current one must change nothing on screen.
  await page.evaluate(() => briefView.open('A', ''));           // stale request, held
  await page.waitForTimeout(150);
  await page.evaluate(() => openTerminal('B'));
  await page.waitForTimeout(150);
  await page.evaluate(() => briefView.open('A', ''));           // current request, held
  await page.waitForTimeout(150);
  const pending = await control(page, 'held', { session: 'A' });
  t.ok(pending.count >= 2, `both A answers are in flight (${pending.count})`);
  await control(page, 'release', { session: 'A', count: 1 });   // FIFO: the superseded one
  await page.waitForTimeout(300);
  const staleSameName = await readBrief(page);
  t.ok(['loading', 'generating'].includes(staleSameName.status),
    `an answer from a previous open of the same session does not render (saw ${staleSameName.status})`);
  t.ok(!staleSameName.goal.includes(F1.goal), 'no text from the superseded open reaches the screen');
  await control(page, 'release', { session: 'A' });             // the current request may land
  await page.waitForTimeout(300);
  t.eq((await readBrief(page)).goal, F1.goal, 'the current open\'s own answer does render');

  // ---- same name, different window: the other window's answer must not render ----
  await page.evaluate(() => briefView.open('A', 'shell'));      // request for A:shell, held
  await page.waitForTimeout(150);
  await page.evaluate(() => briefView.open('A', 'claude'));     // user switches window
  await page.waitForTimeout(150);
  await control(page, 'release', { session: 'A', count: 1 });   // the shell answer comes back
  await page.waitForTimeout(300);
  const afterWindowSwitch = await readBrief(page);
  t.ok(!afterWindowSwitch.goal.includes('inventory tracking'),
    'an answer for the other window of the same session never renders');
  await control(page, 'release', { session: 'A' });
  await control(page, 'unhold', { session: 'A' });
  await page.evaluate(() => openTerminal('A'));
  await settleAndRefresh(page);
  t.eq((await readBrief(page)).goal, F1.goal, 'the streamed window\'s own brief is what is shown');

  // ---- the brief is bound to the window the open stream actually resolved ----
  // A connection fixes its tmux target when it opens; Claude can move windows while it is
  // open. Without an explicit binding the brief re-resolves "wherever Claude is now" on
  // every poll and wanders off the pane the transcript is still showing.
  const announce = () => announceStreamTarget(page, control, 'A');
  await control(page, 'move-claude', { session: 'A', window: 'claude' });
  await page.evaluate(() => openTerminal('A'));
  const opened = await announce();
  t.eq(opened.window, 'claude', 'the connection resolves A\'s Claude window');
  t.eq(await page.evaluate(() => briefView.window()), 'claude', 'the client binds the brief to the streamed window');
  await control(page, 'advance', { ms: 31000 });
  await settleAndRefresh(page);
  t.eq((await readBrief(page)).goal, F1.goal, 'the bound window\'s own brief is shown');

  // Claude moves to the other window. This connection is still streaming A:claude, whose
  // pane says something different from the window Claude moved to.
  await control(page, 'move-claude', { session: 'A', window: 'shell' });
  await control(page, 'advance', { ms: 31000 });
  await settleAndRefresh(page);
  const heldBinding = await readBrief(page);
  t.eq(await page.evaluate(() => briefView.window()), 'claude', 'a move without reopening does not re-point the brief');
  t.eq(heldBinding.goal, F1.goal, 'the brief still describes the pane the transcript is showing');
  t.ok(!heldBinding.goal.includes(F3.goal) && !heldBinding.current.includes(F3.current),
    'the window Claude moved to never takes over an open session\'s brief');

  // An edit made against what is on screen is addressed to that pane.
  await page.click('#brief-edit-goal');
  await page.waitForSelector('#brief-input-goal');
  await page.fill('#brief-input-goal', 'edit for the pane on screen');
  await page.click('#brief-save-goal');
  await page.waitForTimeout(150);
  t.eq((await readBrief(page)).goal, 'edit for the pane on screen', 'the edit is saved against the bound window');

  // A reconnect re-synchronises the binding, and the answer still in flight for the
  // previous binding — carrying that edit — must never render afterwards.
  await control(page, 'hold', { session: 'A' });
  // Fire-and-forget: refresh() resolves only when the response arrives, and this one is
  // being held on purpose. Returning its promise to evaluate() would hang the test.
  await page.evaluate(() => { briefView.refresh(); });
  await page.waitForTimeout(150);
  t.ok((await control(page, 'held', { session: 'A' })).count >= 1, 'an answer for the previous binding is in flight');
  const rebound = await announce();
  t.eq(rebound.window, 'shell', 'a reconnect announces the window Claude moved to');
  await page.waitForTimeout(120);
  await control(page, 'release', { session: 'A', count: 1 });
  await page.waitForTimeout(250);
  t.ok(!String((await readBrief(page)).goal).includes('edit for the pane on screen'),
    'a delayed answer from the previous binding never renders');
  await control(page, 'release', { session: 'A' });
  await control(page, 'unhold', { session: 'A' });
  await settleAndRefresh(page);
  await settleAndRefresh(page);
  t.eq(await page.evaluate(() => briefView.window()), 'shell', 'the reconnect re-bound the brief to the new window');
  t.eq((await readBrief(page)).goal, F3.goal, 'after the reconnect the brief describes the moved-to window');

  // Reopening still discovers fresh, and the edit stayed with the pane it was made against.
  await control(page, 'move-claude', { session: 'A', window: 'claude' });
  await page.evaluate(() => openTerminal('A'));
  await announce();
  await settleAndRefresh(page);
  t.eq((await readBrief(page)).goal, 'edit for the pane on screen', 'reopening the original window finds its own edit');

  // No Claude running at open: an announced EMPTY window is still a binding, and answers
  // still in flight from before it arrived must not land. Both delivered clients.
  await emptyWindowBindingCases(ctx, t, { page, control, readBrief, settleAndRefresh, openClient, F1, F3 });


  // A new incarnation under the same tmux name inherits nothing.
  await page.evaluate(() => openTerminal('A'));
  await settleAndRefresh(page);
  const before = await readBrief(page);
  t.eq(before.status, 'ok', 'session A has a brief before the restart');
  await control(page, 'reincarnate', { session: 'A' });
  await page.evaluate(() => openTerminal('A'));
  await page.waitForTimeout(60);
  const reborn = await readBrief(page);
  t.ok(['loading', 'generating'].includes(reborn.status), 'a same-named new session starts with no brief');
  t.ok(!reborn.goal.includes(F1.goal), 'a same-named new session inherits no previous text');

  // Distinct truthful states for each failure mode.
  const states = {};
  for (const [mode, pane, expect] of [
    ['ok', '', 'unavailable'],
    ['malformed', ctx.panes.f1, 'error'],
    ['timeout', ctx.panes.f1, 'error'],
    ['fail', ctx.panes.f1, 'error'],
  ]) {
    // Pane and mode are set BEFORE the reincarnation. The client polls every 3s, and a poll
    // landing between a reincarnation and the pane change would register the new identity
    // while the pane still held the previous case's text — generating a real brief where
    // this case expects none. Observed as an intermittent "ok" instead of "unavailable".
    await control(page, 'pane', { session: 'A', pane });
    await control(page, 'mode', { mode });
    await control(page, 'reincarnate', { session: 'A' });
    await page.evaluate(() => openTerminal('A'));
    await control(page, 'advance', { ms: 31000 });
    await settleAndRefresh(page);
    const brief = await readBrief(page);
    states[`${mode}:${pane ? 'evidence' : 'no-evidence'}`] = brief;
    t.eq(brief.status, expect, `${mode} with ${pane ? 'evidence' : 'no evidence'} reports ${expect}`);
    t.eq(brief.goal, expect === 'unavailable' ? 'No brief yet' : 'Unavailable', `${mode}: no invented text is shown`);
    t.ok(brief.note.length > 0, `${mode}: the reason is spelled out`);
  }
  await control(page, 'mode', { mode: 'ok' });

  // Generated text and user edits are rendered as text, never as markup.
  await control(page, 'reincarnate', { session: 'A' });
  await control(page, 'mode', { mode: 'html' });
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f1 });
  await page.evaluate(() => openTerminal('A'));
  await settleAndRefresh(page);
  const html = await page.evaluate(() => ({
    text: document.getElementById('brief-goal').textContent,
    children: document.getElementById('brief-goal').children.length,
    xss: typeof window.__xss,
  }));
  t.includes(html.text, '<img', 'generated markup is shown as literal text');
  t.eq(html.children, 0, 'generated text never becomes child elements');
  t.eq(html.xss, 'undefined', 'no script from generated text executed');
  await control(page, 'mode', { mode: 'ok' });

  // A persistence failure can never be acknowledged as saved.
  await control(page, 'readonly');
  await settleAndRefresh(page);
  const rev = await page.evaluate(() => (briefView.current() ? briefView.current().revision : null));
  t.ok(Number.isInteger(rev), `the brief carried a real revision before the rejected edit (${rev})`);
  await page.click('#brief-edit-goal');
  await page.waitForSelector('#brief-input-goal');
  await page.fill('#brief-input-goal', 'this cannot be saved');
  await page.click('#brief-save-goal');
  await page.waitForTimeout(150);
  const storageFail = await page.evaluate(() => ({
    note: document.getElementById('brief-status').textContent,
    goal: document.getElementById('brief-goal').textContent,
    revision: briefView.current() ? briefView.current().revision : null,
  }));
  t.includes(storageFail.note, 'Edit not saved', 'a storage failure is reported, never acknowledged as saved');
  // Was a disjunction whose right-hand side the line above had just asserted true, so it
  // could never fail. The claim that matters is the left-hand side on its own.
  t.ok(!storageFail.goal.includes('this cannot be saved'), 'the unsaved edit is never presented as the stored goal');
  t.eq(storageFail.revision, rev, 'a rejected edit does not advance the revision');

  saveArtifact(ctx.artifactDir, 'brief-failure-states.json', states);
  t.note('briefFailureStates', Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v.status])));
  await context.close();
}
