// Durable storage for the e-ink service: atomic JSON documents and append-only
// journals. Every failure is thrown; nothing falls back to an empty state.
const path = require('path');

class StoreError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StoreError';
    this.cause = cause;
  }
}

function createStore({ dir, fs = require('fs') }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (name) => path.join(dir, name);

  // Returns `fallback` only when the document has never been written. A file
  // that exists but cannot be read or parsed is an error, never an empty state.
  function readJson(name, fallback) {
    let text;
    try {
      text = fs.readFileSync(file(name), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw new StoreError(`cannot read ${name}: ${err.message}`, err);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new StoreError(`${name} is corrupt (${err.message}); refusing to continue with an empty state`, err);
    }
  }

  function writeJson(name, value) {
    const target = file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, target);
    } catch (err) {
      throw new StoreError(`cannot write ${name}: ${err.message}`, err);
    }
  }

  function append(name, record) {
    try {
      const fd = fs.openSync(file(name), 'a', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(record) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      throw new StoreError(`cannot append to ${name}: ${err.message}`, err);
    }
  }

  function readLines(name) {
    let text;
    try {
      text = fs.readFileSync(file(name), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new StoreError(`cannot read ${name}: ${err.message}`, err);
    }
    const out = [];
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line) return;
      try {
        out.push(JSON.parse(line));
      } catch (err) {
        // A torn final line is the only tolerated damage: the append was interrupted.
        if (i !== lines.length - 1) throw new StoreError(`${name} line ${i + 1} is corrupt`, err);
      }
    });
    return out;
  }

  return { dir, file, readJson, writeJson, append, readLines };
}

module.exports = { createStore, StoreError };
