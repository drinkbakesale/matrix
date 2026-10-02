// Shared transcript controller for the mobile and desktop clients.
//
// One owner mutates #terminal. That matters because the old clients replaced the live
// `.msg-screen` block every ~100ms: on iOS the node under your finger disappeared during the
// long-press, before any selection existed, so a "defer while a selection exists" guard never
// engaged. Protection therefore starts at pointer/touch down — before `selectionchange` can
// fire — and incoming data is staged outside the DOM until the gesture settles.
//
// Modes: live → applies immediately; pending → a touch/pointer is down; selecting → a
// selection exists inside the transcript; paused → the user opened the copy snapshot.
// Ordinary scrolling is never blocked: a drag that is not a selection releases protection.

(function (global) {
  'use strict';

  var DEFAULT_MAX_MESSAGES = 1000;
  var MAX_STAGED_CHARS = 512 * 1024;   // bounded buffer; overflow asks for a fresh snapshot
  var RELEASE_GRACE_MS = 80;           // let selectionchange land before releasing
  var PENDING_SAFETY_MS = 20000;       // a stuck pointer can never freeze the stream forever
  var SCROLL_SLACK = 100;
  var MOVE_SLOP = 12;

  function laterTimer(fn, ms) {
    return typeof setTimeout === 'function' ? setTimeout(fn, ms) : null;
  }
  function cancelTimer(id) {
    if (id !== null && id !== undefined && typeof clearTimeout === 'function') clearTimeout(id);
  }
  function emptyStaged() {
    return { snapshot: null, outputs: [], screen: null, bytes: 0, overflow: false };
  }

  function createTranscript(options) {
    var opts = options || {};
    var viewer = opts.viewer;
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var maxMessages = opts.maxMessages || DEFAULT_MAX_MESSAGES;
    var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
    var onRefreshNeeded = typeof opts.onRefreshNeeded === 'function' ? opts.onRefreshNeeded : null;
    if (!viewer || !doc) throw new Error('transcript controller requires a viewer element and a document');

    var mode = 'live';
    var epoch = 0;
    var following = true;
    var staged = emptyStaged();
    var pendingTimer = null;
    var releaseTimer = null;
    var gestureY = 0;

    function selectionInViewer() {
      if (typeof global.getSelection !== 'function') return false;
      var sel = global.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
      if (typeof viewer.contains !== 'function') return true;
      return viewer.contains(sel.anchorNode) || viewer.contains(sel.focusNode);
    }

    function notify() {
      if (!onStatus) return;
      onStatus({
        mode: mode,
        held: staged.outputs.length + (staged.snapshot === null ? 0 : 1) + (staged.screen === null ? 0 : 1),
        overflow: staged.overflow,
      });
    }

    function isNearBottom() {
      return viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < SCROLL_SLACK;
    }

    function autoScroll() {
      // Jumping to the bottom mid-gesture would drag the selection handles away, and a user
      // who scrolled up is reading history on purpose.
      if (mode === 'live' && following) viewer.scrollTop = viewer.scrollHeight;
    }

    function appendMessage(text, role) {
      var div = doc.createElement('div');
      div.className = 'msg msg-' + role;
      div.textContent = text;
      viewer.appendChild(div);
      return div;
    }

    // "> " at the start of a line is how the pane renders a user turn.
    function appendStream(text) {
      if (!text || !text.trim()) return;
      var parts = text.replace(/\n{3,}/g, '\n\n').split(/^(> .+)$/m);
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (!part) continue;
        if (part.indexOf('> ') === 0) appendMessage(part.slice(2), 'human');
        else if (part.trim()) appendMessage(part, 'assistant');
      }
    }

    function applyScreen(text) {
      var existing = viewer.querySelector ? viewer.querySelector('.msg-screen') : null;
      if (existing && existing.remove) existing.remove();
      var lines = String(text).split('\n').filter(function (l) { return l.trim(); });
      if (!lines.length) return;
      appendMessage(lines.join('\n'), 'screen msg-assistant');
    }

    function prune() {
      if (mode !== 'live') return;
      var msgs = viewer.querySelectorAll ? viewer.querySelectorAll('.msg') : [];
      if (msgs.length <= maxMessages) return;
      var toRemove = msgs.length - maxMessages;
      var prevHeight = viewer.scrollHeight;
      for (var i = 0; i < toRemove; i++) if (msgs[i].remove) msgs[i].remove();
      if (!following) viewer.scrollTop -= (prevHeight - viewer.scrollHeight);
    }

    function stage(kind, text) {
      if (staged.overflow) return;
      staged.bytes += String(text).length;
      if (staged.bytes > MAX_STAGED_CHARS) {
        // Keep the stable snapshot the user is reading rather than growing without bound;
        // Resume then asks the stream for a fresh snapshot instead of silently losing text.
        staged = emptyStaged();
        staged.overflow = true;
        notify();
        return;
      }
      if (kind === 'snapshot') { staged.snapshot = text; staged.outputs = []; staged.screen = null; }
      else if (kind === 'screen') staged.screen = text;
      else staged.outputs.push(text);
      notify();
    }

    function flush() {
      var held = staged;
      staged = emptyStaged();
      if (held.overflow) {
        if (onRefreshNeeded) onRefreshNeeded();
        notify();
        return;
      }
      if (held.snapshot !== null) { viewer.replaceChildren(); appendStream(held.snapshot); }
      for (var i = 0; i < held.outputs.length; i++) appendStream(held.outputs[i]);
      if (held.screen !== null) applyScreen(held.screen);
      prune();
      autoScroll();
      notify();
    }

    function setMode(next) {
      if (mode === next) return;
      mode = next;
      if (mode === 'live') flush();
      else notify();
    }

    function beginGesture(clientY) {
      if (mode === 'paused') return;
      cancelTimer(releaseTimer); releaseTimer = null;
      gestureY = clientY || 0;
      if (mode === 'live') setMode('pending');
      cancelTimer(pendingTimer);
      pendingTimer = laterTimer(function () {
        if (mode === 'pending' && !selectionInViewer()) setMode('live');
      }, PENDING_SAFETY_MS);
    }

    function moveGesture(clientY) {
      if (mode !== 'pending') return;
      if (Math.abs((clientY || 0) - gestureY) < MOVE_SLOP) return;
      if (selectionInViewer()) { setMode('selecting'); return; }
      setMode('live');                     // a drag with no selection is a scroll
    }

    function endGesture() {
      if (mode === 'paused') return;
      cancelTimer(releaseTimer);
      releaseTimer = laterTimer(function () {
        releaseTimer = null;
        if (mode === 'paused') return;
        setMode(selectionInViewer() ? 'selecting' : 'live');
      }, RELEASE_GRACE_MS);
    }

    function onSelectionChange() {
      if (mode === 'paused') return;
      if (selectionInViewer()) { cancelTimer(releaseTimer); releaseTimer = null; setMode('selecting'); }
      else if (mode === 'selecting') setMode('live');
    }

    function on(target, type, handler, opt) {
      if (target && typeof target.addEventListener === 'function') target.addEventListener(type, handler, opt);
    }

    on(viewer, 'pointerdown', function (e) { beginGesture(e && e.clientY); });
    on(viewer, 'touchstart', function (e) {
      var t = e && e.touches && e.touches[0];
      beginGesture(t ? t.clientY : 0);
    }, { passive: true });
    on(viewer, 'pointermove', function (e) { moveGesture(e && e.clientY); });
    on(viewer, 'touchmove', function (e) {
      var t = e && e.touches && e.touches[0];
      moveGesture(t ? t.clientY : 0);
    }, { passive: true });
    on(viewer, 'pointerup', endGesture);
    on(viewer, 'pointercancel', endGesture);
    on(viewer, 'touchend', endGesture, { passive: true });
    on(viewer, 'touchcancel', endGesture, { passive: true });
    on(viewer, 'scroll', function () { following = isNearBottom(); }, { passive: true });
    on(doc, 'selectionchange', onSelectionChange);

    var api = {
      // `token` lets a caller drop callbacks from a superseded connection or session.
      epoch: function () { return epoch; },
      newEpoch: function () { epoch += 1; return epoch; },
      isCurrent: function (token) { return token === undefined || token === epoch; },
      mode: function () { return mode; },
      isProtected: function () { return mode !== 'live'; },
      heldCount: function () { return staged.outputs.length + (staged.snapshot === null ? 0 : 1) + (staged.screen === null ? 0 : 1); },
      overflowed: function () { return staged.overflow; },

      clear: function () {
        epoch += 1;
        staged = emptyStaged();
        mode = 'live';
        following = true;
        cancelTimer(pendingTimer); pendingTimer = null;
        cancelTimer(releaseTimer); releaseTimer = null;
        viewer.replaceChildren();
        notify();
        return epoch;
      },

      output: function (text, isSnapshot, token) {
        if (!api.isCurrent(token)) return;
        if (mode !== 'live') { stage(isSnapshot ? 'snapshot' : 'output', text); return; }
        if (isSnapshot) viewer.replaceChildren();
        appendStream(text);
        prune();
        autoScroll();
      },

      screen: function (text, token) {
        if (!api.isCurrent(token)) return;
        if (mode !== 'live') { stage('screen', text); return; }
        applyScreen(text);
        autoScroll();
      },

      // Keep the bottom in view after a layout change (keyboard, rotation).
      nudge: function () { autoScroll(); },

      echo: function (text) {
        appendMessage(text, 'human');
        following = true;
        if (mode === 'live') viewer.scrollTop = viewer.scrollHeight;
      },

      pauseForCopy: function () {
        cancelTimer(releaseTimer); releaseTimer = null;
        cancelTimer(pendingTimer); pendingTimer = null;
        if (mode !== 'paused') { mode = 'paused'; notify(); }
      },

      resume: function () {
        if (mode === 'paused') { mode = 'live'; flush(); }
        else setMode('live');
        following = true;
        autoScroll();
      },

      // What the user sees, as plain text: one block per message, so a copy keeps the line
      // breaks the transcript shows. Control labels are never part of it.
      snapshotText: function () {
        var nodes = viewer.querySelectorAll ? viewer.querySelectorAll('.msg') : [];
        var out = [];
        for (var i = 0; i < nodes.length; i++) out.push(nodes[i].textContent);
        return out.join('\n');
      },
    };
    notify();
    return api;
  }

  // Shared text cleanup, identical in both clients.
  function stripAnsi(str) {
    return String(str).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  }

  function filterStatusLines(text) {
    return String(text).split('\n').filter(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed.indexOf('/gsd:update') !== -1) return false;
      if (/Opus \d/.test(trimmed) && /context/.test(trimmed)) return false;
      if (/^\d+%\s/.test(trimmed) || /\s\d+%\s+Debug mode/.test(trimmed)) return false;
      if (/Debug mode\s*$/.test(trimmed)) return false;
      if (/bypass permissions on/.test(trimmed)) return false;
      if (/Update available.*brew upgrade/.test(trimmed)) return false;
      if (/^\d+\s+shells?\s*$/.test(trimmed)) return false;
      if (/^[─━│┃┌┐└┘├┤┬┴┼─━\-]{10,}$/.test(trimmed)) return false;
      return true;
    }).join('\n');
  }

  global.MatrixTranscript = {
    createTranscript: createTranscript,
    stripAnsi: stripAnsi,
    filterStatusLines: filterStatusLines,
    MAX_STAGED_CHARS: MAX_STAGED_CHARS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
