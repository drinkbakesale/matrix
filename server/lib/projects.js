'use strict';
// projects.conf / project-paths.conf readers plus Claude Code project history.
// Extracted from server.js with no behaviour change.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONF_PATH, PATH_REGISTRY_PATH } = require('./matrix-config');

function readProjects() {
  try {
    return fs.readFileSync(CONF_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#'))
      .map(l => {
        const parts = l.split('|');
        const [name, rawPath, mode, roles, description] = parts;
        const fullPath = rawPath.replace(/^~/, os.homedir());
        return { name, path: fullPath, description: description || '' };
      });
  } catch { return []; }
}

// Build a sorted (longest-first) list of path→projectName mappings
// from projects.conf + project-paths.conf
function buildPathRegistry() {
  const entries = []; // { prefix, name }
  const homeDir = os.homedir();

  // From projects.conf: path → name (skip home dir — too broad)
  for (const p of readProjects()) {
    if (p.path && p.name && p.path !== homeDir) {
      entries.push({ prefix: p.path, name: p.name });
    }
  }

  // From project-paths.conf: path|name
  try {
    const lines = fs.readFileSync(PATH_REGISTRY_PATH, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const [rawPath, name] = line.split('|').map(s => s.trim());
      if (rawPath && name) {
        const fullPath = rawPath.replace(/^~/, os.homedir());
        entries.push({ prefix: fullPath, name });
      }
    }
  } catch {}

  // Sort longest prefix first (most specific match wins)
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return entries;
}

// Auto-detect a project description from common files
function detectDescription(projectPath) {
  if (!projectPath || projectPath === os.homedir()) return '';
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.description) return pkg.description;
    }
    const pyprojectPath = path.join(projectPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      const content = fs.readFileSync(pyprojectPath, 'utf8');
      const m = content.match(/description\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
    for (const readme of ['README.md', 'readme.md', 'Readme.md']) {
      const readmePath = path.join(projectPath, readme);
      if (fs.existsSync(readmePath)) {
        const lines = fs.readFileSync(readmePath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') ||
              trimmed.startsWith('<') || trimmed.startsWith('!')) continue;
          if (trimmed.length > 10 && trimmed.length < 200) return trimmed;
        }
      }
    }
  } catch {}
  return '';
}

// ── Claude Code project history integration ──
// Claude Code stores a session log directory per project at ~/.claude/projects/ encoded as
// `-Users-name-Desktop-projects-landing-page-optimizer`. Decoding requires greedy
// forward-matching against the real filesystem because dashes appear both as path
// separators AND inside folder names.
function decodeClaudeProjectPath(encoded) {
  const parts = encoded.replace(/^-+/, '').split('-');
  if (parts.length === 0) return null;
  let current = '/';
  let i = 0;
  while (i < parts.length) {
    let matched = false;
    for (let j = parts.length; j > i; j--) {
      const candidate = parts.slice(i, j).join('-');
      if (!candidate) continue;
      const next = path.join(current, candidate);
      try {
        if (fs.statSync(next).isDirectory()) {
          current = next;
          i = j;
          matched = true;
          break;
        }
      } catch {}
    }
    if (!matched) return null;
  }
  return current;
}

// Enumerate ~/.claude/projects/ and return projects with last-activity timestamps.
function readClaudeProjectHistory() {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  } catch { return out; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const encoded = e.name;
    if (encoded.startsWith('-private-')) continue;
    if (encoded === '-Users-' + os.userInfo().username) continue;
    if (encoded.includes('--claude-mem-')) continue;
    if (encoded.includes('generated-apps-')) continue;

    const decoded = decodeClaudeProjectPath(encoded);
    if (!decoded) continue;
    if (decoded === os.homedir()) continue;

    // The encoded directory mtime reflects the last time Claude Code was launched there,
    // which is more accurate than the newest .jsonl mtime.
    const encodedDir = path.join(claudeProjectsDir, encoded);
    let lastActivity = 0;
    try { lastActivity = fs.statSync(encodedDir).mtimeMs; } catch {}
    if (!lastActivity) {
      try {
        for (const f of fs.readdirSync(encodedDir)) {
          if (!f.endsWith('.jsonl')) continue;
          try {
            const stat = fs.statSync(path.join(encodedDir, f));
            if (stat.mtimeMs > lastActivity) lastActivity = stat.mtimeMs;
          } catch {}
        }
      } catch {}
    }
    if (!lastActivity) continue;

    out.push({
      name: path.basename(decoded).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      path: decoded,
      lastActivity,
    });
  }
  return out;
}

module.exports = {
  readProjects, buildPathRegistry, detectDescription,
  decodeClaudeProjectPath, readClaudeProjectHistory,
};
