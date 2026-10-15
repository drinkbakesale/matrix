'use strict';
// Answers Claude Code's start-up safety dialogs for a session Matrix itself launched, because
// from the phone or tablet there is no way to press the keys.
//
//   Folder trust:  "❯ No, exit / Yes, I trust this folder"   (cursor starts on "No, exit")
//   Bypass mode:   "❯ No, exit / Yes, I accept"              (normally off via settings)
//
// The cursor starts on the option that QUITS Claude, so a blind Enter would close the session.
// The answer is: move down, re-read the pane, and press Enter only once the cursor is seen on
// the accepting option. Anything unexpected is reported, never guessed at.

const { execFile } = require('child_process');

const ACCEPT_OPTIONS = ['Yes, I trust this folder', 'Yes, I accept'];
// Claude's input box is up and running in bypass mode: nothing left to answer.
const isReady = text => /bypass permissions on/.test(String(text));

// Which accepting option is on screen, and whether the ❯ cursor is on it.
function readDialog(text) {
  const lines = String(text).split('\n');
  for (const option of ACCEPT_OPTIONS) {
    const line = lines.find(l => l.includes(option));
    if (line) return { option, selected: /❯/.test(line) };
  }
  return null;
}

function tmuxRunner(execFileImpl = execFile) {
  const run = args => new Promise((resolve, reject) => {
    execFileImpl('tmux', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, shell: false }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout || ''));
    });
  });
  return {
    capture: pane => run(['capture-pane', '-p', '-t', pane]),
    sendKey: (pane, key) => run(['send-keys', '-t', pane, key]),
  };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Watches `pane` until Claude is ready (or timeoutMs) and accepts each dialog it finds.
// Resolves with the list of options it accepted; rejects if a dialog is still on screen when
// time runs out or the cursor never lands on the accepting option.
async function acceptStartupDialogs(pane, {
  tmux = tmuxRunner(), timeoutMs = 20000, intervalMs = 400, settleMs = 150, sleep = wait, now = Date.now,
} = {}) {
  const accepted = [];
  const deadline = now() + timeoutMs;
  let lastSeen = null;
  while (now() < deadline) {
    const screen = await tmux.capture(pane);
    const dialog = readDialog(screen);
    lastSeen = dialog;
    if (!dialog && isReady(screen)) return accepted;
    if (dialog) {
      let current = dialog;
      for (let moves = 0; !current.selected; moves++) {
        if (moves >= 3) throw new Error(`cursor never reached "${dialog.option}" in ${pane}`);
        await tmux.sendKey(pane, 'Down');
        await sleep(settleMs);
        current = readDialog(await tmux.capture(pane));
        if (!current || current.option !== dialog.option) throw new Error(`"${dialog.option}" dialog changed while answering it in ${pane}`);
      }
      await tmux.sendKey(pane, 'Enter');
      accepted.push(dialog.option);
      await sleep(intervalMs);
      continue;
    }
    await sleep(intervalMs);
  }
  if (lastSeen) throw new Error(`"${lastSeen.option}" dialog still open in ${pane} after ${timeoutMs} ms`);
  return accepted;
}

module.exports = { acceptStartupDialogs, readDialog, isReady, tmuxRunner };
