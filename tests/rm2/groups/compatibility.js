// Compatibility group: the existing phone and desktop views are driven in a
// real browser against a real (isolated) tmux, on the exact base export and on
// the candidate, and must behave identically. Then the new Control app and
// event stream run next to them.
module.exports = (L) => {
  const { assert, fs, path } = L;

  function baseRoot() {
    const dir = L.tmp('base');
    const r = L.spawnSync('tar', ['xzf', path.join(L.candidate, 'tests/rm2/base/base-27534cd.tar.gz'), '-C', dir]);
    if (r.status !== 0) throw new Error('cannot extract the base export');
    fs.symlinkSync(fs.realpathSync(path.join(L.candidate, 'node_modules')), path.join(dir, 'node_modules'));
    return dir;
  }

  function realTmux() {
    const which = L.spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout.trim();
    if (!which) throw new Error('a real tmux is required for the legacy-view compatibility case');
    const sock = L.tmp('tmuxsock');
    const shim = L.tmp('shim');
    const log = path.join(shim, 'calls.log');
    fs.writeFileSync(path.join(shim, 'tmux'), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${which}" "$@"\n`, { mode: 0o755 });
    const direct = (...a) => L.spawnSync(which, a, { encoding: 'utf8', env: { ...process.env, TMUX_TMPDIR: sock, TMUX: '', TMUX_PANE: '' } });
    return { direct, log, env: { TMUX_TMPDIR: sock, TMUX: '', TMUX_PANE: '', PATH: `${shim}:${process.env.PATH}`, MATRIX_TMUX: path.join(shim, 'tmux') }, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
  }

  // Real pointer selection of the marker word in the terminal view, then a real copy shortcut.
  // Returns what the page's own selection and copy handling produced.
  async function selectAndCopy(page) {
    await page.evaluate(() => { window.__copied = null; document.addEventListener('copy', (e) => { window.__copied = String(getSelection()); window.__copyPrevented = e.defaultPrevented; }); });
    const at = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.getElementById('terminal'), NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode())) { const i = node.data.indexOf('MARKERWORD'); if (i >= 0) { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 10); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } }
      return null;
    });
    if (!at) return { selection: 'marker not rendered', copied: null };
    await page.mouse.dblclick(at.x, at.y);
    const selection = await page.evaluate(() => String(getSelection()).trim());
    await page.keyboard.press('Meta+C');
    await page.waitForTimeout(150);
    return { selection, copied: await page.evaluate(() => (window.__copied === null ? null : window.__copied.trim())) };
  }

  // Executes a worker source file with a double for the browser's worker runtime and reports what a notification click does.
  async function legacyWorkerClick(root, windows) {
    const vm = require('vm');
    const handlers = {}; const opened = []; const posted = []; const focused = [];
    const clients = { claim: async () => {}, matchAll: async () => windows.map((url) => ({ url, focus: async function focus() { focused.push(url); return this; }, postMessage: (m) => posted.push({ url, target: m.targetSession }) })), openWindow: async (u) => { opened.push(String(u)); } };
    const self = { addEventListener: (n, fn) => { handlers[n] = fn; }, skipWaiting() {}, location: new URL('http://matrix.test/'), registration: { scope: 'http://matrix.test/', showNotification: async () => {} }, clients };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'server/public/sw.js'), 'utf8'), { self, clients, caches: { keys: async () => [] }, URL, fetch: () => {}, Promise, console });
    let p; handlers.notificationclick({ notification: { close() {}, data: { targetSession: 'tmux-7', project: 'p' } }, waitUntil: (q) => { p = q; } }); await p;
    return { opened, posted, focused };
  }

  // The same legacy flow, run on whichever server root is given. Returns plain observations.
  async function legacyFlow(root, extra) {
    const tx = realTmux();
    try {
      const script = path.join(L.tmp('pane'), 'pane.sh');
      fs.writeFileSync(script, '#!/bin/sh\nprintf "LEGACY-MARKER-OUTPUT MARKERWORD tail\\n"\nexec cat\n', { mode: 0o755 });
      if (tx.direct('new-session', '-d', '-s', 'legacyproj', '-x', '100', '-y', '30', script).status !== 0) throw new Error('tmux new-session failed');
      const size = () => tx.direct('list-panes', '-a', '-F', '#{window_width}x#{window_height} #{pane_pid}').stdout.trim();
      const before = size();
      const srv = await L.startServer({ root, env: tx.env, waitReady: false });
      await L.until(async () => (await fetch(`${srv.base}/api/sessions`).catch(() => null)), 15000, 'legacy server');
      const obs = {};
      const api = await (await fetch(`${srv.base}/api/sessions`)).json();
      obs.apiListsSession = api.sessions.some((s) => s.name === 'legacyproj');
      // Phone view.
      const page = await L.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const sockets = [];
      page.on('websocket', (ws) => { const rec = { url: new URL(ws.url()).pathname + new URL(ws.url()).search, frames: 0 }; sockets.push(rec); ws.on('framereceived', () => { rec.frames += 1; }); });
      await page.goto(`${srv.base}/`);
      await page.waitForSelector('.session-card[data-session="legacyproj"]', { timeout: 10000 });
      obs.phoneListsSession = true;
      const label = (await page.textContent('.session-card[data-session="legacyproj"]')).trim().split('\n')[0].trim();
      await page.tap('.session-card[data-session="legacyproj"]');
      await page.waitForFunction(() => document.getElementById('terminal').textContent.includes('LEGACY-MARKER-OUTPUT'), null, { timeout: 10000 }).catch(async (err) => {
        throw new Error(`legacy terminal never showed the pane output (${err.message.split('\n')[0]}); terminal=${JSON.stringify((await page.textContent('#terminal')).slice(0, 200))}; termVisible=${await page.isVisible('#term-view')}; console=${JSON.stringify(page.consoleLog.slice(-4))}; pane=${JSON.stringify(tx.direct('capture-pane', '-p', '-t', 'legacyproj').stdout.slice(0, 60))}; tmuxCalls=${JSON.stringify(tx.calls().slice(-4))}`);
      });
      obs.terminalShowsOutput = true;
      obs.termViewVisible = await page.isVisible('#term-view');
      // Select and copy text from the terminal view with real pointer and keyboard input.
      const phoneCopy = await selectAndCopy(page);
      obs.phoneSelection = phoneCopy.selection;
      obs.phoneCopied = phoneCopy.copied;
      obs.userSelect = await page.evaluate(() => getComputedStyle(document.getElementById('terminal')).webkitUserSelect || getComputedStyle(document.getElementById('terminal')).userSelect);
      // Send input through the legacy input bar.
      await page.fill('#text-input', 'legacy hello');
      await page.tap('#send-btn');
      await L.until(() => tx.direct('capture-pane', '-p', '-t', 'legacyproj').stdout.includes('legacy hello'), 8000, 'legacy send to reach the pane');
      obs.sendDelivered = true;
      obs.websocketOpened = sockets.length >= 1 && sockets[0].frames > 0;
      // Back to the list.
      await page.tap('#back-btn');
      await page.waitForSelector('#list-view', { state: 'visible' });
      obs.backToList = await page.isVisible('.session-card[data-session="legacyproj"]');
      // Desktop view: navigate to the session, read its output, select + copy, send input.
      const desk = await L.newPage({ viewport: { width: 1400, height: 900 } });
      await desk.goto(`${srv.base}/desktop.html`);
      await desk.waitForSelector('.project-item[data-session="legacyproj"]', { timeout: 10000 });
      obs.desktopListsSession = true;
      await desk.click('.project-item[data-session="legacyproj"]');
      await desk.waitForFunction(() => document.getElementById('terminal').textContent.includes('MARKERWORD'), null, { timeout: 10000 });
      obs.desktopShowsOutput = await desk.isVisible('#chat-view');
      obs.desktopTitle = (await desk.textContent('#chat-title')) === label;
      const deskCopy = await selectAndCopy(desk);
      obs.desktopSelection = deskCopy.selection;
      obs.desktopCopied = deskCopy.copied;
      await desk.fill('#chat-input', 'desktop hello');
      await desk.click('#chat-send');
      await L.until(() => tx.direct('capture-pane', '-p', '-t', 'legacyproj').stdout.includes('desktop hello'), 8000, 'desktop send to reach the pane');
      obs.desktopSendDelivered = true;
      // Legacy notification endpoints.
      obs.notifyStatus = (await L.http('POST', `${srv.base}/api/notify`, { body: { project: 'legacyproj', session: 'legacyproj', tmuxSession: 'legacyproj', message: 'needs input' } })).status;
      obs.vapidStatus = (await L.http('GET', `${srv.base}/api/push/vapid-key`)).status;
      // Legacy notification click, executed from this root's own worker source.
      obs.clickNoWindow = JSON.stringify(await legacyWorkerClick(root, []));
      obs.clickPhoneWindow = JSON.stringify(await legacyWorkerClick(root, ['http://matrix.test/']));
      const more = extra ? await extra({ srv, page, tx, sockets }) : {};
      obs.sizeUnchanged = size() === before;
      obs.destructiveCalls = tx.calls().filter((l) => /^(kill-|resize-|respawn-)/.test(l)).length;
      await page.context().close(); await desk.context().close();
      await srv.stop();
      return { obs, more, calls: tx.calls() };
    } finally {
      tx.direct('kill-server');
    }
  }

  return {
    async old_views(t) {
      const base = await legacyFlow(baseRoot());
      const cand = await legacyFlow(L.candidate, async ({ srv, page, tx, sockets }) => {
        // The new Control app and its event stream run next to the legacy WebSocket.
        const control = await L.openControl(srv);
        const dev = srv.token('device');
        const res = await fetch(`${srv.api}/events`, { headers: { Authorization: `Bearer ${dev}` } });
        const reader = res.body.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        await reader.cancel();
        const listed = await control.evaluate(() => [...document.querySelectorAll('#sessions li')].map((li) => li.textContent));
        const framesBefore = sockets.reduce((n, s) => n + s.frames, 0);
        await page.tap('.session-card[data-session="legacyproj"]');
        await page.fill('#text-input', 'second legacy line');
        await page.tap('#send-btn');
        await L.until(() => tx.direct('capture-pane', '-p', '-t', 'legacyproj').stdout.includes('second legacy line'), 8000, 'legacy send while Control is open');
        const eink = tx.calls().filter((l) => /^(list-panes -a -F|capture-pane -p -J|set-buffer|paste-buffer|send-keys -t %)/.test(l));
        return { sseSnapshot: first.startsWith('event: snapshot'), controlLists: listed.some((x) => x.includes('legacyproj')), legacyStillWorks: true, wsFramesAfter: sockets.reduce((n, s) => n + s.frames, 0) > framesBefore, einkCalls: eink.length, einkResize: eink.filter((l) => /resize/.test(l)).length };
      });
      for (const [k, v] of Object.entries(base.obs)) if (v === false || v === '' || v === 0) if (!['destructiveCalls'].includes(k)) t.note(`base observation ${k}=${JSON.stringify(v)}`);
      assert.deepEqual(cand.obs, base.obs, 'the legacy phone/desktop flow observes exactly the same on the candidate as on the exact base');
      for (const k of ['apiListsSession', 'phoneListsSession', 'terminalShowsOutput', 'termViewVisible', 'sendDelivered', 'websocketOpened', 'backToList', 'desktopListsSession', 'desktopShowsOutput', 'desktopTitle', 'desktopSendDelivered', 'sizeUnchanged']) assert.equal(cand.obs[k], true, `legacy ${k}`);
      assert.equal(cand.obs.desktopSelection, 'MARKERWORD', 'desktop: a real double-click selects terminal text');
      assert.equal(cand.obs.desktopCopied, 'MARKERWORD', 'desktop: the copy shortcut copies that selection');
      assert.equal(cand.obs.clickNoWindow, JSON.stringify({ opened: ['/?open=tmux-7'], posted: [], focused: [] }), 'legacy notification click opens the phone view on the exact session');
      assert.equal(cand.obs.clickPhoneWindow, JSON.stringify({ opened: [], posted: [{ url: 'http://matrix.test/', target: 'tmux-7' }], focused: ['http://matrix.test/'] }), 'with the phone view open it is focused and handed the target');
      assert.equal(cand.obs.destructiveCalls, 0);
      assert.deepEqual([cand.more.sseSnapshot, cand.more.controlLists, cand.more.legacyStillWorks, cand.more.wsFramesAfter, cand.more.einkResize], [true, true, true, true, 0], 'Control and the event stream coexist with the legacy WebSocket; no resize');
      t.note(`legacy flow identical on base 27534cd and candidate: ${JSON.stringify(cand.obs)}; coexistence: ${JSON.stringify(cand.more)}`);
    },

    async worker_isolation(t) {
      const tm = L.fakeTmux(); tm.setPanes([tm.pane({})]);
      const srv = await L.startServer({ env: tm.env });
      const page = await L.openControl(srv);
      const supported = await page.evaluate(() => 'serviceWorker' in navigator);
      assert.ok(supported, 'the browser engine under test supports service workers');
      // Manifest: origin-relative.
      const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
      assert.deepEqual([manifest.start_url, manifest.scope, manifest.id], ['./', './', './']);
      assert.ok(manifest.icons.every((i) => !/^https?:/.test(i.src)));
      // Install both workers in the same browser context.
      const ctx = page.context();
      const phone = await ctx.newPage();
      await phone.goto(`${srv.base}/`);
      await phone.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
      await page.evaluate(async () => { await navigator.serviceWorker.register('sw.js', { scope: './' }); await navigator.serviceWorker.ready; });
      const scopes = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort());
      const phoneScopes = await phone.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort());
      const all = [...new Set([...scopes, ...phoneScopes])].sort();
      assert.deepEqual(all, ['/', '/control/'], 'two workers, each with its own scope');
      await page.reload(); await phone.reload();
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
      await phone.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
      const controlBy = await page.evaluate(() => new URL(navigator.serviceWorker.controller.scriptURL).pathname);
      const phoneBy = await phone.evaluate(() => new URL(navigator.serviceWorker.controller.scriptURL).pathname);
      assert.equal(controlBy, '/control/sw.js', 'Control is handled by its own worker');
      assert.equal(phoneBy, '/sw.js', 'the phone view is still handled by the root worker: the Control worker does not intercept it');
      const desk = await ctx.newPage();
      await desk.goto(`${srv.base}/desktop.html`);
      assert.equal(await desk.evaluate(() => (navigator.serviceWorker.controller ? new URL(navigator.serviceWorker.controller.scriptURL).pathname : 'none')), '/sw.js', 'desktop navigation is not intercepted by the Control worker');
      await page.waitForFunction(() => document.getElementById('conn').textContent === 'Live', null, { timeout: 10000 });
      // The Control worker caches nothing.
      assert.deepEqual(await page.evaluate(() => caches.keys()), []);
      const src = await (await fetch(`${srv.base}/control/sw.js`)).text();
      assert.ok(!/addEventListener\('fetch'/.test(src), 'the Control worker has no fetch handler: it cannot serve a cached page');
      // Offline: the open page says so and shows no "Live"; a reload cannot produce a page claiming current data.
      const listedBefore = await page.evaluate(() => document.querySelectorAll('#sessions li').length);
      await srv.stop('SIGKILL');
      await page.waitForFunction(() => /DISCONNECTED — last confirmed/.test(document.getElementById('conn').textContent), null, { timeout: 10000 });
      assert.equal(await page.isDisabled('#submit'), true);
      assert.equal(await page.evaluate(() => document.querySelectorAll('#sessions li').length), listedBefore, 'the last list stays visible, labelled disconnected');
      const offline = await page.reload({ timeout: 8000 }).then(async () => page.evaluate(() => (document.getElementById('conn') ? document.getElementById('conn').textContent : 'no app')), (err) => `load failed: ${String(err.message).split('\n')[0]}`);
      assert.ok(offline !== 'Live', `after a reload with Matrix down nothing claims to be live (${offline})`);
      t.note(`workers: scopes ${JSON.stringify(all)}; Control → ${controlBy}, phone → ${phoneBy}, desktop → /sw.js; no caches, no fetch handler; offline page shows DISCONNECTED and reload gives "${offline}"`);
    },
  };
};
