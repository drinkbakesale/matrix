// Copy:: acceptance cases — mobile selection under live streaming, the delivered copy
// control, real clipboard readback, and the desktop scroll/lifecycle contract.

import { diagnose, TARGET } from './browser-diagnosis.mjs';
import {
  newPage, emit, startStream, stopStream, dragSelect, touchLongPress,
  engineCapabilities, saveArtifact, STANDALONE_STUB,
} from './browser-support.mjs';

const UNICODE_LINE = 'café 日本語 — copy me exactly\twith a tab';

async function openMobile(ctx, { init = [], session = 'A' } = {}) {
  const { context, page } = await newPage(ctx.browser, { device: ctx.devices['iPhone 13'], init });
  await page.goto(`${ctx.origin}/?open=${session}`);
  await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
  return { context, page };
}

export async function copyDiagnosis(ctx, t) {
  const results = {};
  for (const variant of ['base', 'candidate']) {
    const server = await ctx.startServer(variant === 'base' ? ctx.baseExport.dir : ctx.repoRoot);
    try {
      const { context, page } = await newPage(ctx.browser, { device: ctx.devices['iPhone 13'] });
      await page.goto(`${server.origin}/?open=A`);
      results[variant] = await diagnose(page, variant);
      results[variant].capabilities = await engineCapabilities(page);
      await page.screenshot({ path: `${ctx.artifactDir}/diagnosis-${variant}.png` });
      await context.close();
    } finally {
      await server.stop();
    }
  }
  results.baseCommit = ctx.baseExport.commit;
  results.baseHash = ctx.baseHash;
  results.replay = [
    'node tests/acceptance/browser.mjs --oracle <oracle> --artifacts <dir> --result <dir>/browser.json',
    'node tests/acceptance/gesture-probe-webkit.cjs "$PWD" <dir>/gesture-webkit.json',
  ];
  saveArtifact(ctx.artifactDir, 'copy-diagnosis.json', results);

  const base = results.base.conditions;
  const cand = results.candidate.conditions;
  t.ok(results.base.conditions.pre_selection_gesture.updates >= 5, 'the base fixture stream actually ran');
  t.ok(results.candidate.conditions.pre_selection_gesture.updates >= 5, 'the candidate fixture stream actually ran');
  t.eq(base.pre_selection_gesture.stable, false, 'BASE: the node under the finger is destroyed/moved during the long-press window');
  t.eq(base.pre_selection_gesture.connected, false, 'BASE: the screen block is removed from the DOM mid-gesture');
  t.eq(cand.pre_selection_gesture.stable, true, 'CANDIDATE: the touched node keeps its identity and position');
  t.includes(cand.pre_selection_gesture.text, TARGET, 'CANDIDATE: the touched text is unchanged');
  // Discrimination: the base already defers a screen refresh while a selection EXISTS (the
  // t-20260915 change), so that condition is not the defect. The two conditions it does fail
  // are the pre-selection gesture window and the reconnect dump.
  t.eq(base.screen_only.preserved, true, 'BASE: an already-established selection does survive a screen refresh (that guard worked)');
  t.eq(base.reconnect_dump.preserved, false, 'BASE: a reconnect dump wipes an established selection');
  t.ok([base.pre_selection_gesture.stable, base.reconnect_dump.preserved].includes(false),
    'BASE: at least one relevant condition reproduces the reported failure');
  t.eq(cand.screen_only.preserved, true, 'CANDIDATE: a screen refresh keeps the selection');
  t.eq(cand.output_only.preserved, true, 'CANDIDATE: appended output keeps the selection');
  t.eq(cand.reconnect_dump.preserved, true, 'CANDIDATE: a reconnect dump keeps the selection');
  t.eq(cand.pruning.preserved, true, 'CANDIDATE: pruning past 1000 messages keeps the selection');
  t.eq(cand.list_header_refresh.preserved, true, 'CANDIDATE: a list/header/brief refresh keeps the selection');
  t.eq(cand.ancestor_gestures.touchendDefaultPrevented, false, 'CANDIDATE: no ancestor preventDefaults a transcript touchend');
  t.ok(cand.ancestor_gestures.chain.every(n => n.userSelect !== 'none'), 'CANDIDATE: no ancestor disables selection');
  t.note('diagnosis', { base: base.pre_selection_gesture, candidate: cand.pre_selection_gesture });
}

export async function mobileStreamSelection(ctx, t) {
  const { context, page } = await openMobile(ctx);
  const caps = await engineCapabilities(page);
  t.note('mobileCapabilities', caps);
  await emit(page, 'output', `initial history\n${UNICODE_LINE}\n`);
  await emit(page, 'screen', `${TARGET}\n`);
  await page.waitForSelector('#terminal .msg-screen');

  // 1. Attempt a native long press and report honestly what the engine did.
  const press = await touchLongPress(page, '#terminal .msg-screen', 900);
  const nativeSelection = press.selection && press.selection.length > 0;
  t.note('nativeLongPress', { ...press, producedSelection: nativeSelection });
  t.ok(press.attempted, 'a touch long-press was attempted on the transcript');
  await startStream(page, 100);
  await page.waitForTimeout(3100);
  const held = await page.evaluate(() => ({
    mode: transcript.mode(),
    screenText: (document.querySelector('#terminal .msg-screen') || {}).textContent || '',
    selection: String(window.getSelection()),
  }));
  t.eq(held.mode === 'live', false, 'the gesture put the transcript into a protected mode');
  t.includes(held.screenText, TARGET, 'the touched text is byte-identical after 3s of both stream types');
  if (nativeSelection) t.eq(held.selection, press.selection, 'a native selection stayed byte-identical for 3 seconds');

  // 2. The delivered visible fallback, exercised regardless of native capability.
  await page.evaluate(() => transcript.resume());
  await page.click('#copy-open');
  await page.waitForSelector('#copy-sheet:not([hidden])');
  await page.click('#copy-select-all');
  const before = await page.evaluate(() => {
    const ta = document.getElementById('copy-text');
    return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  });
  t.ok(before.end > before.start && before.value.includes(UNICODE_LINE), 'the snapshot holds the transcript text and is selected');

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
  await page.screenshot({ path: `${ctx.artifactDir}/mobile-copy.png` });
  await context.close();
}

async function readRealClipboard(page, context) {
  // Preferred: ask the engine for the system clipboard.
  const direct = await page.evaluate(async () => {
    try { return { ok: true, text: await navigator.clipboard.readText() }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  if (direct.ok) return { via: 'navigator.clipboard.readText', ...direct };
  // Fallback: paste into an independent editable destination in a separate page.
  const sink = await context.newPage();
  await sink.setContent('<textarea id="sink" style="width:90%;height:200px"></textarea>');
  await sink.click('#sink');
  await sink.keyboard.press('Meta+V');
  await sink.waitForTimeout(150);
  let text = await sink.inputValue('#sink');
  if (!text) {
    await sink.keyboard.press('Control+V');
    await sink.waitForTimeout(150);
    text = await sink.inputValue('#sink');
  }
  await sink.close();
  return { via: 'paste into an independent editable destination', ok: text.length > 0, text, readTextError: direct.error };
}

export async function clipboardAndFailure(ctx, t) {
  const report = { engines: {} };

  for (const [engineName, launcher, device] of [
    ['webkit-mobile', ctx.webkit, ctx.devices['iPhone 13']],
    ['chromium-desktop', ctx.chromium, null],
  ]) {
    const browser = await launcher.launch();
    try {
      const contextOpts = device ? { ...device } : { viewport: { width: 1280, height: 860 } };
      if (engineName.startsWith('chromium')) contextOpts.permissions = ['clipboard-read', 'clipboard-write'];
      const context = await browser.newContext(contextOpts);
      await context.addInitScript(() => {
        window.__sockets = [];
        window.WebSocket = class {
          static OPEN = 1;
          constructor(url) { this.url = url; this.readyState = 1; window.__sockets.push(this); setTimeout(() => this.onopen && this.onopen({}), 0); }
          send() {} close() { this.readyState = 3; }
        };
        window.EventSource = class { close() {} };
      });
      await context.addInitScript(STANDALONE_STUB);
      const page = await context.newPage();
      await page.goto(`${ctx.origin}/?open=A`);
      await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
      await emit(page, 'output', `first line\n${UNICODE_LINE}\nlast line\n`);
      await page.waitForSelector('#terminal .msg');

      const caps = await engineCapabilities(page);
      await page.click('#copy-open');
      await page.waitForSelector('#copy-sheet:not([hidden])');
      const expected = await page.inputValue('#copy-text');
      await page.click('#copy-all');
      await page.waitForTimeout(200);
      const status = await page.textContent('#copy-status');
      const state = await page.getAttribute('#copy-sheet', 'data-copy-state');
      const clip = await readRealClipboard(page, context);
      report.engines[engineName] = { caps, status, state, clip: { ...clip, text: (clip.text || '').slice(0, 400) }, expectedLength: expected.length };

      if (state === 'copied') {
        t.ok(clip.ok, `${engineName}: a copy reported as succeeded is readable back from the real clipboard`);
        if (clip.ok) {
          t.eq(clip.text, expected, `${engineName}: the pasted text is exactly the transcript snapshot`);
          t.includes(clip.text, UNICODE_LINE, `${engineName}: Unicode and tabs survive the copy`);
          t.ok(!clip.text.includes('Copy selection') && !clip.text.includes('Project goal'),
            `${engineName}: no control label or brief text is included`);
        }
      } else {
        t.includes(status, 'Copy failed', `${engineName}: a copy that did not succeed says so instead of claiming success`);
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
      await denied.addInitScript(() => {
        window.__sockets = [];
        window.WebSocket = class {
          static OPEN = 1;
          constructor() { this.readyState = 1; window.__sockets.push(this); setTimeout(() => this.onopen && this.onopen({}), 0); }
          send() {} close() {}
        };
        window.EventSource = class { close() {} };
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
  saveArtifact(ctx.artifactDir, 'clipboard-evidence.json', report);
  t.note('clipboard', report.engines);
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
  t.ok(selected.length > 0, 'a real mouse drag selected transcript text');
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

  // At the bottom, live streaming follows the bottom.
  await page.evaluate(() => { const v = document.getElementById('terminal'); v.scrollTop = v.scrollHeight; v.dispatchEvent(new Event('scroll')); });
  await emit(page, 'output', 'tail line\n');
  await page.waitForTimeout(100);
  const atBottom = await page.evaluate(() => {
    const v = document.getElementById('terminal');
    return v.scrollHeight - v.scrollTop - v.clientHeight < 120;
  });
  t.ok(atBottom, 'streaming keeps following the bottom when the user is at the bottom');

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

  // Bounded buffer: overflow keeps the stable snapshot and asks for a fresh one on resume.
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
