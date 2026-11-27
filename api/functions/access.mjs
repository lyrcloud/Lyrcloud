// Lyrcloud Access (Zero Trust) for Edge Functions: put a function, or some of its paths, behind Lyrcloud
// sign-in with an allow-list of emails and email domains.
//
//   lyrcloud.json  "access": { "allow": ["ada@example.com", "@example.com"], "paths": ["/admin"] }
//
// The flow, with three kinds of signed token (HMAC with the platform secret, one key per kind):
//   1. router: no valid session on a protected path -> 302 to www.lyrcloud.com/access/?to=<request token>
//      (request token: which function and path, 15 minutes)
//   2. that page signs the visitor in and POSTs /access/grant; the API checks their email against the
//      allow-list, logs the decision, and answers with https://<name>.dev.lyr/__lyrcloud/access?ticket=…
//      (ticket: function, email, 2 minutes, used once)
//   3. router swaps the ticket for an HttpOnly session cookie on that host (session: 8 hours) and passes
//      the email to the function as the lyr-access-email header.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__lyr_access';
export const SESSION_SECONDS = 8 * 3600;
export const TICKET_SECONDS = 120;
export const REQUEST_SECONDS = 15 * 60;
export const ACCESS_HEADER = 'lyr-access-email';
export const MAX_ALLOW = 200;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// lyrcloud.json "access" -> [{ allow, paths }, null] (or [null, null] when absent), or [null, problem].
export function cleanAccess(access) {
  if (access === undefined || access === null || access === false) return [null, null];
  if (typeof access !== 'object' || Array.isArray(access)) return [null, '"access" must be { "allow": [...], "paths"?: [...] }.'];
  const allow = [];
  for (const entry of access.allow ?? []) {
    const value = String(entry).trim().toLowerCase();
    if (!EMAIL_RE.test(value) && !DOMAIN_RE.test(value)) return [null, `“${entry}” in access.allow isn’t an email address or an @domain.`];
    if (!allow.includes(value)) allow.push(value);
  }
  if (allow.length > MAX_ALLOW) return [null, `access.allow can have at most ${MAX_ALLOW} entries.`];
  const paths = [];
  for (const entry of access.paths ?? []) {
    const value = String(entry);
    if (!value.startsWith('/') || value.length > 200 || /\s/.test(value)) return [null, `“${entry}” in access.paths must be a path starting with /.`];
    paths.push(value.replace(/\*+$/, ''));
  }
  if (paths.length > 50) return [null, 'access.paths can have at most 50 entries.'];
  return [{ allow, paths }, null];
}

// Whether `path` needs a signed-in visitor: every path when "paths" is empty, otherwise paths under them.
export function isProtected(policy, path) {
  if (!policy) return false;
  if (!policy.paths?.length) return true;
  return policy.paths.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || (prefix.endsWith('/') && path === prefix.slice(0, -1)));
}

// The owner is always let in, then exact emails, then @domains.
export function isAllowed(policy, email, ownerEmail) {
  const who = String(email || '').toLowerCase();
  if (!who || !EMAIL_RE.test(who)) return false;
  if (ownerEmail && who === String(ownerEmail).toLowerCase()) return true;
  return (policy?.allow || []).some((entry) => (entry.startsWith('@') ? who.endsWith(entry) : who === entry));
}

// ---------------------------------------------------------------- signed tokens

const b64 = (value) => Buffer.from(value).toString('base64url');
const mac = (secret, kind, body) => createHmac('sha256', secret).update(`lyr-access:${kind}:${body}`).digest();

export function sign(secret, kind, payload, seconds, now = Date.now()) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + seconds }));
  return `${body}.${b64(mac(secret, kind, body))}`;
}

// The payload, or null when the signature, kind or expiry is wrong.
export function verify(secret, kind, token, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = mac(secret, kind, body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  return payload.exp > Math.floor(now / 1000) ? payload : null;
}

export const newNonce = () => randomBytes(12).toString('base64url');

// "a=1; __lyr_access=xyz" or ["a=1", "__lyr_access=xyz"] -> "xyz".
export function cookieValue(cookies, name = SESSION_COOKIE) {
  const list = Array.isArray(cookies) ? cookies : String(cookies || '').split(';');
  for (const part of list) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

// A return path we're willing to send someone back to on the function's own host.
export const safeReturn = (path) => (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') && path.length < 2000 ? path : '/');
