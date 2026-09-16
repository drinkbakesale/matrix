'use strict';
// Session identity and notification routing for Matrix.
// Pure functions (no tmux or filesystem access) so the evidence chain is testable.

const path = require('path');

// Labels that name the Matrix control surface rather than a project. The notify hook
// reports "matrix" for every untagged home-directory session, so on its own this
// label identifies no particular terminal.
const GENERIC_CONTROL_LABELS = new Set(['matrix']);

const MAX_LABEL_LENGTH = 200;

function cleanLabel(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\p{Cc}/gu, '').trim().slice(0, MAX_LABEL_LENGTH);
}

function normalizeProjectName(value) {
  return cleanLabel(value).replace(/^_\s+/, '');
}

function stripTrailingSlash(p) {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function expandHome(p, homeDir) {
  return homeDir ? p.replace(/^~(?=$|\/)/, homeDir) : p;
}

// Longest-prefix match of a path against [{ prefix, name }], respecting directory
// boundaries so /Projects/matrix does not claim /Projects/matrix-old.
function matchProject(filePath, registry, homeDir) {
  if (!filePath) return null;
  const resolved = stripTrailingSlash(expandHome(filePath, homeDir));
  let best = null;
  for (const entry of registry || []) {
    if (!entry || !entry.prefix || !entry.name) continue;
    const prefix = stripTrailingSlash(expandHome(entry.prefix, homeDir));
    if (prefix === '/') continue;
    if (resolved === prefix || resolved.startsWith(prefix + '/')) {
      if (!best || prefix.length > best.length) best = { length: prefix.length, name: entry.name };
    }
  }
  return best ? best.name : null;
}

// Evidence chain, strongest first:
//   1. explicit @matrix_project tag
//   2. registry path match on the pane working directory (never the home directory)
//   3. non-home pane working-directory basename
//   4. tmux session name — a numeric or generic control name is only a fallback
// Pane titles are Claude conversation topics and are never used as identity.
function resolveProjectIdentity({ sessionName, explicitProject, cwd, homeDir, username, registry }) {
  const name = cleanLabel(sessionName);

  const explicit = normalizeProjectName(explicitProject);
  if (explicit) return { projectName: explicit, source: 'explicit', confirmed: true };

  const dir = typeof cwd === 'string' ? stripTrailingSlash(cwd) : '';
  const atHome = !dir || dir === stripTrailingSlash(homeDir || '') || path.basename(dir) === username;
  if (!atHome) {
    const registered = normalizeProjectName(matchProject(dir, registry, homeDir));
    if (registered) return { projectName: registered, source: 'registry', confirmed: true };
    const folder = normalizeProjectName(path.basename(dir));
    if (folder) return { projectName: folder, source: 'cwd', confirmed: true };
  }

  const base = name.replace(/-\d+$/, '');
  if (base && !/^\d+$/.test(base) && !GENERIC_CONTROL_LABELS.has(base.toLowerCase())) {
    return { projectName: base, source: 'session-name', confirmed: true };
  }
  return { projectName: name, source: 'fallback', confirmed: false };
}

// Description for a session with no project identity. Claude titles its pane with the
// conversation topic, which says what the session is doing. Other agents and shells leave the
// terminal default — Codex titles every home-directory session with the folder name, i.e. the
// username — and a title that only echoes the user, host, or folder describes nothing.
function describeFromPaneTitle({ paneTitle, cwd, homeDir, username, hostname }) {
  // Strip leading spinner chars (unicode when LANG is set; `_` when tmux
  // downgrades to ASCII without a UTF-8 locale).
  const title = cleanLabel(paneTitle)
    .replace(/^[⠀-⣿✲✳✴•_\s]+/, '')
    .replace(/^Claude Code\s*$/i, '')
    .trim();
  if (title.length <= 2) return '';
  const lower = title.toLowerCase();
  if (hostname && lower.includes(hostname.toLowerCase())) return '';
  const dir = typeof cwd === 'string' ? stripTrailingSlash(cwd) : '';
  const terminalDefaults = [username, homeDir && path.basename(homeDir), dir && path.basename(dir)];
  if (terminalDefaults.some(d => d && d.toLowerCase() === lower)) return '';
  return title.length > 80 ? title.slice(0, 77) + '...' : title;
}

function formatSessionLabel(projectName, instanceSuffix) {
  return instanceSuffix ? `${projectName} · ${instanceSuffix}` : projectName;
}

// Every live session stays listed. When several sessions share a project, each one whose
// tmux name differs from the project name gets that tmux name as a stable suffix.
function assignInstanceLabels(sessions) {
  const counts = new Map();
  for (const s of sessions) {
    const key = s.projectName.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return sessions.map(s => {
    const shared = counts.get(s.projectName.toLowerCase()) > 1;
    const instanceSuffix = shared && s.name !== s.projectName ? s.name : '';
    return { ...s, instanceSuffix, displayName: formatSessionLabel(s.projectName, instanceSuffix) };
  });
}

// Resolve a hook notification to one concrete live tmux session.
// input: { tmuxSession, session, project } as posted by the notify hook.
// Returns { targetSession, projectName, via }; targetSession is null when nothing live
// can be identified, and callers must then not open any terminal.
function resolveNotificationTarget(input, sessions) {
  const live = Array.isArray(sessions) ? sessions : [];
  const byName = new Map(live.map(s => [s.name, s]));
  const hit = (s, via) => ({ targetSession: s.name, projectName: s.projectName || s.name, via });
  const miss = via => ({ targetSession: null, projectName: null, via });

  // A hook that names its own tmux session is authoritative; if that session is gone,
  // do not guess a different one from the label.
  const tmuxSession = cleanLabel(input && input.tmuxSession);
  if (tmuxSession) {
    return byName.has(tmuxSession) ? hit(byName.get(tmuxSession), 'tmux-session') : miss('tmux-session-not-live');
  }

  const labels = [input && input.session, input && input.project]
    .map(cleanLabel)
    .filter(l => l && !GENERIC_CONTROL_LABELS.has(l.toLowerCase()));

  for (const label of labels) {
    if (byName.has(label)) return hit(byName.get(label), 'session-name');
  }

  // Legacy label-only notifications may name a project. Accept that only when exactly one
  // live session belongs to it: several sessions of one project are ambiguous, and recent
  // activity cannot identify which terminal raised the alert.
  for (const label of labels) {
    const confirmed = live.filter(s => s.projectConfirmed && s.projectName);
    let matches = confirmed.filter(s => s.projectName === label);
    if (!matches.length) matches = confirmed.filter(s => s.projectName.toLowerCase() === label.toLowerCase());
    if (matches.length === 1) return hit(matches[0], 'project');
    if (matches.length > 1) return miss('ambiguous-label');
  }

  return miss('unresolved');
}

module.exports = {
  GENERIC_CONTROL_LABELS,
  cleanLabel,
  matchProject,
  resolveProjectIdentity,
  describeFromPaneTitle,
  formatSessionLabel,
  assignInstanceLabels,
  resolveNotificationTarget,
};
