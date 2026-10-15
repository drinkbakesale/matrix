'use strict';
// Files dropped, pasted or picked into a Matrix message box.
//
// A browser never says where a dropped file lives, so:
//   POST /api/files/locate  {files:[{name,size,lastModified}]} -> the ORIGINAL file's path on
//     this Mac when Spotlight finds exactly one file with that name, size and modified time.
//   POST /api/files/upload  multipart "files" -> saved copies under
//     $MATRIX_HOME/uploads/<date>/, for anything that could not be located (pasted images,
//     photos from the phone, unindexed folders).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const multer = require('multer');

const MAX_FILES = 10;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MTIME_TOLERANCE_MS = 2000;

const safeName = name => {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(-100);
  return base || 'file';
};

function spotlight(name) {
  return new Promise((resolve, reject) => {
    execFile('mdfind', ['-name', name], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`Spotlight search failed: ${err.message.split('\n')[0]}`)); else resolve(String(stdout).split('\n').filter(Boolean));
    });
  });
}

// The one path whose name, size and modified time all match, else null (none, or ambiguous).
async function locateOne({ name, size, lastModified }, { search = spotlight, statImpl = p => fs.statSync(p) } = {}) {
  if (typeof name !== 'string' || !name || name.includes('/') || !Number.isFinite(size) || !Number.isFinite(lastModified)) return null;
  const matches = [];
  for (const p of await search(name)) {
    if (path.basename(p) !== name) continue;
    let st;
    try { st = statImpl(p); } catch { continue; }
    if (st.isFile() && st.size === size && Math.abs(st.mtimeMs - lastModified) <= MTIME_TOLERANCE_MS) matches.push(p);
  }
  return matches.length === 1 ? matches[0] : null;
}

function mount(app, { uploadsRoot, search, now = () => new Date() }) {
  if (!uploadsRoot) throw new Error('file routes require an uploads directory');

  app.post('/api/files/locate', async (req, res) => {
    const files = req.body && req.body.files;
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) return res.status(400).json({ error: `send 1-${MAX_FILES} files` });
    try {
      const paths = [];
      for (const f of files) paths.push(await locateOne(f || {}, search ? { search } : {}));
      res.json({ paths });
    } catch (err) {
      console.error(`[files] locate failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(uploadsRoot, now().toISOString().slice(0, 10));
      fs.mkdir(dir, { recursive: true }, err => cb(err, dir));
    },
    filename(req, file, cb) {
      const stamp = now().toISOString().slice(11, 19).replace(/:/g, '');
      cb(null, `${stamp}-${crypto.randomBytes(3).toString('hex')}-${safeName(file.originalname)}`);
    },
  });
  const upload = multer({ storage, limits: { files: MAX_FILES, fileSize: MAX_UPLOAD_BYTES } }).array('files', MAX_FILES);

  app.post('/api/files/upload', (req, res) => {
    upload(req, res, err => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? `a file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` : err.message;
        console.error(`[files] upload failed: ${msg}`);
        return res.status(400).json({ error: msg });
      }
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'no files received' });
      res.json({ paths: req.files.map(f => f.path) });
    });
  });
}

module.exports = { mount, locateOne, safeName };
