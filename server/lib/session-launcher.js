'use strict';
// Starts a new Claude Code session for "Start a new session": a tmux session in the chosen
// folder running `claude --dangerously-skip-permissions`, start-up dialogs answered, the
// user's request typed in, and an iTerm2 window attached to it. Shell-free throughout;
// every step that does not happen is an error.

const { execFile } = require('child_process');
const { acceptStartupDialogs, isReady, tmuxRunner } = require('./trust-prompt');

const wait = ms => new Promise(r => setTimeout(r, ms));

function run(bin, args, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(bin, args, { timeout: 10000, maxBuffer: 1024 * 1024, shell: false }, (err, stdout) => {
      if (err) reject(new Error(`${bin} ${args[0]} failed: ${err.message.split('\n')[0]}`)); else resolve(String(stdout || ''));
    });
  });
}

// The new iTerm2 window RUNS the attach in place of the profile's own start-up command
// (this Mac's default profile starts `tmux new-session`, and an attach typed inside that
// tmux is refused as nested). The session name is the number tmux assigned, checked before
// this is built, and the tmux path comes from `which`, so nothing else reaches the command.
const ITERM_SCRIPT = (tmuxBin, name) => [
  'tell application "iTerm"',
  '  activate',
  `  create window with default profile command "${tmuxBin} attach -t ${name}"`,
  'end tell',
].join('\n');

function createSessionLauncher({ exec = run, tmux = tmuxRunner(), acceptDialogs = acceptStartupDialogs, sleep = wait } = {}) {
  return {
    async launch({ cwd, request }) {
      const [name, pane] = (await exec('tmux', ['new-session', '-d', '-P', '-F', '#{session_name}\t#{pane_id}', '-c', cwd])).trim().split('\t');
      if (!/^\d+$/.test(name || '') || !/^%\d+$/.test(pane || '')) throw new Error(`tmux returned an unexpected session "${name}" / pane "${pane}"`);
      await exec('tmux', ['send-keys', '-t', pane, 'exec claude --dangerously-skip-permissions', 'Enter']);
      await acceptDialogs(pane, { tmux, timeoutMs: 30000 });
      if (!isReady(await tmux.capture(pane))) throw new Error(`Claude in session ${name} did not reach its input box in bypass mode`);
      // Text and its Enter go as separate writes: one burst loses long messages.
      await exec('tmux', ['send-keys', '-t', pane, '-l', request]);
      await sleep(150);
      await exec('tmux', ['send-keys', '-t', pane, 'Enter']);
      const tmuxBin = (await exec('/usr/bin/which', ['tmux'])).trim();
      if (!/^\/[\w./-]+$/.test(tmuxBin)) throw new Error(`could not find tmux for iTerm2 (got "${tmuxBin}")`);
      await exec('osascript', ['-e', ITERM_SCRIPT(tmuxBin, name)]);
      return { session: name, pane };
    },
  };
}

module.exports = { createSessionLauncher, ITERM_SCRIPT };
