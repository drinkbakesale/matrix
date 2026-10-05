// Copy:: acceptance cases — mobile selection under live streaming, the delivered copy
// control, real clipboard readback, and the desktop scroll/lifecycle contract.
//
// Thresholds here are tied to measured quantities (viewport height, snapshot length,
// observed growth) rather than round constants: a constant larger than the effect it
// bounds makes an assertion pass with the feature switched off.

import { TARGET } from './browser-diagnosis.mjs';
import {
  newPage, emit, startStream, stopStream, dragSelect, syntheticLongPress, sustainedTouch,
  engineCapabilities, sustainedTouchOnChromium, recordCapabilityBranch,
  assertNativeSelectionSurvives, readRealClipboard,
} from './browser-support.mjs';

const UNICODE_LINE = 'café 日本語 — copy me exactly\twith a tab';

async function openMobile(ctx, { init = [], session = 'A' } = {}) {
  const { context, page } = await newPage(ctx.browser, { device: ctx.devices['iPhone 13'], init });
  await page.goto(`${ctx.origin}/?open=${session}`);
  await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
  return { context, page };
}

export async function mobileStreamSelection(ctx, t) {
  const { context, page } = await openMobile(ctx);
  const caps = await engineCapabilities(page);
  t.note('mobileCapabilities', caps);
  await emit(page, 'output', `initial history\n${UNICODE_LINE}\n`);
  await emit(page, 'screen', `${TARGET}\n`);
  await page.waitForSelector('#terminal .msg-screen');

  // Both stream types run throughout the gesture attempts, as the oracle requires. The
  // screen frames carry the Unicode target so the protected text is real conversation text.
  await startStream(page, 100, ` ${TARGET}`);
  await page.waitForTimeout(250);

  // 1a. TRUSTED-INPUT capability attempt: the engine generates the events itself
  // (isTrusted=true). Only this can speak to a real press-and-hold; dispatchEvent cannot.
  const targetBox = await page.evaluate(() => {
    const el = document.querySelector('#terminal .msg-screen');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const wk = await sustainedTouch(page, context, targetBox, 900, { watch: '#terminal .msg-screen' });
  t.note('webkitNativeLongPressAttempt', {
    engine: 'webkit', version: ctx.browser.version(), ...wk,
    requirement: 'mandatory native WebKit long-press attempt',
    dischargedBy: wk.sustained
      ? 'sustained native input was delivered; the native-selection assertions apply'
      : 'contract v3 unsupported-automation branch: the available automation cannot deliver sustained touch input',
  });
  t.eq(wk.error, null, 'the WebKit touch attempt ran without an automation error');
  t.ok(wk.touchEventsDelivered > 0, `real touch input reached the page on WebKit (${wk.touchEventsDelivered} events)`);
  t.eq(wk.allTouchEventsTrusted, true, 'every touch event WebKit delivered was engine-generated (isTrusted)');
  t.includes(wk.textAtPress, TARGET, 'the touched node holds real transcript text');
  t.eq(wk.textDuringHold, wk.textAtPress, 'the touched text is byte-identical across the WebKit touch');
  // Honest capability split, written so the capability is TRACKED rather than frozen: if
  // this engine ever gains a way to hold a touch down, the first branch takes over and the
  // hold must then actually survive. Today it has none, so the limitation names the exact
  // missing protocol facility.
  if (wk.sustained) {
    await assertNativeSelectionSurvives(page, context, t, { touch: wk, readClipboard: readRealClipboard });
  } else {
    t.ok(wk.limitation && wk.limitation.includes('dispatchTapEvent'),
      'WebKit cannot hold a touch down, and the limitation names the exact missing protocol facility');
    // Wall-clock measured, so an atomic tap lands at 0-1ms — nowhere near an 850ms hold.
    t.ok(wk.observedPressMs < 50, `WebKit delivers an atomic tap, not a hold (${wk.observedPressMs}ms press)`);
    t.eq(wk.kind, 'atomic tap — NOT a long-press', 'the delivered input is labelled a tap, never a long-press');
    t.eq(wk.nativeLongPressDelivered, false, 'no native WebKit long-press is claimed from this attempt');
  }

  // A SUSTAINED touch, on the engine whose automation can actually hold one. This is
  // capability evidence about touch delivery; it is explicitly NOT a WebKit long-press.
  const chromiumHold = await sustainedTouchOnChromium(ctx, t, { target: TARGET, unicodeLine: UNICODE_LINE });

  // 1b. SYNTHETIC gesture, never conflated with the above: it proves the DOM race causally
  // and completes with a release.
  await page.evaluate(() => transcript.resume());
  await page.waitForTimeout(250);
  const synthetic = await syntheticLongPress(page, '#terminal .msg-screen', 900);
  t.note('syntheticLongPress', synthetic);
  t.ok(synthetic.attempted, 'a synthetic touch sequence was dispatched on the transcript');
  t.eq(synthetic.released, true, 'the synthetic gesture is released, not left pressed');
  t.eq(synthetic.stillConnected, true, 'the synthetically touched node stayed in the DOM for the whole hold');
  t.eq(synthetic.textDuringHold, synthetic.textAtPress, 'the synthetically touched text did not change during the hold');
  const afterSynthetic = await page.evaluate(() => transcript.mode());
  t.eq(afterSynthetic, 'live', 'releasing without a selection returns the transcript to live');

  // 2. The delivered visible fallback, exercised regardless of native capability.
  await page.evaluate(() => transcript.resume());
  await page.click('#copy-open');
  await page.waitForSelector('#copy-sheet:not([hidden])');
  await page.click('#copy-select-all');
  const read = () => page.evaluate(() => {
    const ta = document.getElementById('copy-text');
    return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  });
  const before = await read();
  t.includes(before.value, UNICODE_LINE, 'the snapshot holds the transcript text');
  // Select ALL means all of it: `end > start` would be satisfied by a single character.
  t.eq([before.start, before.end], [0, before.value.length], 'Select all really selected the whole snapshot');

  // Keep both stream types running, force a reconnect dump and a brief refresh.
  await page.evaluate(async () => {
    const s = window.__sockets.at(-1);
    if (s.onclose) s.onclose({});
    if (typeof briefView !== 'undefined' && briefView) await briefView.refresh();
  });
  await page.waitForTimeout(3100);
  const after = await read();
  after.status = await page.textContent('#transcript-status');
  t.eq(after.value, before.value, 'the snapshot text survived 3s of updates, a reconnect and a brief refresh');
  t.eq(after.start, before.start, 'the selection start survived');
  t.eq(after.end, before.end, 'the selection end survived');
  t.includes(after.status, 'Paused', 'the user can see that live updates are paused');

  // 3. Resume converges on the latest data exactly once.
  const streamed = await stopStream(page);
  await page.click('#copy-resume');
  await page.waitForTimeout(200);
  const resumed = await page.evaluate((n) => {
    const lines = transcript.snapshotText().split('\n').map(l => l.trim()).filter(l => /^stream line \d+$/.test(l));
    const seen = new Map();
    for (const l of lines) seen.set(l, (seen.get(l) || 0) + 1);
    return {
      last: seen.get(`stream line ${n}`) || 0,
      duplicates: [...seen.values()].filter(c => c > 1).length,
      mode: transcript.mode(),
    };
  }, streamed);
  t.eq(resumed.mode, 'live', 'Resume returns the transcript to live');
  t.eq(resumed.last, 1, 'the newest line appears exactly once after Resume');
  // A reconnect snapshot supersedes earlier staged deltas, so lines before it are expected to
  // be gone — what must never happen is the same line landing twice.
  t.eq(resumed.duplicates, 0, 'Resume never applies the same held line twice');

  // 4. Switching sessions drops stale callbacks from the previous one. The handler reference
  // is captured first, because switching also detaches it — firing the captured reference is
  // what an already-dispatched, in-flight callback would do.
  const detached = await page.evaluate(() => {
    window.__staleSocket = window.__sockets.at(-1);
    window.__staleHandler = window.__staleSocket.onmessage;
    openTerminal('B');
    return window.__staleSocket.onmessage === null;
  });
  t.eq(detached, true, 'switching sessions detaches the previous socket handlers');
  await page.waitForTimeout(100);
  // Asserted IMMEDIATELY after each of A's captured callbacks, BEFORE B's own dump: that
  // dump replaces the children and would erase the contamination, so a mobile client with
  // no token propagation could pass a check made after it.
  const mobileStale = await page.evaluate(() => {
    const before = transcript.snapshotText();
    window.__staleHandler({ data: JSON.stringify({ type: 'output', data: 'STALE SESSION A TEXT\n' }) });
    const afterOutput = transcript.snapshotText();
    window.__staleHandler({ data: JSON.stringify({ type: 'screen', data: 'STALE SESSION A SCREEN\n' }) });
    return { before, afterOutput, afterScreen: transcript.snapshotText() };
  });
  t.ok(!mobileStale.afterOutput.includes('STALE SESSION A TEXT'), 'stale session A output never reaches session B on mobile');
  t.ok(!mobileStale.afterScreen.includes('STALE SESSION A SCREEN'), 'stale session A screen never reaches session B on mobile');
  t.eq(mobileStale.afterOutput, mobileStale.before, 'B\'s transcript is byte-identical right after A\'s output callback');
  t.eq(mobileStale.afterScreen, mobileStale.before, 'B\'s transcript is byte-identical right after A\'s screen callback');
  await emit(page, 'output', 'session B history\n');
  const switched = await page.evaluate(() => transcript.snapshotText());
  t.ok(!switched.includes('STALE SESSION A TEXT'), 'a stale callback from session A never lands on session B');
  t.includes(switched, 'session B history', 'session B shows its own stream');

  // Mobile automatic reconnect. Unlike a session switch this never clears the transcript,
  // so the fresh connection would inherit the dead one's token unless the client advances
  // the epoch; an already-dispatched callback holds the handler itself, so detaching the
  // socket's properties cannot retire it.
  const mobileReconnect = await page.evaluate(async () => {
    const dying = window.__sockets.at(-1);
    const handler = dying.onmessage;
    const close = dying.onclose;
    close({});
    await new Promise(r => setTimeout(r, 1700));
    const fresh = window.__sockets.at(-1);
    fresh.onmessage({ data: JSON.stringify({ type: 'output', data: 'MOBILE NEW SNAPSHOT\n' }) });
    fresh.onmessage({ data: JSON.stringify({ type: 'stream-target', session: 'B', window: 'new-window' }) });
    const afterNew = { text: transcript.snapshotText(), window: briefView ? briefView.window() : null };
    const socketsBefore = window.__sockets.length;
    handler({ data: JSON.stringify({ type: 'output', data: 'MOBILE OLD OUTPUT\n' }) });
    handler({ data: JSON.stringify({ type: 'screen', data: 'MOBILE OLD SCREEN\n' }) });
    handler({ data: JSON.stringify({ type: 'stream-target', session: 'B', window: 'old-window' }) });
    close({});
    await new Promise(r => setTimeout(r, 1800));
    return { afterNew, text: transcript.snapshotText(),
      window: briefView ? briefView.window() : null,
      socketsBefore, socketsAfter: window.__sockets.length };
  });
  t.includes(mobileReconnect.afterNew.text, 'MOBILE NEW SNAPSHOT', 'mobile: the reconnect delivered its own snapshot');
  t.ok(!mobileReconnect.text.includes('MOBILE OLD OUTPUT'), 'mobile: a superseded connection\'s output never lands after a reconnect');
  t.ok(!mobileReconnect.text.includes('MOBILE OLD SCREEN'), 'mobile: a superseded connection\'s screen never lands after a reconnect');
  t.includes(mobileReconnect.text, 'MOBILE NEW SNAPSHOT', 'mobile: the new connection\'s snapshot is still what is shown');
  t.eq(mobileReconnect.window, mobileReconnect.afterNew.window, 'mobile: a superseded stream-target never re-points the brief');
  t.eq(mobileReconnect.socketsAfter, mobileReconnect.socketsBefore, 'mobile: an obsolete reconnect timer does not open another connection');

  recordCapabilityBranch(t, { webkit: wk, chromium: chromiumHold });
  await page.screenshot({ path: `${ctx.artifactDir}/mobile-copy.png` });
  await context.close();
}


export async function desktopScrollLifecycle(ctx, t) {
  const { context, page } = await newPage(ctx.browser, { viewport: { width: 1280, height: 800 } });
  await page.goto(`${ctx.origin}/desktop.html`);
  await page.waitForSelector('.project-item[data-session="A"]');
  await page.click('.project-item[data-session="A"] .project-content');
  await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
  // Separate messages, so the transcript has many nodes and really scrolls.
  await page.evaluate((line) => {
    const s = window.__sockets.at(-1);
    for (let i = 0; i < 80; i += 1) {
      s.onmessage({ data: JSON.stringify({ type: 'output', data: `history line ${i} ${line}\n` }) });
    }
  }, UNICODE_LINE);
  await page.waitForSelector('#terminal .msg');

  // Mouse selection survives both stream types for 3 seconds.
  const box = await page.evaluate(() => {
    const nodes = document.querySelectorAll('#terminal .msg');
    const node = nodes[Math.min(2, nodes.length - 1)];
    node.scrollIntoView({ block: 'center' });
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, count: nodes.length };
  });
  t.ok(box.count > 10, 'the desktop transcript has many separate message nodes');
  const selected = await dragSelect(page, box, { holdMs: 400 });
  t.ok(selected.length >= 10, `a real mouse drag selected a substantial run of text (${selected.length} chars)`);
  t.includes(await page.evaluate(() => transcript.snapshotText()), selected, 'the dragged selection is real transcript text');
  const scrolledTop = await page.evaluate(() => document.getElementById('terminal').scrollTop);
  await startStream(page, 100);
  await page.waitForTimeout(3100);
  const still = await page.evaluate(() => ({ sel: String(window.getSelection()), top: document.getElementById('terminal').scrollTop, mode: transcript.mode() }));
  t.eq(still.sel, selected, 'the desktop selection is byte-identical after 3s of output and screen updates');
  t.eq(still.top, scrolledTop, 'a scrolled-up viewport does not move while selecting');
  t.eq(still.mode, 'selecting', 'the transcript reports that it is holding updates');

  // Resume catches up exactly once.
  const streamed = await stopStream(page);
  await page.evaluate(() => { window.getSelection().removeAllRanges(); transcript.resume(); });
  await page.waitForTimeout(200);
  const caught = await page.evaluate((n) => {
    // Exact-line counting: "stream line 1" is a prefix of "stream line 10".
    const lines = transcript.snapshotText().split('\n').map(l => l.trim());
    const count = needle => lines.filter(l => l === needle).length;
    return { last: count(`stream line ${n}`), first: count('stream line 1'), held: n };
  }, streamed);
  t.eq(caught.last, 1, 'the newest held line appears exactly once after Resume');
  t.eq(caught.first, 1, 'the oldest held line appears exactly once after Resume');

  // Pausing while reading history must return you to where you were reading, not to the
  // bottom — including across a reconnect snapshot that arrives while paused.
  const readingTop = await page.evaluate(() => {
    const v = document.getElementById('terminal');
    v.scrollTop = Math.floor(v.scrollHeight * 0.25);
    v.dispatchEvent(new Event('scroll'));
    return { top: v.scrollTop, following: transcript.following(), height: v.scrollHeight,
      clientHeight: v.clientHeight, gap: v.scrollHeight - v.scrollTop - v.clientHeight };
  });
  t.ok(readingTop.gap > readingTop.clientHeight,
    `the reader is a full viewport or more up into history (${readingTop.gap}px above the bottom, viewport ${readingTop.clientHeight}px)`);
  t.eq(readingTop.following, false, 'the transcript knows the reader is not following the bottom');
  await page.click('#copy-open');
  await page.waitForSelector('#copy-sheet:not([hidden])');
  await startStream(page, 100);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const s = window.__sockets.at(-1);
    if (s.onclose) s.onclose({});
  });
  await page.waitForTimeout(1700);
  // Every connection re-sends the whole scrollback, so the dump restores comparable content.
  await page.evaluate((line) => {
    const s = window.__sockets.at(-1);
    const dump = Array.from({ length: 80 }, (_, i) => `history line ${i} ${line}`).join('\n');
    s.onmessage({ data: JSON.stringify({ type: 'output', data: `${dump}\nreconnect while paused\n` }) });
  }, UNICODE_LINE);
  await stopStream(page);
  await page.click('#copy-resume');
  await page.waitForTimeout(200);
  const afterResume = await page.evaluate(() => {
    const v = document.getElementById('terminal');
    return {
      top: v.scrollTop, bottom: v.scrollHeight - v.scrollTop - v.clientHeight,
      clientHeight: v.clientHeight, following: transcript.following(), mode: transcript.mode(),
    };
  });
  t.eq(afterResume.mode, 'live', 'Resume returns to live');
  t.eq(afterResume.following, false, 'Resume does not silently re-enable bottom-following for a history reader');
  t.ok(afterResume.bottom > afterResume.clientHeight,
    `Resume did not yank the reader to the bottom (${afterResume.bottom}px above it, viewport ${afterResume.clientHeight}px)`);
  t.ok(Math.abs(afterResume.top - readingTop.top) <= 2, 'the reading position is preserved across pause, updates, reconnect and Resume');

  // At the bottom, live streaming follows the bottom. Appending ONE short line under a
  // 120px tolerance proved nothing: the growth was smaller than the tolerance, so the gap
  // stayed inside it whether or not autoScroll ran. Append enough to dwarf any tolerance,
  // then require the viewport to have TRAVELLED with it and to end flush at the bottom.
  const bottomStart = await page.evaluate(() => {
    const v = document.getElementById('terminal');
    v.scrollTop = v.scrollHeight;
    v.dispatchEvent(new Event('scroll'));
    return { top: v.scrollTop, height: v.scrollHeight, following: transcript.following() };
  });
  t.eq(bottomStart.following, true, 'the reader is following the bottom before the append');
  await page.evaluate(() => {
    const s = window.__sockets.at(-1);
    for (let i = 0; i < 60; i += 1) s.onmessage({ data: JSON.stringify({ type: 'output', data: `tail line ${i}\n` }) });
  });
  // Bounded wait on observable rendering, not a guessed sleep.
  await page.waitForFunction(h => document.getElementById('terminal').scrollHeight > h + 600,
    bottomStart.height, { timeout: 5000 });
  await page.waitForTimeout(150);
  const atBottom = await page.evaluate((s) => {
    const v = document.getElementById('terminal');
    return { grew: v.scrollHeight - s.height, moved: v.scrollTop - s.top, gap: v.scrollHeight - v.scrollTop - v.clientHeight };
  }, bottomStart);
  t.ok(atBottom.grew > 600, `the append grew the transcript well past any tolerance (${atBottom.grew}px)`);
  t.ok(atBottom.moved >= atBottom.grew - 4, `the viewport travelled with the new content (scrollTop moved ${atBottom.moved}px of ${atBottom.grew}px)`);
  t.ok(atBottom.gap <= 4, `streaming keeps following the bottom when the user is at the bottom (final gap ${atBottom.gap}px)`);

  // Switch away and back; a reconnect dump is never duplicated and stale callbacks are dropped.
  const detached = await page.evaluate(() => {
    window.__staleSocket = window.__sockets.at(-1);
    window.__staleHandler = window.__staleSocket.onmessage;
    selectProject('B');
    return window.__staleSocket.onmessage === null;
  });
  t.eq(detached, true, 'switching projects detaches the previous socket handlers');
  await page.waitForTimeout(100);
  // Asserted IMMEDIATELY after A's captured callbacks fire, before B's own dump or a switch
  // back to A can overwrite the contamination: either of those would erase the evidence and
  // let a client with no token propagation pass this case.
  const contamination = await page.evaluate(() => {
    const before = transcript.snapshotText();
    window.__staleHandler({ data: JSON.stringify({ type: 'output', data: 'STALE A OUTPUT\n' }) });
    window.__staleHandler({ data: JSON.stringify({ type: 'screen', data: 'STALE A SCREEN\n' }) });
    return { before, after: transcript.snapshotText() };
  });
  t.ok(!contamination.after.includes('STALE A OUTPUT'), 'session A stale output never reaches B\'s transcript');
  t.ok(!contamination.after.includes('STALE A SCREEN'), 'session A stale screen never reaches B\'s transcript');
  t.eq(contamination.after, contamination.before, 'B\'s transcript is byte-identical after A\'s callbacks fire');
  await emit(page, 'output', 'session B dump\n');
  await page.evaluate(() => selectProject('A'));
  await page.waitForTimeout(100);
  await emit(page, 'output', 'reconnect dump line\n');
  await page.evaluate(() => { const s = window.__sockets.at(-1); if (s.onclose) s.onclose({}); });
  await page.waitForTimeout(1700);
  await emit(page, 'output', 'reconnect dump line\n');
  const afterSwitch = await page.evaluate(() => transcript.snapshotText());
  t.eq(afterSwitch.split('reconnect dump line').length - 1, 1, 'a reconnect replaces the dump instead of duplicating it');
  t.ok(!afterSwitch.includes('STALE A OUTPUT'), 'a stale callback never lands on another session');
  t.ok(!afterSwitch.includes('session B dump'), 'session B text is gone after switching back to A');

  // The same hazard across an automatic RECONNECT, which — unlike a session switch — never
  // clears the transcript, so the new connection would inherit the dead one's token unless
  // the client advances the epoch. Callbacks already dispatched hold the handler itself, so
  // nulling the dead socket's properties cannot retire them.
  const reconnectStale = await page.evaluate(async () => {
    const dying = window.__sockets.at(-1);
    const handler = dying.onmessage;
    const close = dying.onclose;
    close({});
    await new Promise(r => setTimeout(r, 1700));
    const fresh = window.__sockets.at(-1);
    fresh.onmessage({ data: JSON.stringify({ type: 'output', data: 'NEW CONNECTION SNAPSHOT\n' }) });
    fresh.onmessage({ data: JSON.stringify({ type: 'stream-target', session: 'A', window: 'new-window' }) });
    const afterNew = { text: transcript.snapshotText(), window: briefView ? briefView.window() : null };
    const socketsBefore = window.__sockets.length;
    handler({ data: JSON.stringify({ type: 'output', data: 'OLD CONNECTION OUTPUT\n' }) });
    handler({ data: JSON.stringify({ type: 'screen', data: 'OLD CONNECTION SCREEN\n' }) });
    handler({ data: JSON.stringify({ type: 'stream-target', session: 'A', window: 'old-window' }) });
    close({});
    await new Promise(r => setTimeout(r, 1800));
    return {
      afterNew, text: transcript.snapshotText(),
      window: briefView ? briefView.window() : null,
      socketsBefore, socketsAfter: window.__sockets.length,
    };
  });
  t.includes(reconnectStale.afterNew.text, 'NEW CONNECTION SNAPSHOT', 'the reconnect delivered its own snapshot');
  t.ok(!reconnectStale.text.includes('OLD CONNECTION OUTPUT'), 'a superseded connection\'s output never lands after a reconnect');
  t.ok(!reconnectStale.text.includes('OLD CONNECTION SCREEN'), 'a superseded connection\'s screen never lands after a reconnect');
  t.includes(reconnectStale.text, 'NEW CONNECTION SNAPSHOT', 'the new connection\'s snapshot is still what is shown');
  t.eq(reconnectStale.window, reconnectStale.afterNew.window, 'a superseded stream-target never re-points the brief');
  t.eq(reconnectStale.socketsAfter, reconnectStale.socketsBefore, 'an obsolete reconnect timer does not open another connection');

  // Bounded buffer: overflow keeps the snapshot and asks for a fresh one on resume.
  await page.click('#copy-open');
  await page.waitForSelector('#copy-sheet:not([hidden])');
  const frozen = await page.inputValue('#copy-text');
  await page.evaluate(() => {
    const s = window.__sockets.at(-1);
    const blob = 'x'.repeat(64 * 1024) + '\n';
    for (let i = 0; i < 12; i += 1) s.onmessage({ data: JSON.stringify({ type: 'output', data: blob }) });
  });
  const overflow = await page.evaluate(() => ({
    overflowed: transcript.overflowed(),
    status: document.getElementById('transcript-status').textContent,
    snapshot: document.getElementById('copy-text').value,
  }));
  t.eq(overflow.overflowed, true, 'the staged buffer is bounded');
  t.eq(overflow.snapshot, frozen, 'the stable snapshot the user is reading is kept');
  t.includes(overflow.status, 'fresh snapshot', 'the user is told a fresh snapshot is needed');
  // Bounded memory is MEASURED, not inferred from the flag: a controller that raised
  // overflowed() and went on buffering would satisfy the flag alone. Keep pushing payloads
  // at it and require the retained size to stay at zero.
  await page.evaluate(() => {
    const s = window.__sockets.at(-1);
    const blob = 'y'.repeat(64 * 1024) + '\n';
    for (let i = 0; i < 8; i += 1) s.onmessage({ data: JSON.stringify({ type: 'output', data: blob }) });
  });
  const retained = await page.evaluate(() => ({
    bytes: transcript.stagedBytes(), held: transcript.heldCount(), overflowed: transcript.overflowed(),
    snapshot: document.getElementById('copy-text').value,
  }));
  t.eq(retained.overflowed, true, 'the overflow state persists through further traffic');
  t.eq(retained.held, 0, `no further payload is held after overflow (${retained.held} items)`);
  t.eq(retained.bytes, 0, `the staged buffer retains no bytes after overflow (${retained.bytes} bytes from 512 KiB pushed at it)`);
  t.eq(retained.snapshot, frozen, 'the stable snapshot survives the post-overflow traffic too');
  const socketsBefore = await page.evaluate(() => window.__sockets.length);
  await page.click('#copy-resume');
  await page.waitForTimeout(150);
  const socketsAfter = await page.evaluate(() => window.__sockets.length);
  t.ok(socketsAfter > socketsBefore, 'Resume reconnects for a fresh snapshot instead of dropping conversation text');
  await emit(page, 'output', 'fresh snapshot after overflow\n');
  t.includes(await page.evaluate(() => transcript.snapshotText()), 'fresh snapshot after overflow', 'the fresh snapshot is shown');
  await page.screenshot({ path: `${ctx.artifactDir}/desktop-lifecycle.png` });
  await context.close();
}
