#!/usr/bin/env node
// matrix-evidence.js — Claude Code hook (all turn events).
// Records typed turn evidence for the Matrix e-ink digest: which tmux pane a
// conversation runs in, prompts, tool events, permission/question prompts and
// turn end. It only observes: it prints nothing and always exits 0, so it can
// never approve, deny or block anything Claude does.
//
// Delivery: POST to the local Matrix server; if Matrix is not running the
// event is written to a spool directory and picked up when it starts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const HOME = process.env.MATRIX_HOME || path.join(os.homedir(), '.matrix');
const EINK = path.join(HOME, 'eink');
const PORT = parseInt(process.env.MATRIX_PORT, 10) || 7778;

function paneIdentity() {
  const tmux = (process.env.TMUX || '').split(',');
  const pane = process.env.TMUX_PANE || '';
  if (tmux.length < 2 || !/^\d+$/.test(tmux[1]) || !/^%\d+$/.test(pane)) return null;
  return { server_pid: tmux[1], pane_id: pane };
}

function build(input) {
  const pane = paneIdentity();
  if (!pane || !input || typeof input.session_id !== 'string') return null;
  const seq = performance.timeOrigin + performance.now();
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const stable = input.tool_use_id
    ? crypto.createHash('sha256').update(`${input.session_id}|${input.hook_event_name}|${input.tool_use_id}`).digest('hex').slice(0, 24)
    : `${Math.floor(seq)}-${process.pid}`;
  const resp = input.tool_response;
  return {
    v: 1,
    event_id: `${input.session_id.slice(0, 8)}-${stable}`,
    seq,
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    transcript_path: input.transcript_path || null,
    cwd: input.cwd,
    source: input.source,
    pane,
    prompt: input.prompt,
    tool_name: input.tool_name,
    tool_use_id: input.tool_use_id,
    // Fingerprint of the full tool input: lets Matrix tie a permission request to the exact tool use it is for.
    tool_input_hash: input.tool_input === undefined ? undefined : crypto.createHash('sha256').update(JSON.stringify(input.tool_input)).digest('hex'),
    tool_input: { file_path: ti.file_path, notebook_path: ti.notebook_path, questions: ti.questions },
    notification_type: input.notification_type,
    message: input.message,
    last_assistant_message: input.last_assistant_message,
    background_tasks: Array.isArray(input.background_tasks) ? input.background_tasks.length : undefined,
    error: input.error || (resp && typeof resp === 'object' && typeof resp.error === 'string' ? resp.error : undefined),
  };
}

function spool(ev) {
  const dir = path.join(EINK, 'spool');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${String(Math.floor(ev.seq)).padStart(15, '0')}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(ev), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, `${name}.json`));
}

function post(ev, token) {
  return new Promise((resolve) => {
    const data = JSON.stringify(ev);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/eink/v1/hook', method: 'POST', timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${token}` },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(0));
    req.end(data);
  });
}

async function main() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  let input;
  try { input = JSON.parse(text); } catch { return; }
  const ev = build(input);
  if (!ev) return; // not inside tmux: not a Matrix session
  let token = null;
  try { token = fs.readFileSync(path.join(EINK, 'hook-token'), 'utf8').trim(); } catch { /* not paired yet: spool */ }
  const status = token ? await post(ev, token) : 0;
  // 2xx: applied. 400: Matrix rejected it as invalid; retrying cannot help.
  // Anything else (offline, 5xx): keep it for Matrix to ingest later.
  if ((status >= 200 && status < 300) || status === 400) return;
  spool(ev);
}

main().catch((err) => {
  try { fs.appendFileSync(path.join(EINK, 'hook-errors.log'), `${new Date().toISOString()} ${err.stack || err}\n`); } catch { /* nothing else to do in a hook */ }
}).finally(() => process.exit(0));
