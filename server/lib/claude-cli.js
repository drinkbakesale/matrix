'use strict';
// One-shot calls to the installed `claude` CLI: shell-free, no tools, no MCP, no saved
// session, bounded in time and output. Failures reject with a short message; the child's
// own output is never relayed (it may echo private transcript text).

const { execFile } = require('child_process');

function createClaudeCli({ execFileImpl = execFile, bin = 'claude', timeoutMs = 60000, maxBuffer = 64 * 1024 } = {}) {
  return {
    run({ model, stdin }) {
      const args = ['-p', '--model', model, '--output-format', 'text', '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
      return new Promise((resolve, reject) => {
        const child = execFileImpl(bin, args, {
          timeout: timeoutMs,
          maxBuffer,
          cwd: require('os').tmpdir(),
          // USER is needed for the CLI to find its login in the keychain.
          env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TERM: 'dumb' },
          windowsHide: true,
        }, (err, stdout) => {
          if (err) { reject(new Error(err.killed ? 'claude CLI timed out' : `claude CLI failed (${err.code})`)); return; }
          resolve(String(stdout || ''));
        });
        if (child && child.stdin) child.stdin.end(stdin);
      });
    },
  };
}

module.exports = { createClaudeCli };
