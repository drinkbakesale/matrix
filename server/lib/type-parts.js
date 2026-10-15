'use strict';
// Types a message that carries attached files into a Claude pane. Plain text is typed as
// keystrokes; each attached file path is delivered as a bracketed PASTE, which is what a
// file dropped on iTerm2 is, and what makes Claude Code attach an image ("[Image #1]")
// instead of reading the path as words (measured: typed path -> no attachment, pasted path
// -> [Image #1]). The return goes last as its own write, as in pane-stream's typeInto.

const { execFile } = require('child_process');

const ENTER_GAP_MS = 80;
// Claude Code takes a moment to turn a pasted image path into an attachment. Keys arriving
// inside that moment break it: typing 60 ms after the paste left the path as plain text, and
// an Enter 140 ms after it was swallowed (message left unsent). One second, measured on a
// 3 MB PNG and a small upload, attaches the image and submits.
const PASTE_GAP_MS = 1000;
const AFTER_PASTE_ENTER_MS = 1000;
const MAX_PARTS = 64;
const MAX_PATH_CHARS = 1024;
const hexKeys = text => Buffer.from(text).toString('hex').match(/.{2}/g).map(h => '0x' + h);
const TMUX_TIMEOUT_MS = 5000;

// Every tmux call made while typing is asynchronous and time-limited. A tmux client can wait
// forever (see leaveScrollMode); run synchronously, that froze the whole Matrix server for
// every session and device (2026-10-15, 16 minutes). Now only that one message fails.
function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve(String(stdout || ''));
      reject(new Error(err.killed ? `tmux ${args[0]} did not finish within ${TMUX_TIMEOUT_MS / 1000} s` : `tmux ${args[0]} failed: ${String(err.message).split('\n')[0].slice(0, 200)}`));
    });
  });
}

// A pane scrolled up in tmux (mouse wheel in iTerm2 enters copy mode) takes keys as copy-mode
// COMMANDS, not text for Claude; with emacs keys, `t`, `f`, `g` open a one-key prompt that a
// command-line tmux client can never answer, so `send-keys` waits forever. Typed text is meant
// for Claude, so leave the mode first, and refuse to type if the pane is still in one.
async function leaveScrollMode(target, run = tmux) {
  const inMode = async () => String(await run(['display-message', '-p', '-t', target, '#{pane_in_mode}'])).trim() === '1';
  if (!(await inMode())) return false;
  await run(['send-keys', '-t', target, '-X', 'cancel']);
  if (await inMode()) throw new Error('the session is in a tmux mode Matrix could not leave; press q in it and resend');
  return true;
}

// parts: [{ text } | { paste: '/abs/path' }]. Throws on anything else, so a malformed
// message is reported rather than half-typed.
function checkParts(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) throw new Error('message parts are missing or too many');
  for (const p of parts) {
    if (p && typeof p.text === 'string' && Object.keys(p).length === 1) continue;
    if (p && typeof p.paste === 'string' && Object.keys(p).length === 1
        && p.paste.startsWith('/') && p.paste.length <= MAX_PATH_CHARS && !/[\u0000-\u001f]/.test(p.paste)) continue;
    throw new Error('a message part is neither text nor an absolute file path');
  }
  return parts;
}

async function typeParts(target, parts, { submit = true, run = tmux, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  checkParts(parts);
  await leaveScrollMode(target, run);
  let n = 0;
  let pasted = false;
  for (const p of parts) {
    if (p.text !== undefined) {
      if (p.text) await run(['send-keys', '-t', target, '-H', ...hexKeys(p.text)]);
    } else {
      const buffer = `matrix-paste-${process.pid}-${Date.now()}-${n++}`;
      await run(['set-buffer', '-b', buffer, '--', p.paste]);
      await run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]);
      await wait(PASTE_GAP_MS);
      pasted = true;
    }
  }
  if (submit) {
    await wait(pasted ? AFTER_PASTE_ENTER_MS : ENTER_GAP_MS);
    await run(['send-keys', '-t', target, '-H', '0x0d']);
  }
}

module.exports = { typeParts, checkParts, leaveScrollMode, tmux, TMUX_TIMEOUT_MS };
