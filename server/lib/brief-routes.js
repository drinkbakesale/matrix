'use strict';
// HTTP surface for per-session briefs.
//
// The decision logic is a pure function so the same code answers an express request in the
// live server and a bare node:http request in the acceptance harness — the tests exercise
// the real route, not a re-implementation of it.
//
//   GET   /api/sessions/:name/brief   -> current brief, never waits for generation
//   PATCH /api/sessions/:name/brief   -> { goal?, current?, revision } (null clears a field)

const { BriefRequestError } = require('./brief-service');

const BRIEF_PATH = /^\/api\/sessions\/([^/]+)\/brief\/?$/;
const MAX_BODY_BYTES = 8 * 1024;

function parseBriefPath(pathname) {
  const match = BRIEF_PATH.exec(String(pathname || '').split('?')[0]);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

// (method, session name, parsed body, streamed window) -> { status, body }.
// Asynchronous because session/pane resolution is an awaited, cached, bounded process call;
// it still never waits for generation.
async function respond(service, method, name, body, windowName) {
  try {
    if (method === 'GET') return { status: 200, body: { ok: true, brief: await service.read(name, windowName) } };
    if (method === 'PATCH') return { status: 200, body: { ok: true, brief: await service.patch(name, body, windowName) } };
    return { status: 405, body: { ok: false, code: 'method_not_allowed', message: 'use GET or PATCH' } };
  } catch (err) {
    if (err instanceof BriefRequestError) {
      return { status: err.status, body: { ok: false, code: err.code, message: err.message } };
    }
    // Never relay a raw error: it can carry captured transcript text or paths.
    return { status: 500, body: { ok: false, code: 'brief_failed', message: 'the brief service failed' } };
  }
}

// `window` names the tmux window the client is actually streaming, so the brief describes
// the pane on screen rather than whichever window happens to be tmux-active.
function windowParam(value) {
  return typeof value === 'string' ? value : '';
}

function mountExpress(app, service) {
  app.get('/api/sessions/:name/brief', async (req, res) => {
    const { status, body } = await respond(service, 'GET', req.params.name, null, windowParam(req.query.window));
    res.status(status).json(body);
  });
  app.patch('/api/sessions/:name/brief', async (req, res) => {
    const { status, body } = await respond(service, 'PATCH', req.params.name, req.body, windowParam(req.query.window));
    res.status(status).json(body);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new BriefRequestError(413, 'body_too_large', 'request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve(null); return; }
      try { resolve(JSON.parse(text)); }
      catch { reject(new BriefRequestError(400, 'invalid_json', 'body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

// Returns a handler that answers brief requests and reports whether it handled the request,
// so a host can fall through to its own static/API routing.
function createNodeHandler(service) {
  return async function handleBrief(req, res) {
    const name = parseBriefPath(req.url);
    if (name === null) return false;
    let payload = null;
    try {
      if (req.method === 'PATCH' || req.method === 'POST') payload = await readJsonBody(req);
    } catch (err) {
      const status = err instanceof BriefRequestError ? err.status : 400;
      const body = { ok: false, code: err.code || 'invalid_body', message: err.message };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return true;
    }
    const query = new URL(req.url, 'http://localhost').searchParams;
    const { status, body } = await respond(service, req.method, name, payload, windowParam(query.get('window')));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return true;
  };
}

module.exports = { parseBriefPath, respond, mountExpress, createNodeHandler, MAX_BODY_BYTES };
