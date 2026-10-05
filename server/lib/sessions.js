'use strict';
// Live tmux session enumeration and notification routing.
//
// Every live session is returned and stays independently addressable: `name`/`targetSession`
// is the opaque tmux routing name and `projectName` is the project it works on. Sessions that
// share a project get an instance suffix rather than being merged away. Extracted from
// server.js with no behaviour change.

const { execFile } = require('child_process');
const os = require('os');
const {
  resolveProjectIdentity, describeFromPaneTitle, assignInstanceLabels, resolveNotificationTarget,
} = require('./session-identity');
const { readProjects, buildPathRegistry, detectDescription } = require('./projects');
const attention = require('./attention');

// One whole-server listing per kind instead of three commands per session: with dozens of
// sessions the per-session form spent seconds in synchronous shells and froze every request.
// Arguments go straight to tmux (no shell), asynchronously and with a timeout.
const SEP = '\t';
const SESSION_FORMAT = ['#{session_name}', '#{session_windows}', '#{session_attached}', '#{session_path}',
  '#{session_activity}', '#{session_id}', '#{session_created}', '#{@matrix_project}'].join(SEP);
const WINDOW_FORMAT = ['#{session_name}', '#{window_index}', '#{window_name}', '#{window_active}'].join(SEP);
const PANE_FORMAT = ['#{session_name}', '#{pane_current_command}', '#{pane_current_path}', '#{pane_title}'].join(SEP);

function runTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const rows = raw => String(raw).split('\n').filter(Boolean).map(line => line.split(SEP));

function groupBySession(raw) {
  const out = new Map();
  for (const [session, ...rest] of rows(raw)) {
    if (!out.has(session)) out.set(session, []);
    out.get(session).push(rest);
  }
  return out;
}

// Claude CLI shows as 'claude' or as a bare version number like '2.1.85'.
const isClaudeCmd = cmd => cmd.includes('claude') || /^\d+\.\d+\.\d+$/.test(cmd.trim());

function readPanes(panes, sessionPath) {
  let projectPath = sessionPath;
  let paneTitle = '';
  const claudeRunning = panes.some(p => isClaudeCmd(p[0] || ''));
  const chosen = panes.find(p => isClaudeCmd(p[0] || '')) || panes[0];
  if (chosen && chosen[1]) projectPath = chosen[1];
  if (chosen && chosen[2]) paneTitle = chosen[2];
  return { claudeRunning, projectPath, paneTitle };
}

// "no server running" is an empty list, not a failure: there are simply no sessions.
const noServer = err => /no server running|error connecting|no sessions/i.test(String(err && (err.stderr || err.message)));

async function collectSessions(run = runTmux) {
  let raw;
  let windowsRaw;
  let panesRaw;
  try {
    [raw, windowsRaw, panesRaw] = await Promise.all([
      run(['list-sessions', '-F', SESSION_FORMAT]),
      run(['list-windows', '-a', '-F', WINDOW_FORMAT]),
      run(['list-panes', '-a', '-F', PANE_FORMAT]),
    ]);
  } catch (err) {
    if (noServer(err)) return [];
    throw err;
  }
  const windowsBySession = groupBySession(windowsRaw);
  const panesBySession = groupBySession(panesRaw);
  const homeDir = os.homedir();
  const username = os.userInfo().username;
  const registry = buildPathRegistry();
  const confProjects = readProjects();
  // session_id and session_created pin the *incarnation*: a killed and recreated session
  // with the same name is a different session, which the brief store relies on.
  const sessions = rows(raw).map(fields => {
    const [name, windows, attached, sessionPath, activityTs, sessionId, createdAt, explicitRaw] = fields;
    const windowList = (windowsBySession.get(name) || []).map(([index, wname, active]) => (
      { index: parseInt(index), name: wname, active: active === '1' }));
    const { claudeRunning, projectPath, paneTitle } = readPanes(panesBySession.get(name) || [], sessionPath);

    // Canonical project identity — the evidence chain lives in lib/session-identity.js.
    // Pane titles are conversation topics, so they only ever feed the description below.
    const explicitProject = (explicitRaw || '').trim();
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

  return assignInstanceLabels(sessions);
}

// Attention changes between listings (a hook fires, the user answers), so it is applied
// and the order recomputed each time the list is served, not frozen into the cache.
function decorate(list) {
  const served = list.map(s => ({ ...s, needsAttention: !!attention.pendingAttention[s.name] }));
  // Sort: attention first, then identified projects above fallback names, then by activity
  served.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    if (a.projectConfirmed !== b.projectConfirmed) return a.projectConfirmed ? -1 : 1;
    return b.lastActivity - a.lastActivity;
  });
  attention.setLastSessions(served);
  return served;
}

// Every tab polls this list. Concurrent callers share one listing, and a listing younger
// than `maxAgeMs` is reused, so N open tabs cost one set of tmux calls, not N.
const MAX_AGE_MS = 1500;
let cached = null;
let cachedAt = 0;
let inflight = null;

function refresh(run) {
  if (!inflight) {
    inflight = collectSessions(run)
      .then(list => { cached = list; cachedAt = Date.now(); return list; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

async function listLiveSessions({ maxAgeMs = MAX_AGE_MS, run } = {}) {
  if (cached && Date.now() - cachedAt < maxAgeMs) return decorate(cached);
  return decorate(await refresh(run));
}

function resetSessionCache() { cached = null; cachedAt = 0; inflight = null; }

// Resolve a notification against recent session data; re-list tmux when that data is
// stale or does not contain the target.
async function resolveLiveNotificationTarget(input) {
  const recent = attention.lastSessions();
  if (recent.length && Date.now() - attention.lastSessionsAt() < 5000) {
    const hit = resolveNotificationTarget(input, recent);
    if (hit.targetSession) return hit;
  }
  return resolveNotificationTarget(input, await listLiveSessions({ maxAgeMs: 0 }));
}

// Prune attention for sessions that no longer exist. Attention is NOT cleared from what the
// pane looks like: Claude's idle status bar always shows a context meter ("█████░░ 83%"),
// which a screen check read as "busy again" and so wiped every alert within ten seconds.
// It clears when the user acts — answers from Matrix (/api/send), dismisses it, or answers
// in the terminal, which the Claude Code hook reports through /api/attention/clear.
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
}

// Brief session resolution and pane capture deliberately do NOT live here: they run on the
// shell-free, asynchronous, timeout-bounded boundary in server/lib/brief-tmux.js so no
// request can block on tmux and no session name can reach a shell.

module.exports = {
  listLiveSessions, resolveLiveNotificationTarget, sweepAttention, collectSessions, resetSessionCache,
};
