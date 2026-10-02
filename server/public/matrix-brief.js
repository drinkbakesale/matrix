// Pinned two-line session brief, shared by both clients.
//
// Sentence 1 is the project's broad goal, sentence 2 is what this session is working on now.
// Both come from the server, which derives them from the session's own pane; this view never
// invents text from a project name and never shows filler. When there is nothing to show it
// says so — "generating", "no evidence yet", or the actual error.
//
// The view lives outside the scrolling transcript, so it stays pinned while the transcript
// scrolls and a refresh can never replace a node the user is selecting inside the transcript.

(function (global) {
  'use strict';

  var POLL_MS = 3000;

  function ago(now, then) {
    if (!then) return '';
    var secs = Math.max(0, Math.floor((now - then) / 1000));
    if (secs < 45) return 'updated just now';
    if (secs < 3600) return 'updated ' + Math.floor(secs / 60) + ' min ago';
    if (secs < 86400) return 'updated ' + Math.floor(secs / 3600) + ' h ago';
    return 'updated ' + Math.floor(secs / 86400) + ' d ago';
  }

  function create(options) {
    var opts = options || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    var now = opts.now || function () { return Date.now(); };
    if (!doc) throw new Error('brief view requires a document');

    var root = doc.getElementById('brief');
    var goalEl = doc.getElementById('brief-goal');
    var currentEl = doc.getElementById('brief-current');
    var ageEl = doc.getElementById('brief-age');
    var statusEl = doc.getElementById('brief-status');
    var bodyEl = doc.getElementById('brief-body');
    var toggleEl = doc.getElementById('brief-toggle');
    if (!root || !goalEl || !currentEl || !statusEl) return null;

    var session = null;
    var latest = null;
    var requestId = 0;
    var appliedId = 0;
    var timer = null;
    var editing = null;

    function setStatus(text, kind) {
      statusEl.textContent = text || '';
      statusEl.className = 'brief-status' + (kind ? ' ' + kind : '');
    }

    function fieldEl(field) { return field === 'goal' ? goalEl : currentEl; }

    function placeholderFor(brief, field) {
      if (brief.status === 'generating') return 'Generating…';
      if (brief.status === 'unavailable') return 'No brief yet';
      if (brief.status === 'error') return 'Unavailable';
      return field === 'goal' ? 'No goal stated in this session yet' : 'No current work stated yet';
    }

    function render() {
      var brief = latest;
      if (!brief) {
        root.hidden = false;
        root.setAttribute('data-status', 'loading');
        goalEl.textContent = 'Generating…';
        currentEl.textContent = 'Generating…';
        if (ageEl) ageEl.textContent = '';
        setStatus('Looking at this session…');
        return;
      }
      root.hidden = false;
      root.setAttribute('data-status', brief.status);
      root.setAttribute('data-session', brief.session ? brief.session.name : '');
      for (var i = 0; i < 2; i++) {
        var field = i === 0 ? 'goal' : 'current';
        if (editing === field) continue;
        var value = brief[field];
        var el = fieldEl(field);
        el.textContent = value ? value : placeholderFor(brief, field);
        el.setAttribute('data-empty', value ? '0' : '1');
        el.setAttribute('data-overridden', brief.overrides && brief.overrides[field] !== null ? '1' : '0');
        var clear = doc.getElementById('brief-clear-' + field);
        if (clear) clear.hidden = !(brief.overrides && brief.overrides[field] !== null);
      }
      if (ageEl) ageEl.textContent = brief.generatedAt ? ago(now(), brief.generatedAt) : '';
      var messages = [];
      if (brief.status === 'generating') messages.push('Generating the brief…');
      if (brief.status === 'unavailable' || brief.unavailable) messages.push('No brief yet — ' + (brief.unavailable || 'not enough session evidence'));
      if (brief.error) messages.push((brief.stale ? 'Showing the last brief; refresh failed: ' : 'Brief failed: ') + brief.error);
      if (brief.storageError) messages.push('Saved edits could not be read: ' + brief.storageError);
      setStatus(messages.join(' · '), brief.error || brief.storageError ? 'error' : '');
    }

    function apply(id, name, payload) {
      // A slow response for the session the user left must never land on the new one.
      if (name !== session || id <= appliedId) return;
      appliedId = id;
      latest = payload;
      render();
    }

    async function load() {
      if (!session || !fetchImpl) return;
      var id = ++requestId;
      var name = session;
      try {
        var res = await fetchImpl('/api/sessions/' + encodeURIComponent(name) + '/brief', { cache: 'no-store' });
        var data = await res.json();
        if (!data || data.ok !== true || !data.brief) {
          apply(id, name, errorBrief(name, data && data.message ? data.message : 'HTTP ' + res.status));
          return;
        }
        apply(id, name, data.brief);
      } catch (err) {
        apply(id, name, errorBrief(name, 'could not reach Matrix'));
      }
    }

    function errorBrief(name, message) {
      return {
        session: { name: name }, goal: null, current: null,
        overrides: { goal: null, current: null }, revision: 0,
        status: 'error', generatedAt: null, evidenceAt: null, stale: false,
        error: message, unavailable: null, storageError: null,
      };
    }

    function stopEditing() {
      if (!editing) return;
      var el = fieldEl(editing);
      el.replaceChildren();
      editing = null;
      render();
    }

    function startEditing(field) {
      if (!latest) return;
      stopEditing();
      editing = field;
      var el = fieldEl(field);
      var input = doc.createElement('input');
      input.type = 'text';
      input.className = 'brief-input';
      input.id = 'brief-input-' + field;
      input.value = latest[field] || '';
      input.maxLength = 500;
      var save = doc.createElement('button');
      save.type = 'button';
      save.className = 'brief-save';
      save.id = 'brief-save-' + field;
      save.textContent = 'Save';
      var cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.className = 'brief-cancel';
      cancel.id = 'brief-cancel-' + field;
      cancel.textContent = 'Cancel';
      save.addEventListener('click', function () { submit(field, input.value); });
      cancel.addEventListener('click', stopEditing);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(field, input.value); }
        if (e.key === 'Escape') { e.preventDefault(); stopEditing(); }
      });
      el.replaceChildren(input, save, cancel);
      if (typeof input.focus === 'function') input.focus();
    }

    async function patch(body) {
      if (!session || !fetchImpl) return null;
      var name = session;
      var res = await fetchImpl('/api/sessions/' + encodeURIComponent(name) + '/brief', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok || !data || data.ok !== true) {
        setStatus('Edit not saved: ' + ((data && data.message) || ('HTTP ' + res.status)), 'error');
        if (res.status === 409) load();
        return null;
      }
      apply(++requestId, name, data.brief);
      return data.brief;
    }

    async function submit(field, value) {
      var body = { revision: latest ? latest.revision : 0 };
      body[field] = value;
      var saved = await patch(body);
      if (saved) { editing = null; fieldEl(field).replaceChildren(); render(); }
    }

    function clearOverride(field) {
      var body = { revision: latest ? latest.revision : 0 };
      body[field] = null;
      patch(body);
    }

    function bind(id, handler) {
      var el = doc.getElementById(id);
      if (el) el.addEventListener('click', handler);
    }
    bind('brief-edit-goal', function () { startEditing('goal'); });
    bind('brief-edit-current', function () { startEditing('current'); });
    bind('brief-clear-goal', function () { clearOverride('goal'); });
    bind('brief-clear-current', function () { clearOverride('current'); });
    if (toggleEl) {
      toggleEl.addEventListener('click', function () {
        var collapsed = root.getAttribute('data-collapsed') === '1';
        root.setAttribute('data-collapsed', collapsed ? '0' : '1');
        toggleEl.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
        if (bodyEl) bodyEl.hidden = !collapsed;
      });
    }

    return {
      open: function (name) {
        session = name;
        latest = null;
        appliedId = 0;
        editing = null;
        render();
        load();
        if (timer === null && typeof setInterval === 'function') timer = setInterval(load, POLL_MS);
      },
      close: function () {
        session = null;
        latest = null;
        editing = null;
        root.hidden = true;
        if (timer !== null && typeof clearInterval === 'function') { clearInterval(timer); timer = null; }
      },
      refresh: load,
      current: function () { return latest; },
      session: function () { return session; },
    };
  }

  global.MatrixBrief = { create: create, ago: ago };
})(typeof window !== 'undefined' ? window : globalThis);
