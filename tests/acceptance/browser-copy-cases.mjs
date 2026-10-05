// Copy:: acceptance cases — mobile selection under live streaming, the delivered copy
// control, real clipboard readback, and the desktop scroll/lifecycle contract.
//
// Thresholds here are tied to measured quantities (viewport height, snapshot length,
// observed growth) rather than round constants: a constant larger than the effect it
// bounds makes an assertion pass with the feature switched off.

import { TARGET } from './browser-diagnosis.mjs';
import {
  newPage, emit, SOCKET_STUB, startStream, stopStream, dragSelect, syntheticLongPress, sustainedTouch,
  engineCapabilities, saveArtifact, STANDALONE_STUB, sustainedTouchOnChromium, recordCapabilityBranch,
  assertNativeSelectionSurvives, readRealClipboard,
} from './browser-support.mjs';

const UNICODE_LINE = 'café 日本語 — copy me exactly\twith a tab';
// The clipboard oracle, fixed here rather than read back out of `#copy-text`. Reading the
// expectation from the application's own snapshot is self-referential: a snapshot that
// silently dropped its first or last line would still "match".
const COPY_FIXTURE = `first line\n${UNICODE_LINE}\nlast line\n`;

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
  const before = await page.evaluate(() => {
    const ta = document.getElementById('copy-text');
    return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  });
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
  const after = await page.evaluate(() => {
    const ta = document.getElementById('copy-text');
    return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd, status: document.getElementById('transcript-status').textContent };
  });
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
  await page.evaluate(() => {
    window.__staleHandler({ data: JSON.stringify({ type: 'output', data: 'STALE SESSION A TEXT\n' }) });
  });
  await emit(page, 'output', 'session B history\n');
  const switched = await page.evaluate(() => transcript.snapshotText());
  t.ok(!switched.includes('STALE SESSION A TEXT'), 'a stale callback from session A never lands on session B');
  t.includes(switched, 'session B history', 'session B shows its own stream');

  recordCapabilityBranch(t, { webkit: wk, chromium: chromiumHold });
  await page.screenshot({ path: `${ctx.artifactDir}/mobile-copy.png` });
  await context.close();
}


export async function clipboardAndFailure(ctx, t) {
  const report = { engines: {} };
  // At least one engine must produce a real, exact clipboard round-trip through the visible
  // control. "Both engines said Copy failed" is a failing case, not a documented limitation.
  const roundTrips = [];
  const subsetRoundTrips = [];

  for (const [engineName, launcher, device] of [
    ['webkit-mobile', ctx.webkit, ctx.devices['iPhone 13']],
    ['chromium-desktop', ctx.chromium, null],
  ]) {
    const browser = await launcher.launch();
    try {
      const contextOpts = device ? { ...device } : { viewport: { width: 1280, height: 860 } };
      if (engineName.startsWith('chromium')) contextOpts.permissions = ['clipboard-read', 'clipboard-write'];
      const context = await browser.newContext(contextOpts);
      await context.addInitScript(SOCKET_STUB);
      await context.addInitScript(STANDALONE_STUB);
      const page = await context.newPage();
      await page.goto(`${ctx.origin}/?open=A`);
      await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
      await emit(page, 'output', COPY_FIXTURE);
      await page.waitForSelector('#terminal .msg');

      const caps = await engineCapabilities(page);
      await page.click('#copy-open');
      await page.waitForSelector('#copy-sheet:not([hidden])');
      // Checked before any copy, so a dropped line fails here rather than lowering the bar.
      t.eq(await page.inputValue('#copy-text'), COPY_FIXTURE,
        `${engineName}: the snapshot holds the fixture exactly, first and last line included`);
      await page.click('#copy-all');
      await page.waitForTimeout(200);
      const status = await page.textContent('#copy-status');
      const state = await page.getAttribute('#copy-sheet', 'data-copy-state');
      const clip = await readRealClipboard(page, context);
      report.engines[engineName] = { caps, status, state, clip: { ...clip, text: (clip.text || '').slice(0, 400) }, expectedLength: COPY_FIXTURE.length };

      let clipboardWorks = false;
      if (state === 'copied') {
        t.ok(clip.ok, `${engineName}: a copy reported as succeeded is readable back from the real clipboard`);
        if (clip.ok) {
          const exact = clip.text === COPY_FIXTURE;
          t.eq(clip.text, COPY_FIXTURE, `${engineName}: the pasted text is exactly the transcript snapshot`);
          t.includes(clip.text, UNICODE_LINE, `${engineName}: Unicode and tabs survive the copy`);
          t.ok(!clip.text.includes('Copy selection') && !clip.text.includes('Project goal'),
            `${engineName}: no control label or brief text is included`);
          if (exact) roundTrips.push({ engine: engineName, via: clip.via, chars: clip.text.length });
          clipboardWorks = exact;
        }
      } else {
        t.includes(status, 'Copy failed', `${engineName}: a copy that did not succeed says so instead of claiming success`);
      }

      // A NONEMPTY subset, offsets from the fixture literal: Copy selection must deliver
      // exactly that subset, not the whole snapshot.
      const subStart = COPY_FIXTURE.indexOf(UNICODE_LINE);
      await page.evaluate(([s, e]) => {
        const ta = document.getElementById('copy-text');
        ta.focus();
        ta.setSelectionRange(s, e);
      }, [subStart, subStart + UNICODE_LINE.length]);
      await page.click('#copy-selection');
      await page.waitForTimeout(200);
      const subState = await page.getAttribute('#copy-sheet', 'data-copy-state');
      const subClip = subState === 'copied' ? await readRealClipboard(page, context) : null;
      // An engine whose clipboard just carried the whole snapshot has no excuse for failing
      // the subset, so a selection-only failure cannot hide behind the documented branch.
      if (clipboardWorks) {
        t.eq(subState, 'copied', `${engineName}: Copy selection succeeds on an engine whose Copy all just succeeded`);
        t.ok(subClip && subClip.ok, `${engineName}: the selection copy is readable back from the real clipboard`);
        t.eq(subClip && subClip.text, UNICODE_LINE, `${engineName}: Copy selection delivers exactly the selected subset`);
        t.ok(subClip && !String(subClip.text).includes('first line') && !String(subClip.text).includes('last line'),
          `${engineName}: Copy selection does not drag in unselected lines`);
        if (subClip && subClip.ok && subClip.text === UNICODE_LINE) {
          subsetRoundTrips.push({ engine: engineName, via: subClip.via, chars: subClip.text.length });
        }
      } else {
        t.includes(await page.textContent('#copy-status'), 'Copy failed',
          `${engineName}: with no working clipboard at all, the selection copy says so instead of claiming success`);
      }

      // Empty selection must not copy anything else.
      await page.evaluate(() => { const ta = document.getElementById('copy-text'); ta.setSelectionRange(0, 0); });
      await page.click('#copy-selection');
      const emptyStatus = await page.textContent('#copy-status');
      t.includes(emptyStatus, 'Nothing selected', `${engineName}: an empty selection refuses to copy unrelated text`);
      t.eq(await page.getAttribute('#copy-sheet', 'data-copy-state'), 'error', `${engineName}: the refusal is an error state`);
      t.eq(caps.standalone, true, `${engineName}: the programmatic standalone display-mode branch was exercised`);
      await context.close();

      // A denied / unavailable clipboard must fail visibly, keeping the snapshot.
      const denied = await browser.newContext(contextOpts);
      await denied.addInitScript(SOCKET_STUB);
      await denied.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: () => Promise.reject(new DOMException('NotAllowedError: write permission denied')) },
        });
        document.execCommand = () => false;
      });
      const dpage = await denied.newPage();
      await dpage.goto(`${ctx.origin}/?open=A`);
      await dpage.waitForFunction(() => window.__sockets.some(s => s.onmessage));
      await emit(dpage, 'output', `first line\n${UNICODE_LINE}\n`);
      await dpage.click('#copy-open');
      await dpage.click('#copy-all');
      await dpage.waitForTimeout(150);
      const deniedStatus = await dpage.textContent('#copy-status');
      t.eq(await dpage.getAttribute('#copy-sheet', 'data-copy-state'), 'error', `${engineName}: a denied clipboard is an error, never a success`);
      t.includes(deniedStatus, 'Copy failed', `${engineName}: the denial message is actionable`);
      t.includes(deniedStatus, 'system Copy menu', `${engineName}: the user is told what to do instead`);
      t.includes(await dpage.inputValue('#copy-text'), UNICODE_LINE, `${engineName}: the snapshot is retained after a failed copy`);
      await denied.close();
    } finally {
      await browser.close();
    }
  }
  report.limitation = 'A programmatic standalone display-mode is not an installed iOS PWA; no SpringBoard callout or OS share sheet is exercised here.';
  report.successfulRoundTrips = roundTrips;
  report.successfulSubsetRoundTrips = subsetRoundTrips;
  saveArtifact(ctx.artifactDir, 'clipboard-evidence.json', report);
  // The whole point of the case: somewhere, the visible control really did put the exact
  // transcript text on the real system clipboard.
  t.ok(roundTrips.length >= 1,
    `at least one engine completed an exact clipboard round-trip through the visible control (got ${JSON.stringify(roundTrips)})`);
  // Copy selection is its own path and needs its own real round-trip, not Copy all's.
  t.ok(subsetRoundTrips.length >= 1,
    `at least one engine completed an exact clipboard round-trip for a nonempty selected subset (got ${JSON.stringify(subsetRoundTrips)})`);
  t.note('clipboard', { engines: report.engines, roundTrips, subsetRoundTrips });
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
  await page.evaluate(() => window.__staleHandler({ data: JSON.stringify({ type: 'output', data: 'STALE A OUTPUT\n' }) }));
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
