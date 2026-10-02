'use strict';
// Paths and first-run bootstrap, extracted from server.js unchanged in behaviour.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MATRIX_HOME = process.env.MATRIX_HOME || path.join(os.homedir(), '.matrix');
const CONF_PATH = path.join(MATRIX_HOME, 'projects.conf');
const PATH_REGISTRY_PATH = path.join(MATRIX_HOME, 'project-paths.conf');
const VAPID_PATH = path.join(MATRIX_HOME, 'vapid.json');
const SUBS_PATH = path.join(MATRIX_HOME, 'push-subscriptions.json');
const BRIEF_PATH = path.join(MATRIX_HOME, 'briefs.json');
const LOGS_DIR = path.join(MATRIX_HOME, 'logs');
const PYTHON_PATH = process.env.PYTHON_PATH || 'python3';
const PORT = parseInt(process.env.MATRIX_PORT, 10) || 7778;
// Absolute path to the build controller CLI used by the read-only build inbox.
const BUILDCTL_PATH = process.env.MATRIX_BUILDCTL || path.join(os.homedir(), '.local', 'bin', 'buildctl');
const SEARCH_DIRS = ['~/Desktop', '~/Projects', '~/Downloads', '~/Documents'];

function searchDirs() {
  return SEARCH_DIRS.map(d => d.replace('~', os.homedir()));
}

// ── Bootstrap ~/.matrix and seed projects.conf from auto-discovery ──
function bootstrap() {
  if (!fs.existsSync(MATRIX_HOME)) {
    fs.mkdirSync(MATRIX_HOME, { recursive: true });
  }
  if (fs.existsSync(CONF_PATH)) return;
  const lines = ['# name|path|mode|roles|description'];
  for (const dir of searchDirs()) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (['CLAUDE.md', '.git', 'package.json', 'setup.py', 'pyproject.toml']
            .some(f => fs.existsSync(path.join(full, f)))) {
          const name = e.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          lines.push(`${name}|${full}|||`);
        }
      }
    } catch {}
  }
  if (lines.length > 1) fs.writeFileSync(CONF_PATH, lines.join('\n') + '\n');
  console.log(`[matrix] Seeded ${lines.length - 1} projects into ${CONF_PATH}`);
}

module.exports = {
  MATRIX_HOME, CONF_PATH, PATH_REGISTRY_PATH, VAPID_PATH, SUBS_PATH, BRIEF_PATH,
  LOGS_DIR, PYTHON_PATH, PORT, BUILDCTL_PATH, searchDirs, bootstrap,
};
