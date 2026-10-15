'use strict';
// POST /api/sessions/new {request}: "Start a new session". Picks the project the request
// belongs to (or a new folder under ~/Projects), starts Claude there in bypass mode, types
// the request in and opens the session in iTerm2.

const fs = require('fs');
const path = require('path');
const { CONF_PATH, MATRIX_HOME } = require('./matrix-config');
const { readProjects, readClaudeProjectHistory } = require('./projects');
const { listCandidates, readProjectFolders, readSessionFolders } = require('./session-router');

const MAX_REQUEST_CHARS = 4000;

function mount(app, {
  router, launcher, confPath = CONF_PATH, readConf = readProjects, readHistory = readClaudeProjectHistory,
  readFolders = () => readProjectFolders(), readSessions = () => readSessionFolders(path.join(MATRIX_HOME, 'session-links')),
}) {
  app.post('/api/sessions/new', async (req, res) => {
    const request = typeof (req.body && req.body.request) === 'string' ? req.body.request.trim() : '';
    if (!request) return res.status(400).json({ error: 'Say what you want to work on.' });
    if (request.length > MAX_REQUEST_CHARS) return res.status(400).json({ error: `Keep it under ${MAX_REQUEST_CHARS} characters.` });
    let step = 'choosing the project';
    try {
      const candidates = listCandidates({ readProjects: readConf, readHistory, readFolders, readSessions });
      const project = await router.route({ request, candidates });
      if (project.created) {
        step = 'creating the project folder';
        fs.mkdirSync(project.path, { recursive: true });
        if (!readConf().some(p => p.path === project.path)) {
          fs.mkdirSync(path.dirname(confPath), { recursive: true });
          fs.appendFileSync(confPath, `${project.name}|${project.path}|server|\n`);
        }
      }
      step = 'starting Claude';
      const { session } = await launcher.launch({ cwd: project.path, request });
      console.log(`[new-session] ${session} in ${project.path}${project.created ? ' (new project)' : ''}`);
      res.json({ ok: true, session, project });
    } catch (err) {
      console.error(`[new-session] failed while ${step}: ${err.message}`);
      res.status(500).json({ error: `Failed while ${step}: ${err.message}` });
    }
  });
}

module.exports = { mount };
