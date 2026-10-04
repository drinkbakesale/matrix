// Browser-side helpers: a stubbed WebSocket at the network boundary (the application DOM is
// never faked), a repeating output/screen source, and honest capability recording.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function playwright() {
  return require('playwright');
}

export const SOCKET_STUB = () => {
  window.__sockets = [];
  window.__sent = [];
  window.WebSocket = class {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      window.__sockets.push(this);
      setTimeout(() => { if (this.onopen) this.onopen({}); }, 0);
    }
    send(data) { window.__sent.push(data); }
    close() { this.readyState = 3; }
  };
  window.EventSource = class { constructor() { this.onmessage = null; } close() {} };
};

export const STANDALONE_STUB = () => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (q) => (String(q).includes('display-mode: standalone')
    ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }
    : real(q));
};

export async function newPage(browser, { device, viewport, init = [] } = {}) {
  const context = await browser.newContext(device ? { ...device } : { viewport: viewport || { width: 1280, height: 860 } });
  await context.addInitScript(SOCKET_STUB);
  for (const script of init) await context.addInitScript(script);
  const page = await context.newPage();
  return { context, page };
}

export const emit = (page, type, data) => page.evaluate(([t, d]) => {
  const s = window.__sockets.at(-1);
  s.onmessage({ data: JSON.stringify({ type: t, data: d }) });
}, [type, data]);

// A reconnect: the client's own onclose handler makes a new socket, and the server always
// re-sends the whole scrollback as that connection's first output.
export const reconnect = (page, dump) => page.evaluate((text) => {
  const old = window.__sockets.at(-1);
  if (old.onclose) old.onclose({});
  return new Promise(r => setTimeout(() => {
    const next = window.__sockets.at(-1);
    next.onmessage({ data: JSON.stringify({ type: 'output', data: text }) });
    r(window.__sockets.length);
  }, 1700));
}, dump);

export const startStream = (page, periodMs = 100, label = '') => page.evaluate(([ms, tag]) => {
  window.__n = 0;
  window.__timer = setInterval(() => {
    const s = window.__sockets.at(-1);
    const n = ++window.__n;
    s.onmessage({ data: JSON.stringify({ type: 'output', data: `stream line ${n}\n` }) });
    s.onmessage({ data: JSON.stringify({ type: 'screen', data: `screen refresh ${n}${tag}\n` }) });
  }, ms);
}, [periodMs, label]);

export const stopStream = page => page.evaluate(() => { clearInterval(window.__timer); return window.__n; });

export const streamCount = page => page.evaluate(() => window.__n || 0);

// Real engine-driven selection: a mouse press, move and release. It is genuine browser input
// (not a scripted Range and not a synthetic DOM event), but it is a mouse, not an iOS finger.
export async function dragSelect(page, box, { fromRatio = 0.08, toRatio = 0.8, holdMs = 0 } = {}) {
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * fromRatio, y);
  await page.mouse.down();
  if (holdMs) await page.waitForTimeout(holdMs);
  await page.mouse.move(box.x + box.width * toRatio, y, { steps: 12 });
  await page.mouse.up();
  return page.evaluate(() => String(window.getSelection()));
}

// SYNTHETIC. Scripted DOM events only: `isTrusted` is false, so this can demonstrate a
// causal DOM race but can never establish whether a real long press would select text.
// It completes the gesture (release) instead of leaving a pointer down forever.
export async function syntheticLongPress(page, selector, holdMs = 900, { release = true } = {}) {
  return page.evaluate(async ([sel, hold, doRelease]) => {
    const el = document.querySelector(sel);
    if (!el) return { kind: 'synthetic', attempted: false, reason: 'target missing' };
    const rect = el.getBoundingClientRect();
    const x = rect.x + Math.min(30, rect.width / 3);
    const y = rect.y + Math.min(14, rect.height / 2);
    const report = {
      kind: 'synthetic dispatchEvent sequence (isTrusted=false)', attempted: true, x, y,
      touchConstructor: null, selectionDuringHold: '', selectionAfterRelease: '', released: false,
      textAtPress: el.textContent, textDuringHold: '',
    };
    try { new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); report.touchConstructor = 'constructible'; }
    catch (e) { report.touchConstructor = `illegal: ${e.message}`; }
    const list = (typeof document.createTouchList === 'function' && typeof document.createTouch === 'function')
      ? document.createTouchList(document.createTouch(window, el, 1, x, y, x, y))
      : null;
    const readMode = () => (typeof transcript === 'undefined' ? 'n/a' : transcript.mode());
    report.modeBeforePress = readMode();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
    report.modeAfterPointerDown = readMode();
    if (list) el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: list, targetTouches: list, changedTouches: list }));
    report.modeAfterTouchStart = readMode();
    await new Promise(r => setTimeout(r, hold));
    report.modeDuringHold = readMode();
    report.selectionDuringHold = String(window.getSelection());
    report.textDuringHold = el.textContent;
    report.stillConnected = el.isConnected;
    report.calloutStyle = getComputedStyle(el).webkitTouchCallout || null;
    report.userSelect = getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect || null;
    if (doRelease) {
      const empty = typeof document.createTouchList === 'function' ? document.createTouchList() : null;
      if (list) el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: empty, targetTouches: empty, changedTouches: list }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
      report.released = true;
      await new Promise(r => setTimeout(r, 150));
      report.selectionAfterRelease = String(window.getSelection());
    }
    return report;
  }, [selector, holdMs, release]);
}

// A SUSTAINED TOUCH, delivered by the engine itself — not a mouse standing in for a finger
// and not a scripted TouchEvent. The only mechanism in the pinned Playwright that can hold
// a touch down for a measured interval is the Chromium devtools protocol's
// `Input.dispatchTouchEvent`, which takes touchStart and touchEnd as separate commands.
//
// WebKit has no such facility: `browserContext.newCDPSession` refuses outside Chromium, and
// playwright-core/lib/server/webkit/wkInput.js sends only `Input.dispatchTapEvent` for
// touch — an atomic tap with no press duration. So on WebKit this reports, in the artifact,
// that a >=850ms touch CANNOT be produced, and delivers the one real touch the engine does
// support (a trusted tap) rather than dressing up a pointer hold as a finger.
export async function sustainedTouch(page, context, box, holdMs = 900, { watch } = {}) {
  const x = box.x + Math.min(30, box.width / 3);
  const y = box.y + Math.min(14, box.height / 2);
  const report = {
    requestedHoldMs: holdMs, x, y,
    mechanism: null, sustained: false, events: [], heldMs: null,
    textAtPress: null, textDuringHold: null, selectionDuringHold: '', selectionAfterRelease: '',
    tap: null, limitation: null, error: null,
  };
  const look = () => (watch ? page.evaluate(sel => {
    const el = document.querySelector(sel);
    return el ? el.textContent : null;
  }, watch) : Promise.resolve(null));
  // Record what the page actually received, with isTrusted and arrival times, so the
  // artifact shows real input rather than a claim about it.
  await page.evaluate(() => {
    window.__touchLog = [];
    for (const type of ['touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup']) {
      document.addEventListener(type, e => window.__touchLog.push(
        { type: e.type, isTrusted: e.isTrusted, at: Math.round(performance.now()) }), true);
    }
  });

  let cdp = null;
  try {
    cdp = await context.newCDPSession(page);
  } catch (err) {
    report.limitation = `no sustained-touch mechanism: ${err.message.split('\n')[0]}. `
      + 'This engine\'s automation exposes only Input.dispatchTapEvent for touch (an atomic '
      + 'tap with no press duration), so a held touch cannot be delivered here at all.';
  }

  if (cdp) {
    try {
      const started = Date.now();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      report.textAtPress = await look();
      await page.waitForTimeout(holdMs);
      report.textDuringHold = await look();
      report.selectionDuringHold = await page.evaluate(() => String(window.getSelection()));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      report.heldMs = Date.now() - started;
      report.mechanism = 'CDP Input.dispatchTouchEvent (touchStart, hold, touchEnd)';
      report.sustained = true;
      report.selectionAfterRelease = await page.evaluate(() => String(window.getSelection()));
    } catch (err) {
      report.error = err.message.split('\n')[0];
    }
  } else {
    // The real touch this engine can deliver. A tap, explicitly labelled a tap.
    try {
      report.textAtPress = await look();
      await page.touchscreen.tap(x, y);
      report.tap = 'touchscreen.tap delivered (atomic, no press duration)';
      report.mechanism = 'Playwright touchscreen.tap';
      report.textDuringHold = await look();
      report.selectionAfterRelease = await page.evaluate(() => String(window.getSelection()));
    } catch (err) {
      report.error = err.message.split('\n')[0];
    }
  }
  report.events = await page.evaluate(() => window.__touchLog || []);
  const touches = report.events.filter(e => e.type.startsWith('touch'));
  report.touchEventsDelivered = touches.length;
  report.allTouchEventsTrusted = touches.length > 0 && touches.every(e => e.isTrusted);
  const down = touches.find(e => e.type === 'touchstart');
  const up = touches.find(e => e.type === 'touchend');
  report.observedPressMs = down && up ? up.at - down.at : null;
  return report;
}

// The sustained-touch half of the gesture evidence, run on the engine whose automation can
// actually hold a touch down. Same delivered page and same mobile emulation as the WebKit
// attempt; only the engine differs, because only this one exposes touchStart/touchEnd.
export async function sustainedTouchOnChromium(ctx, t, { target, unicodeLine }) {
  const browser = await ctx.chromium.launch();
  try {
    const context = await browser.newContext({ ...ctx.devices['Pixel 7'] });
    await context.addInitScript(SOCKET_STUB);
    const page = await context.newPage();
    await page.goto(`${ctx.origin}/?open=A`);
    await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
    await emit(page, 'output', `initial history\n${unicodeLine}\n`);
    await emit(page, 'screen', `${target}\n`);
    await page.waitForSelector('#terminal .msg-screen');
    await startStream(page, 100, ` ${target}`);
    const box = await page.evaluate(() => {
      const r = document.querySelector('#terminal .msg-screen').getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const held = await sustainedTouch(page, context, box, 900, { watch: '#terminal .msg-screen' });
    await stopStream(page);
    t.note('chromiumSustainedTouch', { engine: 'chromium', version: browser.version(), ...held });
    t.eq(held.sustained, true, 'a sustained touch was delivered through the engine, not a mouse or a scripted event');
    t.eq(held.allTouchEventsTrusted, true, 'the sustained touch events were engine-generated (isTrusted)');
    t.ok(held.observedPressMs >= 850,
      `the touch was actually held down for >=850ms (page observed ${held.observedPressMs}ms between touchstart and touchend)`);
    t.includes(held.textAtPress, target, 'the touched node holds real transcript text');
    t.eq(held.textDuringHold, held.textAtPress,
      'the touched text is byte-identical across a real held touch while both stream types keep arriving');
    // Whatever the gesture recognizer does or does not do is recorded, never asserted into
    // a pass: headless Chromium has no long-press text-selection gesture either.
    t.note('sustainedTouchSelection', {
      selectionDuringHold: held.selectionDuringHold,
      producedSelection: !!held.selectionDuringHold,
      note: 'Neither pinned engine runs the iOS long-press selection gesture. Touch delivery is proven; native selection handles are not available in either, which is why the visible fallback is mandatory.',
    });
  } finally {
    await browser.close();
  }
}

// Replays a `stream-target` announcement on the page's current socket, exactly as the
// server sends it on every connection. `override` supplies the announcement a connection
// made EARLIER — a connection that opened before Claude started announced window:"" and
// keeps announcing nothing until it reconnects, which live fixture state cannot express.
export async function announceStreamTarget(page, control, session, override) {
  const info = override || await control(page, 'stream-target', { session });
  await page.evaluate(msg => {
    window.__sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'stream-target', ...msg }) });
  }, info);
  await page.waitForTimeout(80);
  return info;
}

// No Claude running when the session is opened.
//
// The connection finds none, keeps the bare session as its target — which tmux resolves to
// the active window — and announces window:"". A client that reads that as "not told yet"
// lets the server go looking for Claude on every later poll, so starting Claude in the
// inactive window silently re-points the brief off the open transcript. Run against both
// delivered clients; `deps` supplies the case module's own page helpers and fixtures.
export async function emptyWindowBindingCases(ctx, t, deps) {
  const { page, control, readBrief, settleAndRefresh, openClient, F1, F3 } = deps;
  for (const kind of ['mobile', 'desktop']) {
    // Each client starts from a brand-new session with Claude running nowhere, so the
    // second pass cannot inherit the first pass's window layout, brief or edit.
    await control(page, 'move-claude', { session: 'C', window: '' });
    await control(page, 'reincarnate', { session: 'C' });
    const { context: cctx, page: c } = await openClient(ctx, kind, 'C');
    const announceC = override => announceStreamTarget(c, control, 'C', override);

    const atOpen = await announceC();
    t.eq(atOpen.window, '', `${kind}: a session with no Claude announces no window`);
    t.eq(atOpen.target, 'C', `${kind}: the stream target is the session itself`);
    t.eq(await c.evaluate(() => briefView.bound()), true, `${kind}: an announced empty window is still a binding`);
    await control(c, 'advance', { ms: 31000 });
    await settleAndRefresh(c);
    t.eq((await readBrief(c)).goal, F1.goal, `${kind}: the brief describes the window being streamed`);

    // Claude starts in the INACTIVE window two. This connection still streams the session.
    await control(c, 'move-claude', { session: 'C', window: 'two' });
    await control(c, 'advance', { ms: 31000 });
    await settleAndRefresh(c);
    const stillBound = await readBrief(c);
    t.eq(stillBound.goal, F1.goal, `${kind}: starting Claude elsewhere does not re-point an open brief`);
    t.ok(!stillBound.goal.includes(F3.goal) && !stillBound.current.includes(F3.current),
      `${kind}: the other window's work never takes over the open session`);

    await c.click('#brief-edit-goal');
    await c.waitForSelector('#brief-input-goal');
    await c.fill('#brief-input-goal', 'edit against the streamed pane');
    await c.click('#brief-save-goal');
    await c.waitForTimeout(150);
    t.eq((await readBrief(c)).goal, 'edit against the streamed pane', `${kind}: the edit is saved against the streamed pane`);

    // Reconnect through the client's own onclose path: the new connection discovers Claude.
    await reconnect(c, 'reconnected dump\n');
    t.eq((await announceC()).window, 'two', `${kind}: the reconnect discovers Claude's new window`);
    await control(c, 'advance', { ms: 31000 });
    await settleAndRefresh(c);
    await settleAndRefresh(c);
    t.eq(await c.evaluate(() => briefView.window()), 'two', `${kind}: the brief re-binds to the discovered window`);
    const reboundBrief = await readBrief(c);
    t.eq(reboundBrief.goal, F3.goal, `${kind}: after the reconnect the brief describes window two`);
    t.ok(!reboundBrief.goal.includes('edit against the streamed pane'),
      `${kind}: the edit stays with the pane it was made against`);

    await inFlightAcrossEmptyBinding(c, t, kind, { control, readBrief, settleAndRefresh, announceC, F1, F3 });
    await cctx.close();
  }
}

// The window string does not change, but the binding does.
//
// A client that has not been told its window yet asks the server to find Claude, so while
// Claude is running in window two an UNBOUND read answers for C:two and an unbound edit is
// addressed there. Both can still be in flight when the connection announces window:"".
// Neither may land afterwards: the answers belong to a pane this view is no longer showing.
// Only an epoch bump on becoming bound stops them, which is why it cannot be conditional on
// the window string changing.
async function inFlightAcrossEmptyBinding(page, t, kind, deps) {
  const { control, readBrief, settleAndRefresh, announceC, F1, F3 } = deps;
  const emptyAnnouncement = { session: 'C', window: '', target: 'C' };
  // Back to unbound, with Claude in window two so discovery answers for a different pane.
  await page.evaluate(() => briefView.open('C', ''));
  t.eq(await page.evaluate(() => briefView.bound()), false, `${kind}: a fresh open is not bound yet`);
  await control(page, 'advance', { ms: 31000 });
  await settleAndRefresh(page);
  t.eq((await readBrief(page)).goal, F3.goal, `${kind}: while unbound the server discovers Claude in window two`);

  await control(page, 'hold', { session: 'C' });
  // An unbound GET, then an unbound edit, both captured against C:two and held.
  await page.evaluate(() => { briefView.refresh(); });
  await page.waitForTimeout(150);
  await page.click('#brief-edit-goal');
  await page.waitForSelector('#brief-input-goal');
  await page.fill('#brief-input-goal', 'obsolete save from the unbound view');
  await page.click('#brief-save-goal');
  await page.waitForTimeout(150);
  t.ok((await control(page, 'held', { session: 'C' })).count >= 2,
    `${kind}: an unbound read and an unbound edit are both in flight`);

  // The connection announces window:"" — the same string the client already had.
  // The edit's acknowledgement is still held, so its editor is still open and still holds
  // the typed text when the connection announces window:"" — the same string the client
  // already had.
  t.ok(await page.evaluate(() => !!document.getElementById('brief-input-goal')),
    `${kind}: the unbound edit is still open while its acknowledgement is held`);
  await announceC(emptyAnnouncement);
  t.eq(await page.evaluate(() => briefView.bound()), true, `${kind}: the announcement binds even with an unchanged window`);
  t.ok(await page.evaluate(() => !document.getElementById('brief-input-goal')),
    `${kind}: rebinding closes the editor that belonged to the other pane`);

  await control(page, 'release', { session: 'C', count: 2 });   // FIFO: the GET then the PATCH
  await page.waitForTimeout(300);
  const stale = await page.evaluate(() => ({
    brief: document.getElementById('brief').textContent,
    goal: document.getElementById('brief-goal').textContent,
    note: document.getElementById('brief-status').textContent,
    editor: !!document.getElementById('brief-input-goal'),
  }));
  t.ok(!stale.goal.includes(F3.goal), `${kind}: the released unbound read cannot render the other pane's text`);
  t.ok(!stale.brief.includes('obsolete save from the unbound view'),
    `${kind}: the released edit acknowledgement cannot render an obsolete save`);
  t.ok(!/not saved/i.test(stale.note), `${kind}: no obsolete save failure is reported`);
  t.eq(stale.editor, false, `${kind}: a stale acknowledgement does not resurrect an editor`);

  await control(page, 'release', { session: 'C' });
  await control(page, 'unhold', { session: 'C' });
  await settleAndRefresh(page);
  // The streamed pane's own saved edit, made earlier against this exact target, survived
  // the detour through the unbound view.
  t.eq((await readBrief(page)).goal, 'edit against the streamed pane',
    `${kind}: the bound view converges on the streamed pane's own brief`);

  // ...and an answer arriving while the user is mid-edit leaves that editor alone.
  await page.click('#brief-edit-goal');
  await page.waitForSelector('#brief-input-goal');
  await page.fill('#brief-input-goal', 'still typing this one');
  await settleAndRefresh(page);
  t.eq(await page.evaluate(() => document.getElementById('brief-input-goal').value), 'still typing this one',
    `${kind}: a brief refresh does not disturb an open editor`);
  await page.click('#brief-cancel-goal');
  await page.waitForTimeout(80);
}

export function saveArtifact(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return file;
}

export async function engineCapabilities(page) {
  return page.evaluate(() => ({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    hasTouchConstructor: (() => { try { new Touch({ identifier: 0, target: document.body, clientX: 0, clientY: 0 }); return true; } catch { return false; } })(),
    hasCreateTouch: typeof document.createTouch === 'function',
    hasClipboard: !!(navigator.clipboard && navigator.clipboard.writeText),
    hasClipboardRead: !!(navigator.clipboard && navigator.clipboard.readText),
    standalone: window.matchMedia('(display-mode: standalone)').matches,
  }));
}
