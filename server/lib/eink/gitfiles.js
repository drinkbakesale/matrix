// Working-tree change set for a session's directory, collected with read-only
// argv Git commands. These changes are NOT attributed to the Claude session.
const { execFile: realExecFile } = require('child_process');

function createGit({ bin = process.env.MATRIX_GIT || 'git', execFile = realExecFile } = {}) {
  const run = (args) => new Promise((resolve) => {
    execFile(bin, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

  // Returns { available, reason, toplevel, entries:[{status,path}] }.
  async function worktree(cwd) {
    if (!cwd || typeof cwd !== 'string' || !cwd.startsWith('/')) {
      return { available: false, reason: 'session directory is unknown', toplevel: null, entries: [] };
    }
    const top = await run(['-C', cwd, 'rev-parse', '--show-toplevel']);
    if (top.err) {
      const notRepo = /not a git repository/i.test(top.stderr);
      return { available: false, reason: notRepo ? 'not a Git repository' : `git failed: ${(top.stderr || top.err.message).trim().split('\n')[0]}`, toplevel: null, entries: [] };
    }
    const st = await run(['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (st.err) {
      return { available: false, reason: `git status failed: ${(st.stderr || st.err.message).trim().split('\n')[0]}`, toplevel: top.stdout.trim(), entries: [] };
    }
    const parts = st.stdout.split('\0');
    const entries = [];
    for (let i = 0; i < parts.length; i++) {
      const rec = parts[i];
      if (!rec) continue;
      const status = rec.slice(0, 2);
      let path = rec.slice(3);
      if (status[0] === 'R' || status[0] === 'C') {
        const from = parts[++i]; // -z puts the original path in the next field
        path = `${from} -> ${path}`;
      }
      entries.push({ status: status.trim() || '??', path });
    }
    return { available: true, reason: '', toplevel: top.stdout.trim(), entries };
  }

  return { worktree };
}

module.exports = { createGit };
