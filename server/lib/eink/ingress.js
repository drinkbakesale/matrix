// Ingress rules for the e-ink API. The API is never offered on a wildcard or
// public address: the RM2 TLS listener binds one validated private address of
// this Mac, and on Matrix's main listener the API answers only connections
// that arrived on loopback (the hook, and Tailscale Serve's local proxy).
const net = require('net');
const os = require('os');

// ::ffff:a.b.c.d is treated as the IPv4 address it wraps.
function unmap(addr) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(String(addr || ''));
  return m ? m[1] : String(addr || '');
}

function classify(raw) {
  const addr = unmap(raw).replace(/^\[|\]$/g, '');
  const fam = net.isIP(addr);
  if (!fam) return { ok: false, reason: `"${raw}" is not an IP address` };
  if (fam === 4) {
    const [a, b] = addr.split('.').map(Number);
    if (addr === '0.0.0.0') return { ok: false, reason: 'the wildcard address 0.0.0.0 would listen on every interface' };
    if (a === 127) return { ok: true, addr, kind: 'loopback' };
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return { ok: true, addr, kind: 'private' };
    return { ok: false, reason: `${addr} is not a private LAN address` };
  }
  const low = addr.toLowerCase();
  if (low === '::' || /^0*(:0*)+$/.test(low)) return { ok: false, reason: 'the wildcard address :: would listen on every interface' };
  if (low === '::1') return { ok: true, addr: low, kind: 'loopback' };
  if (/^f[cd][0-9a-f]{2}:/.test(low)) return { ok: true, addr: low, kind: 'private' }; // unique local fc00::/7
  return { ok: false, reason: `${addr} is not a private (unique-local) or loopback IPv6 address` };
}

// Validates a configured bind address: private or loopback, and actually an address of this machine.
function validateBind(raw, interfaces = os.networkInterfaces()) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: false, reason: 'no bind address configured (run scripts/matrix-eink setup-tls --bind <this Mac\'s LAN address>)' };
  const c = classify(String(raw).trim());
  if (!c.ok) return c;
  const local = Object.values(interfaces).flat().some((i) => i && unmap(i.address).toLowerCase() === c.addr.toLowerCase());
  if (!local && c.kind !== 'loopback') return { ok: false, reason: `${c.addr} is not an address of this Mac` };
  return c;
}

const isLoopback = (addr) => { const c = classify(addr); return c.ok && c.kind === 'loopback'; };

module.exports = { validateBind, classify, isLoopback, unmap };
