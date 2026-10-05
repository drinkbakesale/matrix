// Engine-capability evidence: which code path actually destroys a mobile transcript
// selection, and what can each engine's automation and clipboard actually do?
//
// Each condition is isolated and measured separately, on the frozen base and on the
// candidate, through the same original mobile surface. Condition 1 needs no selection at all
// — it measures the node under the finger during the long-press, which is the window iOS
// needs and which a "defer while a selection exists" guard cannot see.

import {
  emit, startStream, stopStream, newPage, engineCapabilities, saveArtifact,
  SOCKET_STUB, STANDALONE_STUB, readRealClipboard,
} from './browser-support.mjs';

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

// The Copy::diagnosis_and_base_failure case itself. It lives here, beside the conditions
// it asserts on, so a change to a measurement and the assertion that reads it cannot
// drift apart in separate files.
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
  // t-20260915 change), so that is not the defect. The two it does fail are the
  // pre-selection gesture window and the reconnect dump.
  t.eq(base.screen_only.preserved, true, 'BASE: an already-established selection does survive a screen refresh (that guard worked)');
  t.eq(base.reconnect_dump.preserved, false, 'BASE: a reconnect dump wipes an established selection');
  t.ok([base.pre_selection_gesture.stable, base.reconnect_dump.preserved].includes(false),
    'BASE: at least one relevant condition reproduces the reported failure');
  t.eq(cand.screen_only.preserved, true, 'CANDIDATE: a screen refresh keeps the selection');
  t.eq(cand.output_only.preserved, true, 'CANDIDATE: appended output keeps the selection');
  t.eq(cand.reconnect_dump.preserved, true, 'CANDIDATE: a reconnect dump keeps the selection');
  // Pruning only means something if the workload actually prunes: both variants must show
  // the control capping the node count and dropping an identified old node.
  for (const [variant, conds] of [['BASE', base], ['CANDIDATE', cand]]) {
    const ctl = conds.pruning_control;
    t.ok(ctl.messagesEmitted > ctl.pruneLimit, `${variant}: the pruning workload emits more than the ${ctl.pruneLimit}-node limit as separate messages`);
    t.eq(ctl.cappedAtPruneLimit, true, `${variant}: unprotected control is capped exactly at the prune limit (${ctl.nodesBeforeFlood}+${ctl.messagesEmitted} emitted, ${ctl.nodesAfterFlood} left, limit ${ctl.pruneLimit})`);
    t.eq(ctl.oldestNodeRemoved, true, `${variant}: unprotected control removed the identified oldest node`);
    t.eq(ctl.newestMessageKept, true, `${variant}: pruning dropped the oldest nodes, not the newest`);
    t.eq(conds.pruning.entryState.selection, '', `${variant}: the pruning condition starts with no inherited selection`);
  }
  t.eq(cand.pruning_control.stateBefore.mode, 'live', 'CANDIDATE: the unprotected control really is unprotected');
  t.eq(cand.pruning.preserved, true, 'CANDIDATE: pruning past 1000 messages keeps the selection');
  t.eq(cand.pruning.nodeConnected, true, 'CANDIDATE: the selected node survives the pruning workload');
  t.eq(cand.list_header_refresh.preserved, true, 'CANDIDATE: a list/header/brief refresh keeps the selection');
  t.eq(cand.ancestor_gestures.touchendDefaultPrevented, false, 'CANDIDATE: no ancestor preventDefaults a transcript touchend');
  t.ok(cand.ancestor_gestures.chain.every(n => n.userSelect !== 'none'), 'CANDIDATE: no ancestor disables selection');
  t.note('diagnosis', { base: base.pre_selection_gesture, candidate: cand.pre_selection_gesture });
}

// The clipboard round-trip case. It lives beside the other capability evidence because
// that is what it is: what each engine can really put on, and read back from, the system
// clipboard through the delivered control.
const UNICODE_LINE = 'café 日本語 — copy me exactly\twith a tab';
// Fixed here rather than read back out of `#copy-text`: reading the expectation from the
// application's own snapshot is self-referential.
const COPY_FIXTURE = `first line\n${UNICODE_LINE}\nlast line\n`;

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
        ta.focus(); ta.setSelectionRange(s, e);
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
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: { writeText: () => Promise.reject(new DOMException('NotAllowedError: write permission denied')) } });
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
