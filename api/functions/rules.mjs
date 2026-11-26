// Edge Functions: the pure rules (names, plan limits, code and variable checks). index.mjs does the AWS work.

export const FUNCTIONS_DOMAIN_DEFAULT = 'dev.lyr';
export const LAMBDA_PREFIX = 'lyrfn-';
export const RUNTIME_ENTRY = '__lyrcloud/runtime.mjs';
export const RUNTIME_HANDLER = '__lyrcloud/runtime.handler';

// Compressed upload. It arrives base64 inside JSON, and API Gateway hands Lambda at most 6 MB.
export const MAX_CODE_BYTES = 4 * 1024 * 1024;
// Unzipped, well under Lambda's 250 MB.
export const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 5000;
// Lambda keeps all environment variables in 4 KB; ours go in one JSON value.
export const MAX_VARS_BYTES = 3000;
export const LOG_RETENTION_DAYS = 7;

export const FUNCTION_LIMITS = { launch: 5, scale: 50, enterprise: 500 };
export const limitFor = (plan) => FUNCTION_LIMITS[plan] ?? FUNCTION_LIMITS.launch;

// Names Lyrcloud keeps for itself or that would confuse people.
export const RESERVED_NAMES = ['www', 'api', 'app', 'admin', 'dash', 'dev', 'docs', 'dns', 'edge', 'lyr', 'lyrcloud', 'mail', 'status', 'support', 'help', 'root', 'test', 'localhost'];

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// The name's problem as a sentence, or null when it's fine. Names become <name>.dev.lyr.
export function functionNameError(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return 'Use 1–40 lowercase letters, digits and hyphens, starting and ending with a letter or digit.';
  }
  if (name.slice(2, 4) === '--') return 'Names can’t have two hyphens in the third and fourth places.';
  if (RESERVED_NAMES.includes(name)) return `“${name}” is reserved. Pick another name.`;
  return null;
}

const ENTRY_RE = /^[A-Za-z0-9_@./+-]+$/;
const MAIN_RE = /\.(m?js|cjs)$/;

// The entry file's problem, or null. `main` is a path inside the archive, such as "index.js" or "src/worker.mjs".
export function mainError(main) {
  if (typeof main !== 'string' || !main || main.length > 200) return 'Set "main" in lyrcloud.json to your entry file, such as "index.js".';
  if (!ENTRY_RE.test(main) || main.startsWith('/') || main.split('/').includes('..')) return '"main" must be a path inside your project, such as "index.js".';
  if (!MAIN_RE.test(main)) return '"main" must be a JavaScript file (.js, .mjs or .cjs).';
  return null;
}

// Checks the archive's file list ([{ name, size }]) against the limits and the entry file.
export function archiveError(entries, main) {
  if (!entries.length) return 'The upload has no files.';
  if (entries.length > MAX_FILES) return `Functions can have at most ${MAX_FILES} files.`;
  let total = 0;
  for (const item of entries) {
    if (item.name.startsWith('/') || item.name.split('/').includes('..') || item.name.includes('\\')) return `“${item.name}” isn’t a safe path.`;
    if (item.name.startsWith('__lyrcloud/')) return 'The __lyrcloud folder is kept for Lyrcloud’s runtime. Rename yours.';
    total += item.size;
  }
  if (total > MAX_UNZIPPED_BYTES) return `Functions can be at most ${MAX_UNZIPPED_BYTES / 1024 / 1024} MB unzipped.`;
  if (!entries.some((item) => item.name === main)) return `The entry file ${main} isn’t in the upload.`;
  return null;
}

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Variables are handed to fetch(request, env). Returns [cleaned, null] or [null, problem].
export function cleanVars(vars) {
  if (vars === undefined || vars === null) return [{}, null];
  if (typeof vars !== 'object' || Array.isArray(vars)) return [null, '"vars" must be an object of names and text values.'];
  const out = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!VAR_RE.test(key)) return [null, `“${key}” isn’t a valid variable name. Use letters, digits and underscores.`];
    if (typeof value !== 'string') return [null, `The value of ${key} must be text.`];
    out[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_VARS_BYTES) return [null, `Variables can take at most ${MAX_VARS_BYTES} bytes in all.`];
  return [out, null];
}

// "15m", "2h", "1d" or an ISO date -> milliseconds since the epoch; null if it can't be read.
export function parseSince(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return now - 15 * 60_000;
  const match = /^(\d{1,4})([smhd])$/.exec(String(value));
  if (match) return now - Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  if (/^\d{13}$/.test(String(value))) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : date;
}

export const lambdaName = (name) => `${LAMBDA_PREFIX}${name}`;
export const hostFor = (name, domain = FUNCTIONS_DOMAIN_DEFAULT) => `${name}.${domain}`;

// "hello.dev.lyr" -> "hello"; null for anything that isn't a single label under the domain.
export function nameFromHost(host, domain = FUNCTIONS_DOMAIN_DEFAULT) {
  const clean = String(host || '').toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
  if (!clean.endsWith(`.${domain}`)) return null;
  const name = clean.slice(0, -(domain.length + 1));
  return NAME_RE.test(name) ? name : null;
}

// The certificate is renewed when it has less than this long left (it's issued for 90 days).
export const CERT_RENEW_MS = 30 * 86_400_000;
export const certNeedsRenewal = (cert, now = Date.now()) => !cert?.arn || !cert.notAfter || Date.parse(cert.notAfter) - now < CERT_RENEW_MS;
