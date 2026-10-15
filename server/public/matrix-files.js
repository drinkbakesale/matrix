'use strict';
// Files into a Matrix message box: drag and drop (Mac), paste an image (both), or the phone's
// attach button (photo library). Each file becomes its path, inserted at the cursor:
//   - a dropped file that Spotlight finds on this Mac by name + size + modified time keeps its
//     ORIGINAL path (what dropping it on iTerm2 would type);
//   - anything else is uploaded and the saved copy's path is inserted.
// The box remembers which paths are attachments so sending can paste them (see
// server/lib/type-parts.js) and Claude Code attaches images the way it does from iTerm2.

const MatrixFiles = (() => {
  const attached = new WeakMap();   // input -> [paths]

  function statusFor(input) {
    const bar = input.closest('#chat-input-bar, #input-bar') || input.parentNode;
    let el = bar.querySelector(':scope > .mx-attach-status');
    if (!el) {
      el = document.createElement('div');
      el.className = 'mx-attach-status';
      el.setAttribute('role', 'status');
      if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
      bar.appendChild(el);
    }
    return el;
  }

  let hideTimer = null;
  function show(input, text, { error = false, sticky = false } = {}) {
    const el = statusFor(input);
    el.textContent = text;
    el.classList.toggle('error', error);
    el.hidden = !text;
    clearTimeout(hideTimer);
    if (text && !sticky && !error) hideTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  function insertAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const post = after && /^\s/.test(after) ? '' : ' ';
    input.value = before + pre + text + post + after;
    const caret = (before + pre + text + post).length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function remember(input, p) {
    const list = attached.get(input) || [];
    if (!list.includes(p)) list.push(p);
    attached.set(input, list);
  }

  async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({ error: `server answered ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `server answered ${res.status}`);
    return data;
  }

  async function upload(files) {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name || 'pasted-image.png');
    const res = await fetch('/api/files/upload', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({ error: `server answered ${res.status}` }));
    if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
    return data.paths;
  }

  // locate: try to find each file's original on this Mac first (drops from Finder).
  async function addFiles(input, fileList, { locate }) {
    const files = [...fileList].slice(0, 10);
    if (!files.length) return;
    show(input, `📎 adding ${files.length === 1 ? files[0].name || 'image' : files.length + ' files'}…`, { sticky: true });
    try {
      const found = locate
        ? (await postJson('/api/files/locate', { files: files.map(f => ({ name: f.name, size: f.size, lastModified: f.lastModified })) })).paths
        : files.map(() => null);
      const missing = files.filter((f, i) => !found[i]);
      const uploaded = missing.length ? await upload(missing) : [];
      const labels = [];
      let u = 0;
      files.forEach((f, i) => {
        const p = found[i] || uploaded[u++];
        remember(input, p);
        insertAtCursor(input, p);
        labels.push(`${f.name || 'image'} (${found[i] ? 'original' : 'uploaded copy'})`);
      });
      show(input, `📎 ${labels.join(', ')}`);
    } catch (err) {
      show(input, `📎 could not add: ${err.message}`, { error: true });
    }
    input.focus();
  }

  // A file dropped ANYWHERE on the page goes into the visible message box; the browser never
  // gets to open it in a new tab. The bar lights up while a file is dragged over the page.
  const boxes = [];
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const visibleBox = () => boxes.find(i => i.offsetParent !== null) || null;
  const barOf = input => input.closest('#chat-input-bar, #input-bar') || input;
  let dragDepth = 0;
  function lightUp(on) { const box = visibleBox(); boxes.forEach(i => barOf(i).classList.toggle('mx-drop', on && i === box)); }
  function watchPage() {
    document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; dragDepth++; lightUp(true); });
    document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; lightUp(false); } });
    document.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = visibleBox() ? 'copy' : 'none';
    });
    document.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      lightUp(false);
      const box = visibleBox();
      if (box) addFiles(box, e.dataTransfer.files, { locate: true });
    });
  }

  function install(input) {
    if (!boxes.length) watchPage();
    boxes.push(input);
    input.addEventListener('paste', e => {
      const files = e.clipboardData && e.clipboardData.files;
      if (!files || !files.length) return;   // ordinary text paste
      e.preventDefault();
      addFiles(input, files, { locate: false });
    });
  }

  // The phone's attach button: opens the photo library / files.
  function picker(button, input, { accept = 'image/*' } = {}) {
    let chooser = null;   // made on first tap
    button.addEventListener('click', e => {
      e.preventDefault();
      if (!chooser) {
        chooser = document.createElement('input');
        chooser.type = 'file';
        chooser.accept = accept;
        chooser.multiple = true;
        chooser.hidden = true;
        document.body.appendChild(chooser);
        chooser.addEventListener('change', () => addFiles(input, chooser.files, { locate: false }));
      }
      chooser.value = '';
      chooser.click();
    });
  }

  // The message as parts (text typed, attached paths pasted), or null when it carries none.
  function parts(input, text) {
    const paths = (attached.get(input) || []).filter(p => text.includes(p)).sort((a, b) => b.length - a.length);
    if (!paths.length) return null;
    const out = [];
    let rest = text;
    while (rest) {
      let hit = null;
      for (const p of paths) {
        const i = rest.indexOf(p);
        if (i >= 0 && (!hit || i < hit.i)) hit = { i, p };
      }
      if (!hit) { out.push({ text: rest }); break; }
      if (hit.i) out.push({ text: rest.slice(0, hit.i) });
      out.push({ paste: hit.p });
      rest = rest.slice(hit.i + hit.p.length);
    }
    return out;
  }

  function reset(input) { attached.delete(input); }

  return { install, picker, parts, reset, addFiles, track: remember };
})();

if (typeof module !== 'undefined') module.exports = MatrixFiles;
