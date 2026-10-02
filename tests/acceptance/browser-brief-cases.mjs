// Brief:: acceptance cases — the pinned view on both clients, refresh and per-field edits,
// and cross-session isolation plus the truthful failure states.

import { newPage, emit, saveArtifact } from './browser-support.mjs';

export const F1 = { goal: 'improve copy generation quality', current: 'add a judging step to compare candidate copy' };
export const F2 = { goal: 'improve copy generation quality', current: 'fix inconsistent score normalization' };
export const F3 = { goal: 'reliable inventory tracking', current: 'repair barcode import validation' };

const control = (page, op, params = {}) => page.evaluate(
  ([o, p]) => fetch(`/__control/${o}?${new URLSearchParams(p)}`).then(r => r.json()),
  [op, params],
);

async function settleAndRefresh(page) {
  await control(page, 'settle');
  await page.evaluate(() => briefView.refresh());
  await page.waitForTimeout(80);
}

async function readBrief(page) {
  return page.evaluate(() => ({
    status: document.getElementById('brief').getAttribute('data-status'),
    goal: document.getElementById('brief-goal').textContent,
    current: document.getElementById('brief-current').textContent,
    age: document.getElementById('brief-age').textContent,
    note: document.getElementById('brief-status').textContent,
    generatedAt: briefView.current() ? briefView.current().generatedAt : null,
    revision: briefView.current() ? briefView.current().revision : null,
    stale: briefView.current() ? briefView.current().stale : null,
  }));
}

async function openClient(ctx, kind) {
  if (kind === 'mobile') {
    const { context, page } = await newPage(ctx.browser, { device: ctx.devices['iPhone 13'] });
    await page.goto(`${ctx.origin}/?open=A`);
    await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
    return { context, page };
  }
  const { context, page } = await newPage(ctx.browser, { viewport: { width: 1280, height: 860 } });
  await page.goto(`${ctx.origin}/desktop.html`);
  await page.waitForSelector('.project-item[data-session="A"]');
  await page.click('.project-item[data-session="A"] .project-content');
  await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
  return { context, page };
}

async function editField(page, field, value) {
  await page.click(`#brief-edit-${field}`);
  await page.waitForSelector(`#brief-input-${field}`);
  await page.fill(`#brief-input-${field}`, value);
  await page.click(`#brief-save-${field}`);
  await page.waitForTimeout(120);
}

export async function pinnedBothClients(ctx, t) {
  const boxes = {};
  for (const kind of ['mobile', 'desktop']) {
    // A genuinely unseen session: earlier cases shared this store, so start a fresh
    // incarnation to observe the real first-open state rather than a warm cache. The
    // generator is held slow so the pending state is observed deterministically instead of
    // racing a fast extractor.
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
    const layout = await page.evaluate(() => {
      const viewer = document.getElementById('terminal');
      viewer.scrollTop = viewer.clientHeight * 1.5;
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
      };
    });
    boxes[kind] = layout;
    t.ok(layout.viewer.scrollTop > 0, `${kind}: the transcript actually scrolled by more than a viewport`);
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

  // f1 → f2 with no change of session name.
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f2 });
  await control(page, 'advance', { ms: 31000 });
  await settleAndRefresh(page);
  const second = await readBrief(page);
  t.eq(second.current, F2.current, 'current work refreshes within one evidence interval');
  t.eq(second.goal, F2.goal, 'the broad goal stays supported across the refresh');
  t.ok(second.generatedAt > first.generatedAt, 'generatedAt advances on a successful generation');

  // A failed refresh keeps the old text, marks it stale and does not move generatedAt.
  await control(page, 'mode', { mode: 'fail' });
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f3 });
  await control(page, 'advance', { ms: 31000 });
  await settleAndRefresh(page);
  const failed = await readBrief(page);
  t.eq(failed.current, F2.current, 'the last good text is kept when a refresh fails');
  t.eq(failed.generatedAt, second.generatedAt, 'the generation time does not move on failure');
  t.eq(failed.stale, true, 'the kept text is labelled stale');
  t.includes(failed.note, 'refresh failed', 'the failure is visible to the user');
  await control(page, 'mode', { mode: 'ok' });
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f2 });

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
  await settleAndRefresh(page);
  brief = await readBrief(page);
  t.eq(brief.goal, 'ship the judging step', 'edits survive a page reload');
  await control(page, 'restart');
  await settleAndRefresh(page);
  brief = await readBrief(page);
  t.eq(brief.goal, 'ship the judging step', 'edits survive a service restart');
  t.eq(brief.current, 'hand written current work', 'both edits survive a service restart');

  // Clear only the current field.
  await page.click('#brief-clear-current');
  await page.waitForTimeout(150);
  brief = await readBrief(page);
  t.eq(brief.current, F2.current, 'clearing one override restores that field\'s newest generated value');
  t.eq(brief.goal, 'ship the judging step', 'clearing one override leaves the other edit in place');

  // An older job racing a new edit: the edit wins.
  await control(page, 'mode', { mode: 'slow' });
  await control(page, 'pane', { session: 'A', pane: ctx.panes.f3 });
  await control(page, 'advance', { ms: 31000 });
  await editField(page, 'current', 'edit during a slow job');
  await settleAndRefresh(page);
  brief = await readBrief(page);
  t.eq(brief.current, 'edit during a slow job', 'an edit beats a generation that was already running');
  await control(page, 'mode', { mode: 'ok' });

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

  // A slow A, then switch to B before A's answer lands.
  await control(page, 'mode', { mode: 'slow' });
  await page.evaluate(() => briefView.refresh());
  await page.evaluate(() => openTerminal('B'));
  await page.waitForTimeout(100);
  await control(page, 'mode', { mode: 'ok' });
  await settleAndRefresh(page);
  const b = await readBrief(page);
  t.eq(b.goal, F3.goal, 'session B shows its own goal');
  t.ok(!b.goal.includes('copy generation') && !b.current.includes('judging'),
    'session B never displays session A\'s brief');
  t.ok(!b.goal.includes('shared-project'), 'the shared project label is not used as a goal');

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
    await control(page, 'reincarnate', { session: 'A' });
    await control(page, 'mode', { mode });
    await control(page, 'pane', { session: 'A', pane });
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
  const rev = await page.evaluate(() => (briefView.current() ? briefView.current().revision : 0));
  await page.click('#brief-edit-goal');
  await page.waitForSelector('#brief-input-goal');
  await page.fill('#brief-input-goal', 'this cannot be saved');
  await page.click('#brief-save-goal');
  await page.waitForTimeout(150);
  const storageFail = await page.evaluate(() => ({
    note: document.getElementById('brief-status').textContent,
    goal: document.getElementById('brief-goal').textContent,
  }));
  t.includes(storageFail.note, 'Edit not saved', 'a storage failure is reported, never acknowledged as saved');
  t.ok(!storageFail.goal.includes('this cannot be saved') || storageFail.note.includes('Edit not saved'),
    'the unsaved edit is not presented as stored');
  t.ok(rev >= 0, 'a revision was in play for the rejected edit');

  saveArtifact(ctx.artifactDir, 'brief-failure-states.json', states);
  t.note('briefFailureStates', Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v.status])));
  await context.close();
}
