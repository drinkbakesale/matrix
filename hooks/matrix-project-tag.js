#!/usr/bin/env node
// matrix-project-tag.js — PostToolUse hook (async)
// Watches file paths in Edit/Write/Read tool calls and sets
// @matrix_project on the tmux session so the Matrix app knows
// which project this session is working on.

const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');

const homeDir = os.homedir();
// Find projects.conf / project-paths.conf wherever they actually live. When
// Claude Code runs this hook, MATRIX_HOME env var isn't set, so default from
// env, then probe the two standard locations.
const candidateHomes = [
  process.env.MATRIX_HOME,
  path.join(homeDir, '.claude-remote'),
  path.join(homeDir, '.matrix'),
].filter(Boolean);
let matrixHome = candidateHomes[0] || path.join(homeDir, '.matrix');
for (const c of candidateHomes) {
  if (fs.existsSync(path.join(c, 'projects.conf'))) { matrixHome = c; break; }
}
const registryPath = path.join(matrixHome, 'project-paths.conf');
const confPath = path.join(matrixHome, 'projects.conf');

// Decode a Claude Code project-history dir name back to its real filesystem
// path. The encoded form replaces '/' with '-', which is ambiguous because
// folder names can contain '-'. Resolve by greedy forward-match against the
// real filesystem at each level.
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

function buildRegistry() {
  const entries = [];
  // From project-paths.conf (manual overrides)
  try {
    for (const line of fs.readFileSync(registryPath, 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const [rawPath, name] = line.split('|').map(s => s.trim());
      if (rawPath && name) entries.push({ prefix: rawPath.replace(/^~/, homeDir), name });
    }
  } catch {}
  // From projects.conf (manually curated with custom names + descriptions)
  try {
    for (const line of fs.readFileSync(confPath, 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const parts = line.split('|');
      const name = parts[0]?.trim();
      const rawPath = parts[1]?.trim()?.replace(/^~/, homeDir);
      if (name && rawPath && rawPath !== homeDir) entries.push({ prefix: rawPath, name });
    }
  } catch {}
  // From ~/.claude/projects/ — every project Claude Code has ever been opened
  // in. This lets the hook auto-tag sessions for projects that were never
  // manually registered, which is most of them in practice.
  try {
    const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
    for (const name of fs.readdirSync(claudeProjectsDir)) {
      if (!name.startsWith('-')) continue;
      if (name.startsWith('-private-')) continue;                  // temp battle dirs
      if (name.includes('--claude-mem-')) continue;                // mem-observer
      if (name.includes('generated-apps-')) continue;              // generated scratch dirs
      if (name === '-Users-' + (process.env.USER || '')) continue; // plain home, too broad
      const decoded = decodeClaudeProjectPath(name);
      if (!decoded || decoded === homeDir) continue;
      const projectName = path.basename(decoded).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (projectName) entries.push({ prefix: decoded, name: projectName });
    }
  } catch {}
  // Sort longest prefix first (most specific match wins, handles nested projects)
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return entries;
}

function run(input) {
  const { tool_name, tool_input } = input;
  if (!['Read', 'Edit', 'Write', 'Glob', 'Grep'].includes(tool_name)) return;

  const filePath = tool_input?.file_path || tool_input?.path || '';
  if (!filePath) return;

  const resolved = filePath.replace(/^~/, homeDir);
  const registry = buildRegistry();

  let project = null;
  for (const entry of registry) {
    if (resolved.startsWith(entry.prefix)) {
      project = entry.name;
      break;
    }
  }
  if (!project) return;

  // Set @matrix_project on our tmux session
  try {
    const session = execSync("tmux display-message -p '#{session_name}' 2>/dev/null", {
      encoding: 'utf8', timeout: 1000
    }).trim();
    if (!session) return;

    let current = '';
    try {
      current = execSync(`tmux show-option -t '${session}' -v @matrix_project 2>/dev/null`, {
        encoding: 'utf8', timeout: 1000
      }).trim();
    } catch {}

    if (current !== project) {
      execSync(`tmux set-option -t '${session}' @matrix_project '${project}'`, { timeout: 1000 });
    }
  } catch {}
}

// Read from stdin
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  try { run(JSON.parse(raw)); } catch {}
});
