'use strict';
// Read-only build-controller summary for the Matrix build inbox.
// The binary and its arguments are fixed by the caller; nothing from HTTP reaches here.

const path = require('path');

const MAX_ITEMS_PER_GROUP = 50;
const MAX_FIELD_LENGTH = 160;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

const ERROR_STATUS = {
  not_configured: 503,
  unavailable: 503,
  timeout: 504,
  output_too_large: 502,
  failed: 502,
  malformed_output: 502,
};

class BuildInboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BuildInboxError';
    this.code = code;
  }
}

function field(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const s = String(value).replace(/\p{Cc}/gu, ' ').trim();
  return s.length > MAX_FIELD_LENGTH ? s.slice(0, MAX_FIELD_LENGTH - 1) + '…' : s;
}

function malformed(detail) {
  return new BuildInboxError('malformed_output', `buildctl inbox output was not a valid summary (${detail})`);
}

// Every entry is validated, including those past the display cap: a group carrying an
// unusable entry is malformed controller output, not something to render partially.
function parseGroup(data, key, pick) {
  const list = data[key];
  if (!Array.isArray(list)) throw malformed(`${key} is not a list`);
  const items = [];
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw malformed(`${key}[${i}] is not an object`);
    const taskId = field(raw.task_id);
    if (!taskId) throw malformed(`${key}[${i}] has no task_id`);
    const project = field(raw.repo) || field(raw.project);
    if (!project) throw malformed(`${key}[${i}] has no project`);
    if (items.length < MAX_ITEMS_PER_GROUP) {
      items.push({ taskId, project, updated: field(raw.updated ?? raw.age), ...pick(raw) });
    }
  });
  return { items, total: list.length };
}

// Validate `buildctl inbox --json` output and reduce it to the compact mobile summary.
function parseBuildInbox(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout));
  } catch {
    throw malformed('invalid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw malformed('not an object');

  const needsYou = parseGroup(data, 'needs_you', r => ({ reason: field(r.reason), state: field(r.state) }));
  const running = parseGroup(data, 'running', r => ({ stage: field(r.state) }));
  const finished = parseGroup(data, 'finished', r => ({ result: field(r.state) }));

  return {
    needsYou: needsYou.items,
    running: running.items,
    finished: finished.items,
    counts: { needsYou: needsYou.total, running: running.total, finished: finished.total },
  };
}

function classifyExecError(err) {
  if (err.code === 'ENOENT' || err.code === 'EACCES') {
    return new BuildInboxError('unavailable', 'buildctl is not available at the configured path');
  }
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new BuildInboxError('output_too_large', 'buildctl output exceeded the size limit');
  }
  if (err.killed) return new BuildInboxError('timeout', 'buildctl did not respond in time');
  return new BuildInboxError('failed', 'buildctl inbox exited with an error');
}

// Run the fixed read-only command with bounded runtime and output.
function runBuildInbox({ binary, args, execFile, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER }) {
  return new Promise((resolve, reject) => {
    if (typeof binary !== 'string' || !path.isAbsolute(binary)) {
      reject(new BuildInboxError('not_configured', 'buildctl path must be absolute'));
      return;
    }
    if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
      reject(new BuildInboxError('not_configured', 'buildctl arguments are invalid'));
      return;
    }
    const options = { timeout: timeoutMs, maxBuffer, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8' };
    try {
      execFile(binary, args, options, (err, stdout) => {
        if (err) {
          reject(classifyExecError(err));
          return;
        }
        try {
          resolve(parseBuildInbox(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      });
    } catch (err) {
      reject(classifyExecError(err));
    }
  });
}

function buildInboxErrorStatus(err) {
  return (err && ERROR_STATUS[err.code]) || 502;
}

// Single place that turns any inbox failure into the safe client-facing response.
function buildInboxErrorResponse(err) {
  const known = err instanceof BuildInboxError;
  return {
    status: buildInboxErrorStatus(err),
    body: {
      ok: false,
      error: known ? err.code : 'failed',
      message: known ? err.message : 'Build inbox unavailable',
    },
  };
}

module.exports = {
  BuildInboxError,
  parseBuildInbox,
  runBuildInbox,
  buildInboxErrorStatus,
  buildInboxErrorResponse,
  MAX_ITEMS_PER_GROUP,
};
