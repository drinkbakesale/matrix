// tmux boundary for the e-ink service. Every call is argv-only (execFile):
// session names and user text are data, never shell syntax. No call here can
// kill, resize or otherwise disturb a session.
const { execFile: realExecFile } = require('child_process');
const crypto = require('crypto');

const FIELDS = ['pid', 'session_id', 'session_created', 'session_name', 'window_id', 'pane_id', 'pane_pid', 'pane_current_command', 'pane_current_path', 'pane_dead', '@matrix_project'];
const FORMAT = FIELDS.map((f) => `#{${f}}`).join('\t');
const ALLOWED_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'Space', 'C-c', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
const MAX_KEYS = 12;

class TmuxError extends Error {}

function createTmux({ bin = process.env.MATRIX_TMUX || 'tmux', execFile = realExecFile } = {}) {
  const run = (args, opts = {}) => new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve(String(stdout));
    });
  });

  // Returns every pane of every session. "No server running" is the true fact
  // of zero sessions; any other failure is thrown so it cannot look like an
  // empty list.
  async function listPanes() {
    let out;
    try {
      out = await run(['list-panes', '-a', '-F', FORMAT]);
    } catch (err) {
      if (/no server running|error connecting to|No such file or directory/.test(err.stderr || '') && err.code !== 'ENOENT') return [];
      throw new TmuxError(`tmux list-panes failed: ${(err.stderr || err.message).trim()}`);
    }
    return out.split('\n').filter(Boolean).map((line) => {
      const v = line.split('\t');
      if (v.length !== FIELDS.length) throw new TmuxError(`unexpected tmux list-panes line: ${JSON.stringify(line)}`);
      const o = Object.fromEntries(FIELDS.map((f, i) => [f, v[i]]));
      return {
        serverPid: o.pid, sessionId: o.session_id, sessionCreated: o.session_created, sessionName: o.session_name,
        windowId: o.window_id, paneId: o.pane_id, panePid: o.pane_pid, command: o.pane_current_command,
        cwd: o.pane_current_path, dead: o.pane_dead === '1', project: o['@matrix_project'] || '',
      };
    });
  }

  const paneOk = (paneId) => /^%\d+$/.test(paneId);

  // Sends text literally: stored in a private tmux buffer by argv, pasted into
  // the exact pane, then one Enter. Nothing is interpreted by a shell.
  async function sendText(paneId, text) {
    if (!paneOk(paneId)) throw new TmuxError(`invalid pane id ${JSON.stringify(paneId)}`);
    const buf = `matrix-eink-${crypto.randomBytes(6).toString('hex')}`;
    try {
      await run(['set-buffer', '-b', buf, '--', text]);
    } catch (err) {
      const e = new TmuxError(`tmux set-buffer failed: ${(err.stderr || err.message).trim()}`);
      e.notStarted = true; // nothing reached the pane
      throw e;
    }
    try {
      await run(['paste-buffer', '-d', '-p', '-r', '-b', buf, '-t', paneId]);
      await run(['send-keys', '-t', paneId, 'Enter']);
    } catch (err) {
      throw new TmuxError(`tmux send failed: ${(err.stderr || err.message).trim()}`);
    }
  }

  async function sendKeys(paneId, keys) {
    if (!paneOk(paneId)) throw new TmuxError(`invalid pane id ${JSON.stringify(paneId)}`);
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS || !keys.every((k) => ALLOWED_KEYS.has(k))) {
      throw new TmuxError('key sequence not allowed');
    }
    let sent = 0;
    try {
      for (const k of keys) { await run(['send-keys', '-t', paneId, k]); sent += 1; }
    } catch (err) {
      const e = new TmuxError(`tmux send-keys failed after ${sent} key(s): ${(err.stderr || err.message).trim()}`);
      e.notStarted = sent === 0 && err.killed !== true;
      throw e;
    }
  }

  async function capturePane(paneId) {
    if (!paneOk(paneId)) throw new TmuxError(`invalid pane id ${JSON.stringify(paneId)}`);
    try {
      return await run(['capture-pane', '-p', '-J', '-t', paneId]);
    } catch (err) {
      throw new TmuxError(`tmux capture-pane failed: ${(err.stderr || err.message).trim()}`);
    }
  }

  return { listPanes, sendText, sendKeys, capturePane };
}

module.exports = { createTmux, TmuxError, ALLOWED_KEYS };
