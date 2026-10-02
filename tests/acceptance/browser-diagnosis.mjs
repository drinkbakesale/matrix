// The diagnosis: which code path actually destroys a mobile transcript selection?
//
// Each condition is isolated and measured separately, on the frozen base and on the
// candidate, through the same original mobile surface. Condition 1 needs no selection at all
// — it measures the node under the finger during the long-press, which is the window iOS
// needs and which a "defer while a selection exists" guard cannot see.

import { emit, startStream, stopStream } from './browser-support.mjs';

const TARGET = 'selection target café 日本語';
// MAX_DOM_MESSAGES in both the base renderer and the delivered transcript controller.
const PRUNE_LIMIT = 1000;

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
    const result = {
      connected: original.isConnected,
      yStable: after.y === rect.y,
      stable: original.isConnected && after.y === rect.y,
      updates: n,
      text: original.textContent,
    };
    // Release the gesture here, inside the measurement, so the held pointer cannot leak
    // into any later condition and protect it by accident.
    const empty = typeof document.createTouchList === 'function' ? document.createTouchList() : null;
    if (list) original.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: empty, targetTouches: empty, changedTouches: list }));
    original.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', clientX: x, clientY: y }));
    return result;
  });
}

// Conditions must not inherit each other's state. This clears any selection, completes any
// gesture still in progress and waits past the release grace, on base and candidate alike
// (the base has no transcript controller, so nothing here may depend on one).
async function resetConditionState(page) {
  await page.evaluate(() => {
    const term = document.getElementById('terminal');
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    if (term) {
      const empty = typeof document.createTouchList === 'function' ? document.createTouchList() : null;
      if (empty) term.dispatchEvent(new TouchEvent('touchcancel', { bubbles: true, touches: empty, targetTouches: empty, changedTouches: empty }));
      term.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }));
      term.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    }
  });
  await page.waitForTimeout(250);
  return page.evaluate(() => ({
    mode: typeof transcript === 'undefined' ? 'n/a (base has no transcript controller)' : transcript.mode(),
    selection: String(window.getSelection()),
  }));
}

// Emits `count` SEPARATE output messages. The delivered renderer makes one .msg node per
// message, so this is the only way to actually cross the 1000-node pruning threshold; one
// big blob is a single node and never prunes anything.
function floodMessages(page, count, label) {
  return page.evaluate(([n, tag]) => {
    const s = window.__sockets.at(-1);
    for (let i = 0; i < n; i += 1) {
      s.onmessage({ data: JSON.stringify({ type: 'output', data: `${tag} ${i}\n` }) });
    }
    return document.getElementById('terminal').querySelectorAll('.msg').length;
  }, [count, label]);
}

// The unprotected control: with nothing selected and no gesture held, pruning must actually
// fire — node count capped and an identified old node gone from the DOM. Without this a
// "selection survived pruning" result could just mean pruning never ran.
async function pruningControl(page) {
  const state = await resetConditionState(page);
  await floodMessages(page, 200, 'control warmup');
  const marked = await page.evaluate(() => {
    const term = document.getElementById('terminal');
    window.__oldestNode = term.querySelector('.msg');
    return { nodes: term.querySelectorAll('.msg').length, oldestText: window.__oldestNode ? window.__oldestNode.textContent : '' };
  });
  const emitted = 1400;
  await floodMessages(page, emitted, 'control prune filler');
  const after = await page.evaluate((last) => {
    const term = document.getElementById('terminal');
    const nodes = term.querySelectorAll('.msg');
    return {
      nodes: nodes.length,
      oldestStillConnected: window.__oldestNode ? window.__oldestNode.isConnected : null,
      newestText: nodes.length ? nodes[nodes.length - 1].textContent : '',
      lastFillerPresent: nodes.length ? nodes[nodes.length - 1].textContent.includes(last) : false,
    };
  }, `control prune filler ${emitted - 1}`);
  return {
    stateBefore: state,
    nodesBeforeFlood: marked.nodes,
    messagesEmitted: emitted,
    nodesAfterFlood: after.nodes,
    pruneLimit: PRUNE_LIMIT,
    // Capped exactly at the renderer's limit: more nodes were created than the limit and
    // the surplus was dropped. A workload that only made one node cannot satisfy this.
    cappedAtPruneLimit: after.nodes === PRUNE_LIMIT,
    oldestNodeRemoved: after.oldestStillConnected === false,
    newestMessageKept: after.lastFillerPresent,
    oldestText: marked.oldestText,
    newestText: after.newestText,
  };
}

// Conditions 2-6 — selection lifetime. The selection here is created with a scripted Range:
// that is explicitly a selection-lifetime subtest, and is never evidence that a long press
// produced a selection.
async function selectionLifetime(page, kind) {
  // Every condition starts from the same clean state: no selection, no gesture in flight.
  const entryState = await resetConditionState(page);
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
    // The same workload the unprotected control used: >1000 real message nodes.
    await floodMessages(page, 1400, 'protected prune filler');
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

  const result = await page.evaluate(() => ({
    before: window.__selectedBefore,
    after: String(window.getSelection()),
    preserved: String(window.getSelection()) === window.__selectedBefore && window.__selectedBefore.length > 0,
    nodeConnected: window.__selectedNode ? window.__selectedNode.isConnected : false,
    nodes: document.getElementById('terminal').querySelectorAll('.msg').length,
  }));
  return { entryState, ...result };
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
  // Unprotected control first: prove the pruning workload really prunes, so the protected
  // result below means something.
  result.conditions.pruning_control = await pruningControl(page);
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
