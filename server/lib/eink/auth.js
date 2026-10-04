// Scoped pairing capabilities for the e-ink service. Tokens are random, stored
// only as SHA-256 hashes, revocable, and carried only in the Authorization
// header (never in URLs). They are not Mac login credentials.
const crypto = require('crypto');

const SCOPES = ['device', 'controller', 'hook'];
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createAuth({ store, now = () => Date.now() }) {
  const load = () => store.readJson('tokens.json', { tokens: [], codes: [] });
  const save = (doc) => store.writeJson('tokens.json', doc);

  function issueToken(scope, { label = '', ttlMs = null } = {}) {
    if (!SCOPES.includes(scope)) throw new Error(`unknown scope ${scope}`);
    const token = `mx_${scope}_${crypto.randomBytes(32).toString('base64url')}`;
    const doc = load();
    const id = crypto.randomBytes(6).toString('hex');
    doc.tokens.push({ id, scope, label, hash: sha(token), created_at: now(), expires_at: ttlMs ? now() + ttlMs : null, revoked: false });
    save(doc);
    return { id, token, scope };
  }

  // A short single-use code typed into the control page; it is exchanged for a
  // controller token so the long-lived secret never travels in a URL.
  function issuePairCode(scope = 'controller') {
    if (!SCOPES.includes(scope)) throw new Error(`unknown scope ${scope}`);
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    const doc = load();
    doc.codes = doc.codes.filter((c) => c.expires_at > now() && !c.used);
    doc.codes.push({ hash: sha(code), scope, expires_at: now() + PAIR_CODE_TTL_MS, used: false });
    save(doc);
    return { code, expires_at: now() + PAIR_CODE_TTL_MS };
  }

  function redeemPairCode(code, label) {
    const doc = load();
    const entry = doc.codes.find((c) => c.hash === sha(String(code || '').trim().toUpperCase()));
    if (!entry) return { error: 'unknown pairing code' };
    if (entry.used) return { error: 'pairing code already used' };
    if (entry.expires_at <= now()) return { error: 'pairing code expired' };
    entry.used = true;
    save(doc);
    return issueToken(entry.scope, { label });
  }

  function revoke(id) {
    const doc = load();
    const t = doc.tokens.find((x) => x.id === id);
    if (!t) return false;
    t.revoked = true;
    save(doc);
    return true;
  }

  function list() {
    return load().tokens.map(({ hash, ...rest }) => rest);
  }

  // Returns { scope, id } or { error, status }.
  function verify(header) {
    const m = /^Bearer ([A-Za-z0-9_\-]{20,200})$/.exec(header || '');
    if (!m) return { status: 401, error: 'missing or malformed Authorization header' };
    const h = sha(m[1]);
    let doc;
    try {
      doc = load();
    } catch (err) {
      return { status: 500, error: err.message };
    }
    const t = doc.tokens.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
    if (!t) return { status: 401, error: 'unknown token' };
    if (t.revoked) return { status: 401, error: 'token revoked' };
    if (t.expires_at && t.expires_at <= now()) return { status: 401, error: 'token expired' };
    return { scope: t.scope, id: t.id };
  }

  return { issueToken, issuePairCode, redeemPairCode, revoke, list, verify };
}

module.exports = { createAuth, SCOPES };
