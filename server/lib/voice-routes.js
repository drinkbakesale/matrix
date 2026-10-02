'use strict';
// Voice input: upload → Apple on-device STT → Whisper fallback, plus push-to-talk state and
// squelch sounds. Extracted from server.js with no behaviour change.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execSync, exec } = require('child_process');
const { PYTHON_PATH } = require('./matrix-config');

const STT_TOOL = path.join(os.homedir(), '.claude-remote', 'stt-tool', '.build', 'release', 'stt-tool');
const WHISPER_SOCKET = '/tmp/matrix-whisper.sock';
const SOUND_SOCKET = '/tmp/matrix-sound.sock';
const audioUploadDir = path.join(os.tmpdir(), 'matrix-audio');

const pttClients = new Set();
let pttState = 'idle'; // 'idle' | 'recording'

function ensureWhisperServer() {
  if (fs.existsSync(WHISPER_SOCKET)) return;
  const whisperPy = path.join(os.homedir(), '.claude-remote', 'app', 'whisper-server.py');
  if (!fs.existsSync(whisperPy)) { console.log('[whisper] server script not found'); return; }
  const child = exec(`${PYTHON_PATH} "${whisperPy}"`, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.unref();
  console.log('[whisper] started persistent server, PID:', child.pid);
}

function whisperTranscribe(wavPath) {
  return new Promise((resolve) => {
    const client = net.createConnection(WHISPER_SOCKET, () => { client.write(wavPath); });
    let data = '';
    client.on('data', (chunk) => { data += chunk; });
    client.on('end', () => {
      try { resolve(JSON.parse(data).text || ''); } catch { resolve(''); }
    });
    client.on('error', () => resolve(''));
    setTimeout(() => { client.destroy(); resolve(''); }, 15000);
  });
}

function playSquelch(name) {
  try {
    const client = net.createConnection(SOUND_SOCKET, () => { client.write(name); client.end(); });
    client.on('error', () => {}); // sound server not running, ignore
  } catch {}
}

function ensureSoundServer() {
  if (fs.existsSync(SOUND_SOCKET)) return;
  const soundScript = path.join(__dirname, '..', 'sound-server.py');
  if (!fs.existsSync(soundScript)) return;
  const child = exec(`${PYTHON_PATH} "${soundScript}"`, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.unref();
  console.log('[sound] Started sound server, PID:', child.pid);
}

function mount(app) {
  const upload = require('multer')({ dest: audioUploadDir });

  app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no audio' });
    const webmPath = req.file.path;
    const wavPath = webmPath + '.wav';
    try {
      execSync(`ffmpeg -y -i '${webmPath}' -ar 16000 -ac 1 '${wavPath}' 2>/dev/null`);
      let text = '';
      if (fs.existsSync(STT_TOOL)) {
        try {
          const result = execSync(`'${STT_TOOL}' '${wavPath}'`, { encoding: 'utf8', timeout: 15000 });
          text = JSON.parse(result.trim()).text || '';
          if (text) console.log('[transcribe] Apple STT:', text);
        } catch (sttErr) {
          console.log('[transcribe] Apple STT failed, falling back to Whisper:', sttErr.message);
        }
      }
      if (!text) {
        text = await whisperTranscribe(wavPath);
        if (text) console.log('[transcribe] Whisper:', text);
      }
      res.json({ text });
    } catch (err) {
      console.error('[transcribe] error:', err.message);
      res.json({ text: '' });
    } finally {
      try { fs.unlinkSync(webmPath); } catch {}
      try { fs.unlinkSync(wavPath); } catch {}
    }
  });

  app.post('/api/ptt/cleanup', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.json({ text: '' });
    let cleaned = text.trim();
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    cleaned = cleaned.replace(/\b(\w+)\s+\1\b/gi, '$1');      // "the the" → "the"
    cleaned = cleaned.replace(/\s{2,}/g, ' ');
    if (cleaned && !/[.!?]$/.test(cleaned)) cleaned += '.';
    res.json({ text: cleaned });
  });

  app.get('/api/ptt/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'ptt-state', state: pttState })}\n\n`);
    pttClients.add(res);
    req.on('close', () => pttClients.delete(res));
  });

  app.post('/api/ptt-event', (req, res) => {
    const { event } = req.body;
    const announce = state => {
      const payload = `data: ${JSON.stringify({ type: 'ptt-state', state })}\n\n`;
      for (const client of pttClients) client.write(payload);
    };
    if (event === 'start' && pttState !== 'recording') {
      pttState = 'recording';
      playSquelch('squelch_open');
      announce('recording');
      res.json({ ok: true, state: 'recording' });
    } else if (event === 'stop' && pttState !== 'idle') {
      pttState = 'idle';
      playSquelch('squelch_close');
      announce('idle');
      res.json({ ok: true, state: 'idle' });
    } else {
      res.json({ ok: true, state: pttState, unchanged: true });
    }
  });

  app.post('/api/ptt/sound', (req, res) => {
    const { type } = req.body;
    if (type === 'open') playSquelch('squelch_open');
    else if (type === 'close') playSquelch('squelch_close');
    res.json({ ok: true });
  });
}

module.exports = { mount, ensureWhisperServer, ensureSoundServer };
