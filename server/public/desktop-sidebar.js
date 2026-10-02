// Desktop sidebar: project rows, recent-project rows, dismissal and the switch toast.
// Extracted from desktop.js; behaviour unchanged.

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Row label: canonical project name, plus an instance suffix when sessions share a project.
function sessionLabel(s) {
  if (!s) return '';
  if (s.projectName) return s.instanceSuffix ? `${s.projectName} · ${s.instanceSuffix}` : s.projectName;
  return s.displayName || s.name;
}

function getDismissed() { return dismissed; }

function dismissSession(name) {
  dismissed[name] = Date.now();
  // Clear attention server-side so polling doesn't re-highlight
  fetch('/api/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: name }),
  }).catch(() => {});
  renderSidebar();
}

function undismissSession(name) {
  delete dismissed[name];
}

async function loadSessions() {
  try {
    const [sessRes, recentRes] = await Promise.all([
      fetch('/api/sessions'),
      fetch('/api/projects/inactive'),
    ]);
    const sessData = await sessRes.json();
    const recentData = await recentRes.json();
    sessions = sessData.sessions || [];
    // Sync attention from server — but respect client-side dismissals
    sessions.forEach(s => {
      if (s.needsAttention && !dismissed[s.name]) sessionAttention[s.name] = true;
      else if (!s.needsAttention) delete sessionAttention[s.name];
    });

    // Filter recent projects: not already visible, active within 14 days
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const activeNames = new Set(sessions.map(s => s.name.toLowerCase()));
    const activeDisplayNames = new Set(sessions.flatMap(s =>
      [s.projectName, s.displayName, s.name].filter(Boolean).map(n => n.toLowerCase())
    ));
    recentProjects = (recentData.projects || []).filter(p =>
      p.lastActivity > fourteenDaysAgo &&
      !activeNames.has(p.name.toLowerCase()) &&
      !activeDisplayNames.has(p.name.toLowerCase())
    );
    recentProjects.sort((a, b) => b.lastActivity - a.lastActivity);

    renderSidebar();
  } catch (err) {
    console.error('loadSessions:', err);
  }
}

function renderSidebar() {
  const list = document.getElementById('project-list');

  // Sort: attention (not dismissed) first, then normal, then dismissed
  const sorted = [...sessions].sort((a, b) => {
    const aAtt = !!sessionAttention[a.name] && !dismissed[a.name];
    const bAtt = !!sessionAttention[b.name] && !dismissed[b.name];
    const aDis = !!dismissed[a.name];
    const bDis = !!dismissed[b.name];
    if (aAtt && !bAtt) return -1;
    if (!aAtt && bAtt) return 1;
    if (aDis && !bDis) return 1;
    if (!aDis && bDis) return -1;
    return 0;
  });

  let html = sorted.map(s => {
    const isDismissed = !!dismissed[s.name];
    const needsAtt = !!sessionAttention[s.name] && !isDismissed;
    const dotClass = needsAtt ? 'attention' : (s.claudeRunning ? 'claude' : (s.attached ? 'running' : 'idle'));
    const badge = needsAtt ? 'Waiting' : (isDismissed && sessionAttention[s.name] ? 'Snoozed' : (s.claudeRunning ? 'Claude' : (s.attached ? 'attached' : `${s.windows} win`)));
    const selected = s.name === currentSession ? ' selected' : '';
    const attention = needsAtt ? ' attention' : '';
    const dimmed = isDismissed ? ' dismissed' : '';
    const descHtml = s.description ? `<div class="project-desc">${escapeHtml(s.description)}</div>` : '';
    const dismissHtml = needsAtt ? `<button class="dismiss-btn" data-dismiss="${escapeHtml(s.name)}">dismiss</button>` : '';

    return `
      <div class="project-item${selected}${attention}${dimmed}" data-session="${escapeHtml(s.name)}">
        <div class="project-content">
          <div class="project-top">
            <span class="project-dot ${dotClass}"></span>
            <span class="project-name">${escapeHtml(sessionLabel(s))}</span>
            <span class="project-badge">${badge}</span>
          </div>
          ${descHtml}
        </div>
        ${dismissHtml}
      </div>`;
  }).join('');

  // Append recent (inactive) projects as semi-transparent rows
  if (recentProjects.length > 0) {
    html += '<div class="recent-divider">Recent</div>';
    html += recentProjects.map(p => {
      const ago = recentTimeAgo(p.lastActivity);
      const descHtml = p.description ? `<div class="project-desc">${p.description}</div>` : '';
      return `
        <div class="project-item recent" data-recent-name="${p.name}" data-recent-path="${p.path}">
          <div class="project-content">
            <div class="project-top">
              <span class="project-dot idle"></span>
              <span class="project-name">${p.name}</span>
              <span class="project-badge">${ago}</span>
            </div>
            ${descHtml}
          </div>
        </div>`;
    }).join('');
  }

  list.innerHTML = html;

  list.querySelectorAll('.project-item:not(.recent) .project-content').forEach(content => {
    content.addEventListener('click', () => {
      selectProject(content.closest('.project-item').dataset.session);
    });
  });

  // Click on recent project starts it
  list.querySelectorAll('.project-item.recent .project-content').forEach(content => {
    content.addEventListener('click', async () => {
      const item = content.closest('.project-item');
      const name = item.dataset.recentName;
      const projectPath = item.dataset.recentPath;
      item.querySelector('.project-badge').textContent = 'Starting...';
      try {
        await fetch('/api/projects/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, projectPath }),
        });
        setTimeout(async () => {
          await loadSessions();
          selectProject(name);
        }, 2000);
      } catch {}
    });
  });

  list.querySelectorAll('.dismiss-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissSession(btn.dataset.dismiss);
    });
  });
}

function recentTimeAgo(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

// ── Switch Toast (top-right popup) ──

function showSwitchToast(session, projectLabel) {
  removeSwitchToast();
  switchToastSession = session;
  const label = sessionLabel(sessions.find(s => s.name === session)) || projectLabel || session;

  const toast = document.createElement('div');
  toast.id = 'switch-toast';
  toast.innerHTML = `
    <span class="switch-toast-dot"></span>
    <span class="switch-toast-text"><strong>${escapeHtml(label)}</strong> needs your input</span>
    <span class="switch-toast-hint">Enter to switch</span>
  `;
  toast.addEventListener('click', () => {
    selectProject(switchToastSession);
    removeSwitchToast();
  });
  document.body.appendChild(toast);

  switchToastTimer = setTimeout(removeSwitchToast, 5000);
}

function removeSwitchToast() {
  const toast = document.getElementById('switch-toast');
  if (toast) toast.remove();
  if (switchToastTimer) { clearTimeout(switchToastTimer); switchToastTimer = null; }
  switchToastSession = null;
}

// Enter key on toast switches project
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && switchToastSession && document.activeElement !== document.getElementById('chat-input')) {
    e.preventDefault();
    selectProject(switchToastSession);
    removeSwitchToast();
  }
});
