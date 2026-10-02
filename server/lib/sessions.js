'use strict';
// Live tmux session enumeration and notification routing.
//
// Every live session is returned and stays independently addressable: `name`/`targetSession`
// is the opaque tmux routing name and `projectName` is the project it works on. Sessions that
// share a project get an instance suffix rather than being merged away. Extracted from
// server.js with no behaviour change, plus `sessionIncarnation` for brief identity.

const { execSync } = require('child_process');
const os = require('os');
const {
  resolveProjectIdentity, describeFromPaneTitle, assignInstanceLabels, resolveNotificationTarget,
} = require('./session-identity');
const { readProjects, buildPathRegistry, detectDescription } = require('./projects');
const attention = require('./attention');

function tmux(command, opts = {}) {
  return execSync(`${command} 2>/dev/null`, { encoding: 'utf8', ...opts });
}

function listWindows(name) {
  try {
    return tmux(`tmux list-windows -t '${name}' -F '#{window_index}|#{window_name}|#{window_active}'`)
      .trim().split('\n').filter(Boolean).map(w => {
        const [index, wname, active] = w.split('|');
        return { index: parseInt(index), name: wname, active: active === '1' };
      });
  } catch { return []; }
}

// Claude CLI shows as 'claude' or as a bare version number like '2.1.85'.
const isClaudeCmd = cmd => cmd.includes('claude') || /^\d+\.\d+\.\d+$/.test(cmd.trim());

function readPanes(name, sessionPath) {
  let claudeRunning = false;
  let projectPath = sessionPath;
  let paneTitle = '';
  try {
    const panes = tmux(`tmux list-panes -s -t '${name}' -F '#{pane_current_command}|#{pane_current_path}|#{pane_title}'`)
      .trim().split('\n');
    claudeRunning = panes.some(p => isClaudeCmd(p.split('|')[0]));
    const claudePane = panes.find(p => isClaudeCmd(p.split('|')[0]));
    const parts = (claudePane || panes[0])?.split('|');
    if (parts?.[1]) projectPath = parts[1];
    if (parts?.[2]) paneTitle = parts[2];
  } catch {}
  return { claudeRunning, projectPath, paneTitle };
}

function listLiveSessions() {
  try {
    const homeDir = os.homedir();
    const username = os.userInfo().username;
    const registry = buildPathRegistry();
    const confProjects = readProjects();
    // session_id and session_created pin the *incarnation*: a killed and recreated session
    // with the same name is a different session, which the brief store relies on.
    const raw = tmux(
      "tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}|#{session_path}|#{session_activity}|#{session_id}|#{session_created}'"
    ).trim();

    const sessions = raw.split('\n').filter(Boolean).map(line => {
      const [name, windows, attached, sessionPath, activityTs, sessionId, createdAt] = line.split('|');
      const windowList = listWindows(name);
      const { claudeRunning, projectPath, paneTitle } = readPanes(name, sessionPath);

      // Canonical project identity — the evidence chain lives in lib/session-identity.js.
      // Pane titles are conversation topics, so they only ever feed the description below.
      let explicitProject = '';
      try {
        explicitProject = tmux(`tmux show-option -t '${name}' -v @matrix_project`, { timeout: 1000 }).trim();
      } catch {}
      const identity = resolveProjectIdentity({
        sessionName: name, explicitProject, cwd: projectPath, homeDir, username, registry,
      });
      const projectName = identity.projectName;
      const projectConfirmed = identity.confirmed;

      // Don't match by path when the path is the home dir — that would give every numeric
      // home-dir session the generic "home directory" description.
      let description = '';
      const confMatch = confProjects.find(p =>
        p.name === name || p.name === projectName.toLowerCase() ||
        (p.path === projectPath && projectPath !== homeDir)
      );
      description = confMatch?.description ? confMatch.description : detectDescription(projectPath);
      if (!description && !projectConfirmed && paneTitle) {
        description = describeFromPaneTitle({
          paneTitle, cwd: projectPath, homeDir, username, hostname: os.hostname(),
        });
      }

      return {
        name,
        targetSession: name,
        projectName,
        projectSource: identity.source,
        description,
        windows: parseInt(windows),
        attached: attached === '1',
        path: projectPath,
        windowList,
        claudeRunning,
        // needsAttention is driven by notification hooks, not tmux parsing.
        needsAttention: !!attention.pendingAttention[name],
        lastActivity: parseInt(activityTs) || 0,
        projectConfirmed,
        sessionId: sessionId || '',
        createdAt: parseInt(createdAt) || null,
      };
    });

    const labeled = assignInstanceLabels(sessions);
    // Sort: attention first, then identified projects above fallback names, then by activity
    labeled.sort((a, b) => {
      if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
      if (a.projectConfirmed !== b.projectConfirmed) return a.projectConfirmed ? -1 : 1;
      return b.lastActivity - a.lastActivity;
    });
    attention.setLastSessions(labeled);
    return labeled;
  } catch {
    return [];
  }
}

// The exact live session incarnation a brief belongs to, or null when it is gone.
function sessionIncarnation(name) {
  const cached = attention.lastSessions();
  const fresh = cached.length && Date.now() - attention.lastSessionsAt() < 5000 ? cached : listLiveSessions();
  const hit = fresh.find(s => s.name === name);
  if (!hit) return null;
  const pane = hit.windowList.find(w => w.active);
  return {
    name: hit.name,
    sessionId: hit.sessionId || '',
    createdAt: hit.createdAt ?? null,
    projectName: hit.projectName,
    target: pane ? `${hit.name}:${pane.index}` : hit.name,
  };
}

// Resolve a notification against recent session data; re-list tmux when that data is
// stale or does not contain the target.
function resolveLiveNotificationTarget(input) {
  const cached = attention.lastSessions();
  if (cached.length && Date.now() - attention.lastSessionsAt() < 5000) {
    const hit = resolveNotificationTarget(input, cached);
    if (hit.targetSession) return hit;
  }
  return resolveNotificationTarget(input, listLiveSessions());
}

// Periodically clear pendingAttention for sessions where Claude is no longer idle (the user
// responded in iTerm, or Claude started a new task), and prune keys with no live session.
function sweepAttention() {
  if (Object.keys(attention.pendingAttention).length === 0) return;
  const sessData = attention.lastSessions();
  if (sessData.length === 0) return; // dashboard hasn't polled yet; try again next tick

  const validKeys = new Set();
  for (const s of sessData) {
    validKeys.add(s.name);
    if (s.displayName) { validKeys.add(s.displayName); validKeys.add(s.displayName.toLowerCase()); }
  }
  for (const key of Object.keys(attention.pendingAttention)) {
    if (!validKeys.has(key)) {
      delete attention.pendingAttention[key];
      delete attention.dismissedUntilChange[key];
      delete attention.lastSeenQuestions[key];
    }
  }
  for (const s of sessData) {
    const keys = [s.name];
    if (s.displayName) keys.push(s.displayName, s.displayName.toLowerCase());
    if (!keys.some(k => attention.pendingAttention[k])) continue;
    try {
      const tail = tmux(`tmux capture-pane -t '${s.name}:0' -p -S -5`, { timeout: 1000 });
      const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
      const hasSpinner = lines.some(l => /^[✻✳⏺]\s/.test(l) || /Running…|Working/i.test(l));
      const hasProgress = lines.some(l => /\d+%/.test(l) && (l.includes('░') || l.includes('█')));
      if (hasSpinner || hasProgress) for (const k of keys) delete attention.pendingAttention[k];
    } catch {}
  }
}

// Bounded capture of the exact pane a session streams, used as brief evidence.
function capturePaneText(identity, lines = 400) {
  try {
    return tmux(`tmux capture-pane -t '${identity.target || identity.name}' -p -S -${lines}`, { maxBuffer: 8 * 1024 * 1024 });
  } catch { return ''; }
}

module.exports = {
  listLiveSessions, resolveLiveNotificationTarget, sweepAttention,
  sessionIncarnation, capturePaneText,
};
