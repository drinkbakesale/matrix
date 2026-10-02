// Explicit "select / copy" surface, shared by both clients.
//
// Native long-press selection inside a live transcript is not something a web app can
// guarantee on iOS, so this is the control the user can always reach: it freezes the stream,
// shows the transcript as a stable, selectable plain-text surface and copies from a real
// click. Buttons live outside the text surface so a copy never picks up a label or the brief.
//
// Copy never reports success it did not get: the clipboard promise must resolve (or
// execCommand must return true) before the status says "Copied".

(function (global) {
  'use strict';

  function byId(doc, id) { return doc.getElementById(id); }

  function install(options) {
    var opts = options || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var transcript = opts.transcript;
    if (!doc || !transcript) throw new Error('copy surface requires a document and a transcript controller');

    var sheet = byId(doc, 'copy-sheet');
    var textarea = byId(doc, 'copy-text');
    var status = byId(doc, 'copy-status');
    var bar = byId(doc, 'transcript-status');
    var resumeBar = byId(doc, 'transcript-resume');
    if (!sheet || !textarea || !status) return null;

    function setStatus(state, message) {
      status.textContent = message;
      status.className = 'copy-status' + (state === 'error' ? ' error' : state === 'copied' ? ' ok' : '');
      sheet.setAttribute('data-copy-state', state);
    }

    function open() {
      transcript.pauseForCopy();
      textarea.value = transcript.snapshotText();
      sheet.hidden = false;
      setStatus('idle', textarea.value ? 'Live updates are paused. Select text, then Copy.' : 'Nothing in this transcript yet.');
      textarea.focus();
      renderBar();
    }

    function hide() {
      sheet.hidden = true;
      renderBar();
    }

    function resume() {
      transcript.resume();
      hide();
    }

    function selectedText() {
      var start = textarea.selectionStart;
      var end = textarea.selectionEnd;
      if (typeof start !== 'number' || typeof end !== 'number' || start === end) return '';
      return textarea.value.slice(start, end);
    }

    // Returns the mechanism that actually succeeded, or throws with an actionable message.
    async function writeClipboard(text) {
      var nav = global.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(text);
        return 'clipboard-api';
      }
      if (typeof doc.execCommand === 'function') {
        textarea.focus();
        if (typeof textarea.setSelectionRange === 'function') {
          var at = textarea.value.indexOf(text);
          if (at >= 0) textarea.setSelectionRange(at, at + text.length);
        }
        if (doc.execCommand('copy')) return 'exec-command';
        throw new Error('the browser refused the copy command');
      }
      throw new Error('this browser exposes no clipboard API');
    }

    async function copy(text, label) {
      if (!text) {
        setStatus('error', 'Nothing selected — drag over the text first, or use Copy all.');
        return false;
      }
      try {
        var via = await writeClipboard(text);
        setStatus('copied', 'Copied ' + text.length + ' characters (' + label + ', ' + via + ').');
        return true;
      } catch (err) {
        var detail = err && err.message ? err.message : String(err);
        setStatus('error', 'Copy failed: ' + detail + '. The text is still here — select it and use the system Copy menu.');
        return false;
      }
    }

    function renderBar() {
      if (!bar) return;
      var mode = transcript.mode();
      var overflow = transcript.overflowed();
      if (overflow && mode !== 'live') bar.textContent = 'Too much arrived while paused — Resume reloads a fresh snapshot';
      else if (mode === 'paused') bar.textContent = 'Paused for copying' + (transcript.heldCount() ? ' · updates held' : '');
      else if (mode === 'selecting') bar.textContent = 'Selection held · live updates paused';
      else if (mode === 'pending') bar.textContent = 'Holding updates while you touch the transcript';
      else bar.textContent = '';
      if (resumeBar) resumeBar.hidden = mode === 'live';
    }

    function wire(id, handler) {
      var el = byId(doc, id);
      if (el) el.addEventListener('click', handler);
    }

    wire('copy-open', open);
    wire('copy-close', hide);
    wire('copy-resume', resume);
    wire('transcript-resume', function () { transcript.resume(); hide(); });
    wire('copy-select-all', function () {
      textarea.focus();
      if (typeof textarea.setSelectionRange === 'function') textarea.setSelectionRange(0, textarea.value.length);
      else if (typeof textarea.select === 'function') textarea.select();
      setStatus('idle', 'Everything is selected. Press Copy selection, or the system Copy menu.');
    });
    wire('copy-selection', function () { copy(selectedText(), 'selection'); });
    wire('copy-all', function () { copy(textarea.value, 'whole transcript'); });

    return { open: open, hide: hide, resume: resume, renderBar: renderBar, copy: copy };
  }

  global.MatrixCopy = { install: install };
})(typeof window !== 'undefined' ? window : globalThis);
