'use strict';
// Types a message that carries attached files into a Claude pane. Plain text is typed as
// keystrokes; each attached file path is delivered as a bracketed PASTE, which is what a
// file dropped on iTerm2 is, and what makes Claude Code attach an image ("[Image #1]")
// instead of reading the path as words (measured: typed path -> no attachment, pasted path
// -> [Image #1]). The return goes last as its own write, as in pane-stream's typeInto.

const { execFileSync } = require('child_process');

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
const tmux = args => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

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
  let n = 0;
  let pasted = false;
  for (const p of parts) {
    if (p.text !== undefined) {
      if (p.text) run(['send-keys', '-t', target, '-H', ...hexKeys(p.text)]);
    } else {
      const buffer = `matrix-paste-${process.pid}-${Date.now()}-${n++}`;
      run(['set-buffer', '-b', buffer, '--', p.paste]);
      run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target]);
      await wait(PASTE_GAP_MS);
      pasted = true;
    }
  }
  if (submit) {
    await wait(pasted ? AFTER_PASTE_ENTER_MS : ENTER_GAP_MS);
    run(['send-keys', '-t', target, '-H', '0x0d']);
  }
}

module.exports = { typeParts, checkParts };
