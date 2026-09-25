// netlify/functions/_lib/mpesaAuth.js
//
// Verifies incoming M-Pesa callbacks came from Safaricom.
//
// Two independent checks:
//   1. IP allowlist — rejects callbacks from anywhere except Safaricom.
//   2. HTTP Basic Auth — rejects callbacks without the shared secret
//      configured on the Daraja portal.
//
// Both are OPT-IN: set env vars to enable them. When neither is set,
// a warning is logged once per cold start so you don't accidentally
// ship to production with no auth.

const SAFARICOM_IP_RANGES = [
  // Safaricom Daraja callback source ranges (2024 Q4 snapshot).
  // Verify with Safaricom before relying on these for compliance.
  '196.201.212.0/22',
  '196.201.216.0/22',
  '41.215.160.0/19',
];

const hasEnv = (k) => typeof process.env[k] === 'string' && process.env[k].length > 0;

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    '[mpesaAuth] No callback authentication configured. ' +
    'Set MPESA_ALLOWED_IPS or MPESA_CALLBACK_USER/PASS to enable.'
  );
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inRange(ip, cidr) {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(net);
  if (ipInt === null || netInt === null || !Number.isFinite(bits)) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

function getClientIp(event) {
  // Netlify puts the real client in x-nf-client-connection-ip.
  // Fall back to x-forwarded-for's first hop.
  const nf = event.headers?.['x-nf-client-connection-ip'] || event.headers?.['X-Nf-Client-Connection-Ip'];
  if (nf) return nf;
  const xff = event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'];
  if (xff) return xff.split(',')[0].trim();
  return event.requestContext?.identity?.sourceIp || '';
}

function getAllowedIps() {
  if (!hasEnv('MPESA_ALLOWED_IPS')) return null;
  return process.env.MPESA_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean);
}

function checkIp(event) {
  const allow = getAllowedIps();
  if (!allow) return { ok: true, skipped: true };

  const ip = getClientIp(event);
  if (!ip) return { ok: false, reason: 'no_client_ip' };

  const allowed = allow.some((cidr) => inRange(ip, cidr));
  return allowed ? { ok: true, ip } : { ok: false, ip, reason: 'ip_not_allowed' };
}

function checkBasicAuth(event) {
  const expectedUser = process.env.MPESA_CALLBACK_USER;
  const expectedPass = process.env.MPESA_CALLBACK_PASS;
  if (!hasEnv('MPESA_CALLBACK_USER') || !hasEnv('MPESA_CALLBACK_PASS')) {
    return { ok: true, skipped: true };
  }

  const header = event.headers?.authorization || event.headers?.Authorization;
  if (!header || !header.toLowerCase().startsWith('basic ')) {
    return { ok: false, reason: 'missing_basic_auth' };
  }

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return { ok: false, reason: 'invalid_basic_auth' };
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return { ok: false, reason: 'malformed_basic_auth' };

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  // Constant-time-ish comparison — good enough for this threat model.
  const userMatch = timingSafeEqual(user, expectedUser);
  const passMatch = timingSafeEqual(pass, expectedPass);
  return userMatch && passMatch ? { ok: true } : { ok: false, reason: 'bad_credentials' };
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

/**
 * Run all enabled checks. Returns { ok, skipped, reason, ip }.
 * Never throws.
 */
function verifyMpesaCallback(event) {
  const ipCheck = checkIp(event);
  if (!ipCheck.ok) return ipCheck;

  const authCheck = checkBasicAuth(event);
  if (!authCheck.ok) return authCheck;

  const skippedAll = ipCheck.skipped && authCheck.skipped;
  if (skippedAll) warnOnce();

  return { ok: true, skipped: skippedAll, ip: ipCheck.ip };
}

/** Built-in Safaricom ranges, exported so ops can override via env. */
function safaricomCidrs() { return SAFARICOM_IP_RANGES.slice(); }

module.exports = { verifyMpesaCallback, getClientIp, safaricomCidrs };
