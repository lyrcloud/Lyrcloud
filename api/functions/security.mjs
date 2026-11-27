// Lyrcloud Application Security for Edge Functions, enforced by the router before a function runs.
//
//   lyrcloud.json "security": {
//     "rateLimits": [{ "path": "/api", "requests": 100, "per": "1m" }],   per visitor IP, fixed windows
//     "blockIps": ["203.0.113.0/24"], "allowIps": ["198.51.100.7"],     CIDR, IPv4 and IPv6
//     "waf": "block" | "log" | "off",                                    common attack patterns
//     "bots": { "mode": "challenge" | "block" | "off", "paths": ["/login"] },
//     "headers": true                                                    secure response headers
//   }
//
// The challenge is a proof of work: the page's script finds a number whose SHA-256 with a signed nonce
// starts with CHALLENGE_BITS zero bits (a fraction of a second in a browser), which plain HTTP clients
// and scrapers that don't run JavaScript can't do.
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

export const HUMAN_COOKIE = '__lyr_human';
export const HUMAN_SECONDS = 3600;
export const CHALLENGE_SECONDS = 300;
export const CHALLENGE_BITS = 14;
const PERIODS = { '10s': 10, '1m': 60, '10m': 600, '1h': 3600 };

const pathError = (value, where) => (typeof value === 'string' && value.startsWith('/') && value.length <= 200 && !/\s/.test(value) ? null : `${where} must be a path starting with /.`);

function cleanIps(list, where) {
  if (list === undefined) return [[], null];
  if (!Array.isArray(list) || list.length > 200) return [null, `${where} must be a list of up to 200 IP addresses or CIDR ranges.`];
  const out = [];
  for (const entry of list) {
    const [addr, bits, extra] = String(entry).trim().split('/');
    const family = isIP(addr);
    const max = family === 4 ? 32 : 128;
    if (!family || extra !== undefined || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= max))) return [null, `“${entry}” in ${where} isn’t an IP address or CIDR range.`];
    out.push(bits === undefined ? addr : `${addr}/${bits}`);
  }
  return [out, null];
}

// lyrcloud.json "security" -> [config, null], [null, null] when absent, or [null, problem].
export function cleanSecurity(security) {
  if (security === undefined || security === null || security === false) return [null, null];
  if (typeof security !== 'object' || Array.isArray(security)) return [null, '"security" must be an object.'];
  const rateLimits = [];
  for (const [i, rule] of (security.rateLimits ?? []).entries()) {
    const where = `security.rateLimits[${i}]`;
    if (!rule || typeof rule !== 'object') return [null, `${where} must be { "path", "requests", "per" }.`];
    const path = rule.path ?? '/';
    const problem = pathError(path, `${where}.path`);
    if (problem) return [null, problem];
    const requests = Number(rule.requests);
    if (!Number.isInteger(requests) || requests < 1 || requests > 100_000) return [null, `${where}.requests must be a whole number from 1 to 100000.`];
    const per = rule.per ?? '1m';
    if (!PERIODS[per]) return [null, `${where}.per must be one of ${Object.keys(PERIODS).join(', ')}.`];
    rateLimits.push({ path: path.replace(/\*+$/, ''), requests, seconds: PERIODS[per] });
  }
  if (rateLimits.length > 10) return [null, 'security.rateLimits can have at most 10 rules.'];
  const [blockIps, blockProblem] = cleanIps(security.blockIps, 'security.blockIps');
  if (blockProblem) return [null, blockProblem];
  const [allowIps, allowProblem] = cleanIps(security.allowIps, 'security.allowIps');
  if (allowProblem) return [null, allowProblem];
  const waf = security.waf ?? 'off';
  if (!['off', 'log', 'block'].includes(waf)) return [null, 'security.waf must be "off", "log" or "block".'];
  const botsIn = typeof security.bots === 'string' ? { mode: security.bots } : security.bots ?? { mode: 'off' };
  if (!['off', 'block', 'challenge'].includes(botsIn.mode)) return [null, 'security.bots.mode must be "off", "block" or "challenge".'];
  const botPaths = [];
  for (const path of botsIn.paths ?? []) {
    const problem = pathError(path, 'security.bots.paths');
    if (problem) return [null, problem];
    botPaths.push(path.replace(/\*+$/, ''));
  }
  if (security.headers !== undefined && typeof security.headers !== 'boolean') return [null, 'security.headers must be true or false.'];
  if (security.countries !== undefined) return [null, 'Country rules aren’t available yet on .dev.lyr addresses. Remove security.countries.'];
  return [{ rateLimits, blockIps, allowIps, waf, bots: { mode: botsIn.mode, paths: botPaths }, headers: security.headers === true }, null];
}

export const underPath = (prefix, path) => prefix === '/' || path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);

// ---------------------------------------------------------------- IP rules

const lists = new Map();
function blockListOf(entries) {
  const key = entries.join(',');
  if (!lists.has(key)) {
    const list = new BlockList();
    for (const entry of entries) {
      const [addr, bits] = entry.split('/');
      const type = isIP(addr) === 4 ? 'ipv4' : 'ipv6';
      if (bits === undefined) list.addAddress(addr, type);
      else list.addSubnet(addr, Number(bits), type);
    }
    if (lists.size > 500) lists.clear();
    lists.set(key, list);
  }
  return lists.get(key);
}

export function ipMatches(entries, ip) {
  if (!entries?.length || !ip) return false;
  const family = isIP(ip);
  if (!family) return false;
  return blockListOf(entries).check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

// ---------------------------------------------------------------- WAF

// Deliberately narrow patterns: clear attack signatures, not anything that merely looks unusual.
export const WAF_RULES = [
  ['path-traversal', /(?:\.\.[/\\])|(?:[/\\]\.\.(?:$|[/\\?\s]))/m],
  ['sensitive-file', /\/(?:etc\/(?:passwd|shadow)|proc\/self\/environ|\.git\/(?:config|HEAD)|\.env(?:$|[?.\s]))/im],
  ['sql-injection', /\bunion\b[\s\S]{0,40}\bselect\b|\bor\b\s+['"]?(\d+)['"]?\s*=\s*['"]?\1\b|;\s*(?:drop|truncate)\s+table\b|\b(?:sleep|pg_sleep)\s*\(\s*\d+\s*\)|\bbenchmark\s*\(|\binformation_schema\b|'\s*or\s*'[^']*'\s*=\s*'/i],
  ['xss', /<\s*script\b|javascript\s*:|\bon(?:error|load|mouseover|focus)\s*=|<\s*iframe\b|<\s*svg[^>]*\bon\w+\s*=/i],
  ['log4shell', /\$\{\s*(?:jndi|lower|upper|env|sys)\s*:/i],
  ['command-injection', /(?:;|\||&&|`|\$\()\s*(?:cat|ls|id|whoami|uname|wget|curl|nc|bash|sh)\b(?:\s|$)/i],
];

function decodeAll(text) {
  let current = String(text || '');
  for (let i = 0; i < 3; i += 1) {
    let next;
    try {
      next = decodeURIComponent(current.replace(/\+/g, ' '));
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

// The first rule a request trips, or null. Looks at the path, query and small text bodies.
export function wafMatch(event) {
  const parts = [event.rawPath || '', event.rawQueryString || ''];
  const type = String(event.headers?.['content-type'] || '');
  if (event.body && /json|x-www-form-urlencoded|text\//.test(type)) {
    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : String(event.body);
    if (body.length <= 65_536) parts.push(body);
  }
  const text = parts.map(decodeAll).join('\n');
  for (const [name, pattern] of WAF_RULES) if (pattern.test(text)) return name;
  return null;
}

// ---------------------------------------------------------------- bots

const AUTOMATION_UA = /curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|scrapy|go-http-client|java\/|okhttp|libwww|httpclient|node-fetch|axios\/|headlesschrome|phantomjs|selenium|puppeteer|playwright|masscan|nikto|sqlmap|zgrab|nmap/i;
export const looksAutomated = (userAgent) => !userAgent || AUTOMATION_UA.test(userAgent);

export function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export const solves = (nonce, answer, bits = CHALLENGE_BITS) => typeof answer === 'string' && answer.length < 40
  && leadingZeroBits(createHash('sha256').update(`${nonce}:${answer}`).digest()) >= bits;

// The challenge page: solves the proof of work in the browser, then continues to the original path.
export function challengePage(token, nonce, returnPath, bits = CHALLENGE_BITS) {
  const data = JSON.stringify({ token, nonce, bits, ret: returnPath }).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Checking your browser</title>
<body style="font-family:system-ui,sans-serif;max-width:30rem;margin:20vh auto;padding:0 1rem;line-height:1.5;text-align:center">
<h1>Checking your browser…</h1><p id="s">This takes a moment. It protects this site from automated traffic.</p>
<noscript><p>Please turn on JavaScript to continue.</p></noscript>
<script>
(async () => {
  const c = ${data};
  const enc = new TextEncoder();
  const zeros = (b) => { let n = 0; for (const x of new Uint8Array(b)) { if (x === 0) { n += 8; continue; } return n + Math.clz32(x) - 24; } return n; };
  for (let i = 0; i < 5e6; i += 1) {
    const h = await crypto.subtle.digest('SHA-256', enc.encode(c.nonce + ':' + i));
    if (zeros(h) >= c.bits) {
      location.replace('/__lyrcloud/challenge?token=' + encodeURIComponent(c.token) + '&answer=' + i);
      return;
    }
  }
  document.getElementById('s').textContent = 'Couldn’t finish the check. Reload to try again.';
})();
</script></body>`;
}

// ---------------------------------------------------------------- response headers

export const SECURE_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

export function withSecureHeaders(result) {
  const headers = { ...(result.headers || {}) };
  const present = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(SECURE_HEADERS)) if (!present.has(name)) headers[name] = value;
  return { ...result, headers };
}
