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
const matrixHome = process.env.MATRIX_HOME || path.join(homeDir, '.matrix');
const registryPath = path.join(matrixHome, 'project-paths.conf');
const confPath = path.join(matrixHome, 'projects.conf');

function buildRegistry() {
  const entries = [];
  // From project-paths.conf
  try {
    for (const line of fs.readFileSync(registryPath, 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const [rawPath, name] = line.split('|').map(s => s.trim());
      if (rawPath && name) entries.push({ prefix: rawPath.replace(/^~/, homeDir), name });
    }
  } catch {}
  // From projects.conf (skip home dir)
  try {
    for (const line of fs.readFileSync(confPath, 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const parts = line.split('|');
      const name = parts[0]?.trim();
      const rawPath = parts[1]?.trim()?.replace(/^~/, homeDir);
      if (name && rawPath && rawPath !== homeDir) entries.push({ prefix: rawPath, name });
    }
  } catch {}
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
