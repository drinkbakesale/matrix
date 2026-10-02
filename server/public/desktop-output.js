// Desktop output panel: detected files, images, localhost ports and the preview tabs.
// The panel is currently commented out of desktop.html; every lookup stays defensive.
// Extracted from desktop.js; behaviour unchanged.

let detectedOutputDir = null;
let currentOutputTab = 'files';
let outputPollInterval = null;

// Parse terminal output to detect file writes and localhost URLs
const outputPatterns = {
  file: /(?:wrote|created|saved|output|generated|exported)\s+(?:to\s+)?[`'"]?([^\s`'"]+\.\w+)/gi,
  localhost: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/gi,
  port: /(?:listening|running|started|serving)\s+(?:on|at)\s+(?:port\s+)?:?(\d{4,5})/gi,
};

function scanTerminalForOutputs(text) {
  const newPorts = new Set(detectedPorts.map(p => p.port));
  let foundNew = false;

  for (const match of text.matchAll(outputPatterns.localhost)) {
    const port = parseInt(match[1]);
    if (!newPorts.has(port)) {
      newPorts.add(port);
      detectedPorts.push({ port, url: match[0] });
      foundNew = true;
    }
  }

  for (const match of text.matchAll(outputPatterns.port)) {
    const port = parseInt(match[1]);
    if (port >= 1024 && port <= 65535 && !newPorts.has(port)) {
      newPorts.add(port);
      detectedPorts.push({ port, url: `http://localhost:${port}` });
      foundNew = true;
    }
  }

  if (foundNew) updateBrowserTab();
}

function showOutputPanel() {
  document.getElementById('output-panel').style.display = 'flex';
  loadOutputFiles();
  loadPorts();
  if (outputPollInterval) clearInterval(outputPollInterval);
  outputPollInterval = setInterval(() => { loadOutputFiles(); loadPorts(); }, 5000);
}

function hideOutputPanel() {
  document.getElementById('output-panel').style.display = 'none';
  if (outputPollInterval) { clearInterval(outputPollInterval); outputPollInterval = null; }
}

async function loadOutputFiles() {
  if (!currentSession) return;
  try {
    const res = await fetch(`/api/outputs/${encodeURIComponent(currentSession)}`);
    const { files, images } = await res.json();
    renderFilesTab(files);
    renderImagesTab(images);
  } catch {}
}

async function loadPorts() {
  if (!currentSession) return;
  try {
    const res = await fetch(`/api/ports/${encodeURIComponent(currentSession)}`);
    const { ports } = await res.json();
    const known = new Set(detectedPorts.map(p => p.port));
    for (const p of ports) if (!known.has(p.port)) detectedPorts.push(p);
    updateBrowserTab();
  } catch {}
}

function renderFilesTab(files) {
  const list = document.getElementById('files-list');
  if (!list) return;
  if (!files || files.length === 0) {
    list.innerHTML = '<div class="no-browser"><span class="no-browser-icon">📁</span><span>No output files yet</span></div>';
    return;
  }

  const iconMap = {
    '.png': '🖼', '.jpg': '🖼', '.jpeg': '🖼', '.gif': '🖼', '.svg': '🖼', '.webp': '🖼',
    '.json': '📋', '.csv': '📊', '.txt': '📄', '.md': '📝', '.html': '🌐',
    '.py': '🐍', '.js': '📦', '.ts': '📦', '.log': '📃',
  };

  list.innerHTML = files.map(f => {
    const icon = iconMap[f.ext] || '📄';
    const ago = timeAgo(f.mtime);
    const isNew = Date.now() - f.mtime < 30000;
    return `
      <div class="file-item${isNew ? ' new' : ''}">
        <span class="file-icon">${icon}</span>
        <span class="file-name" title="${f.name}">${f.name}</span>
        <span class="file-time">${ago}</span>
      </div>`;
  }).join('');
}

function renderImagesTab(images) {
  const grid = document.getElementById('images-grid');
  if (!grid) return;
  if (!images || images.length === 0) {
    grid.innerHTML = '<div class="no-browser"><span class="no-browser-icon">🖼</span><span>No images yet</span></div>';
    return;
  }
  grid.innerHTML = images.map(img => `
    <div class="image-thumb" data-src="${img.path}">
      <img src="${img.path}" loading="lazy" alt="${img.name}">
    </div>`).join('');

  grid.querySelectorAll('.image-thumb').forEach(thumb => {
    thumb.addEventListener('click', () => {
      document.getElementById('lightbox-img').src = thumb.dataset.src;
      document.getElementById('image-lightbox').style.display = 'flex';
    });
  });
}

function updateBrowserTab() {
  const pane = document.getElementById('tab-browser');
  if (!pane) return;

  if (detectedPorts.length === 0) {
    pane.innerHTML = '<div class="no-browser"><span class="no-browser-icon">🌐</span><span>No localhost detected</span></div>';
    return;
  }

  const { url } = detectedPorts[0];
  if (!pane.querySelector('#browser-bar')) {
    pane.innerHTML = `
      <div id="browser-bar">
        <span id="browser-url"></span>
        <button id="browser-refresh" title="Refresh">↻</button>
      </div>
      <iframe id="browser-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`;
    pane.querySelector('#browser-refresh').addEventListener('click', () => {
      pane.querySelector('#browser-frame').src = url;
    });
  }
  pane.querySelector('#browser-url').textContent = url;
  const currentSrc = pane.querySelector('#browser-frame').src;
  if (!currentSrc || currentSrc === 'about:blank') pane.querySelector('#browser-frame').src = url;
}

function timeAgo(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

// Tab switching (output panel may be commented out in HTML)
const outputTabsEl = document.getElementById('output-tabs');
if (outputTabsEl) {
  outputTabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.output-tab');
    if (!tab) return;
    const tabName = tab.dataset.tab;
    currentOutputTab = tabName;
    document.querySelectorAll('.output-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
    document.getElementById(`tab-${tabName}`).style.display = tabName === 'browser' ? 'flex' : 'block';
  });
}

// Lightbox close (may be commented out in HTML)
const lightboxCloseEl = document.getElementById('lightbox-close');
const lightboxEl = document.getElementById('image-lightbox');
if (lightboxCloseEl) {
  lightboxCloseEl.addEventListener('click', () => {
    document.getElementById('image-lightbox').style.display = 'none';
  });
}
if (lightboxEl) {
  lightboxEl.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) document.getElementById('image-lightbox').style.display = 'none';
  });
}
