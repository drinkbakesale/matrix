// The diagnosis: which code path actually destroys a mobile transcript selection?
//
// Each condition is isolated and measured separately, on the frozen base and on the
// candidate, through the same original mobile surface. Condition 1 needs no selection at all
// — it measures the node under the finger during the long-press, which is the window iOS
// needs and which a "defer while a selection exists" guard cannot see.

import { emit, startStream, stopStream } from './browser-support.mjs';

const TARGET = 'selection target café 日本語';

async function prime(page) {
  await page.waitForFunction(() => window.__sockets.some(s => s.onmessage));
  await emit(page, 'output', 'initial history\n');
  await emit(page, 'screen', `${TARGET}\n`);
  await page.waitForSelector('#terminal .msg-screen');
}

// Condition 1 — the pre-selection gesture window. No selection exists yet; the DOM node the
// finger is on must survive, in place, while both stream types keep arriving.
async function preSelectionGesture(page) {
  return page.evaluate(async () => {
    const term = document.getElementById('terminal');
    const original = term.querySelector('.msg-screen') || term.lastElementChild;
    const rect = original.getBoundingClientRect();
    const x = rect.x + 10;
    const y = rect.y + 8;
    let list = null;
    if (typeof document.createTouchList === 'function') {
      list = document.createTouchList(document.createTouch(window, original, 1, x, y, x, y));
    }
    original.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
    if (list) original.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: list, targetTouches: list, changedTouches: list }));
    const s = window.__sockets.at(-1);
    let n = 0;
    const timer = setInterval(() => {
      s.onmessage({ data: JSON.stringify({ type: 'output', data: `new ${++n}\n` }) });
      s.onmessage({ data: JSON.stringify({ type: 'screen', data: `replacement ${n}\n` }) });
    }, 100);
    await new Promise(r => setTimeout(r, 900));
    clearInterval(timer);
    const after = original.getBoundingClientRect();
    return {
      connected: original.isConnected,
      yStable: after.y === rect.y,
      stable: original.isConnected && after.y === rect.y,
      updates: n,
      text: original.textContent,
    };
  });
}

// Conditions 2-6 — selection lifetime. The selection here is created with a scripted Range:
// that is explicitly a selection-lifetime subtest, and is never evidence that a long press
// produced a selection.
async function selectionLifetime(page, kind) {
  await page.evaluate(() => {
    const term = document.getElementById('terminal');
    const node = term.querySelector('.msg-screen') || term.lastElementChild;
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.__selectedBefore = String(sel);
    window.__selectedNode = node;
  });

  if (kind === 'screen_only') {
    for (let i = 0; i < 8; i += 1) await emit(page, 'screen', `screen churn ${i}\n`);
  } else if (kind === 'output_only') {
    for (let i = 0; i < 8; i += 1) await emit(page, 'output', `appended ${i}\n`);
  } else if (kind === 'reconnect_dump') {
    await page.evaluate(() => {
      const s = window.__sockets.at(-1);
      if (s.onclose) s.onclose({});
    });
    await page.waitForTimeout(1700);
    await emit(page, 'output', `initial history\nreconnected dump\n`);
  } else if (kind === 'pruning') {
    await page.evaluate(() => {
      const s = window.__sockets.at(-1);
      let blob = '';
      for (let i = 0; i < 1100; i += 1) blob += `prune filler ${i}\n`;
      s.onmessage({ data: JSON.stringify({ type: 'output', data: blob }) });
    });
  } else if (kind === 'list_header_refresh') {
    await page.evaluate(async () => {
      if (typeof loadSessions === 'function') await loadSessions();
      const title = document.getElementById('term-title');
      if (title) title.textContent = `${title.textContent} `;
      const brief = document.getElementById('brief');
      if (brief && typeof briefView !== 'undefined' && briefView) await briefView.refresh();
    });
    await page.waitForTimeout(250);
  }

  return page.evaluate(() => ({
    before: window.__selectedBefore,
    after: String(window.getSelection()),
    preserved: String(window.getSelection()) === window.__selectedBefore && window.__selectedBefore.length > 0,
    nodeConnected: window.__selectedNode ? window.__selectedNode.isConnected : false,
  }));
}

// Condition 7 — do ancestors or their gesture handlers suppress selection/callout?
async function ancestorConditions(page) {
  return page.evaluate(() => {
    const out = { chain: [], preventedDefaults: [] };
    let node = document.getElementById('terminal');
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      out.chain.push({
        tag: node.tagName, id: node.id || null,
        userSelect: cs.webkitUserSelect || cs.userSelect,
        touchCallout: cs.webkitTouchCallout || null,
        touchAction: cs.touchAction,
      });
      node = node.parentElement;
    }
    // Does a touchend bubbling out of #terminal blur the page or cancel a selection?
    const term = document.getElementById('terminal');
    const evt = new TouchEvent('touchend', { bubbles: true, cancelable: true });
    term.dispatchEvent(evt);
    out.touchendDefaultPrevented = evt.defaultPrevented;
    out.selectionAfterTouchend = String(window.getSelection());
    return out;
  });
}

export async function diagnose(page, label) {
  await prime(page);
  const result = { variant: label, conditions: {} };
  result.conditions.pre_selection_gesture = await preSelectionGesture(page);
  for (const kind of ['screen_only', 'output_only', 'reconnect_dump', 'pruning', 'list_header_refresh']) {
    result.conditions[kind] = {
      selectionSource: 'scripted Range (labelled selection-lifetime subtest, not long-press proof)',
      ...(await selectionLifetime(page, kind)),
    };
  }
  result.conditions.ancestor_gestures = await ancestorConditions(page);
  await startStream(page, 100);
  await page.waitForTimeout(300);
  result.streamSanity = await stopStream(page);
  return result;
}

export { TARGET };
