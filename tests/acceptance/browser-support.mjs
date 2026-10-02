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

export const startStream = (page, periodMs = 100) => page.evaluate((ms) => {
  window.__n = 0;
  window.__timer = setInterval(() => {
    const s = window.__sockets.at(-1);
    const n = ++window.__n;
    s.onmessage({ data: JSON.stringify({ type: 'output', data: `stream line ${n}\n` }) });
    s.onmessage({ data: JSON.stringify({ type: 'screen', data: `screen refresh ${n}\n` }) });
  }, ms);
}, periodMs);

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

// Best-effort native long press. WebKit has no constructible Touch, so the touch point comes
// from document.createTouch/createTouchList; this is honestly recorded as a synthetic touch
// sequence driven through the real event system, never as proof an iOS callout appeared.
export async function touchLongPress(page, selector, holdMs = 900) {
  return page.evaluate(async ([sel, hold]) => {
    const el = document.querySelector(sel);
    if (!el) return { attempted: false, reason: 'target missing' };
    const rect = el.getBoundingClientRect();
    const x = rect.x + Math.min(30, rect.width / 3);
    const y = rect.y + Math.min(14, rect.height / 2);
    const report = { attempted: true, x, y, touchConstructor: null, selection: '', calloutStyle: null };
    try { new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); report.touchConstructor = 'constructible'; }
    catch (e) { report.touchConstructor = `illegal: ${e.message}`; }
    let list = null;
    if (typeof document.createTouch === 'function' && typeof document.createTouchList === 'function') {
      list = document.createTouchList(document.createTouch(window, el, 1, x, y, x, y));
    }
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
    if (list) el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: list, targetTouches: list, changedTouches: list }));
    await new Promise(r => setTimeout(r, hold));
    report.selection = String(window.getSelection());
    report.calloutStyle = getComputedStyle(el).webkitTouchCallout || null;
    report.userSelect = getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect || null;
    return report;
  }, [selector, holdMs]);
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
