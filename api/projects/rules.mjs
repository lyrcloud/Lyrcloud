// Rules for Lyrcloud Projects: names, git URLs, build settings and plan limits. No AWS calls here.

export const SITES_DOMAIN_DEFAULT = 'lyrcloud.app';

// Projects and builds a day per account plan (plans live on the profile row, see api/account/roles.mjs).
export const PLAN_LIMITS = {
  launch: { projects: 3, buildsPerDay: 20 },
  scale: { projects: 25, buildsPerDay: 100 },
  enterprise: { projects: 100, buildsPerDay: 500 },
};
export const limitsFor = (plan) => PLAN_LIMITS[plan] || PLAN_LIMITS.launch;

// What a published site may weigh.
export const MAX_SITE_BYTES = 250 * 1024 * 1024;
export const MAX_SITE_FILES = 20_000;
export const BUILD_TIMEOUT_MINUTES = 15;
// Older successful deployments kept (besides the live one) so a rollback stays possible.
export const KEEP_DEPLOYMENTS = 3;

// Subdomains nobody may claim, so user sites can't pose as Lyrcloud.
const RESERVED = new Set([
  'www', 'api', 'app', 'apps', 'admin', 'dash', 'dashboard', 'console', 'login', 'signin', 'sign-in', 'signup', 'sign-up',
  'auth', 'account', 'accounts', 'billing', 'pay', 'payment', 'payments', 'mail', 'email', 'smtp', 'imap', 'status', 'docs',
  'help', 'support', 'blog', 'news', 'cdn', 'static', 'assets', 'media', 'img', 'images', 'files', 'download', 'downloads',
  'lyrcloud', 'lyrshop', 'lyrsoft', 'lyrtrip', 'lyrbot', 'official', 'security', 'secure', 'verify', 'verification', 'root',
  'system', 'internal', 'test', 'staging', 'preview', 'dev', 'ns1', 'ns2', 'mx', 'ftp', 'git', 'github', 'gitlab', 'bitbucket',
  'google', 'apple', 'microsoft', 'amazon', 'aws', 'paypal', 'stripe', 'bank', 'wallet',
]);

// "My Cool Site!" → "my-cool-site". Subdomain labels: a-z, 0-9 and inner hyphens, 3 to 40 long.
export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export function projectNameError(name) {
  if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(name)) {
    return 'Use 3 to 40 lower-case letters, numbers and hyphens, starting and ending with a letter or number.';
  }
  if (name.includes('--')) return 'Don’t use two hyphens in a row.';
  if (RESERVED.has(name)) return 'That name is reserved. Pick another.';
  return null;
}

const HOSTS = { 'github.com': 'github', 'gitlab.com': 'gitlab', 'bitbucket.org': 'bitbucket', 'codeberg.org': 'codeberg' };

// Accepts https clone or browser URLs ("https://github.com/o/r", ".../r.git", ".../o/r/tree/main") and
// "git@github.com:o/r.git". Returns { host, provider, owner, repo, cloneUrl, webUrl, branch } or null.
// Only public https URLs are cloned; private hosts need the GitHub connection.
export function parseGitUrl(input) {
  let text = String(input || '').trim();
  const ssh = text.match(/^git@([^:]+):(.+)$/);
  if (ssh) text = `https://${ssh[1]}/${ssh[2]}`;
  if (!/^https:\/\//i.test(text)) text = text.includes('.') && !text.includes('://') ? `https://${text}` : text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  // No internal or bare-IP hosts: builds run with internet access only.
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.endsWith('.internal') || host.endsWith('.local') || host === 'localhost') return null;

  const parts = url.pathname.split('/').filter(Boolean);
  const provider = HOSTS[host] || 'git';
  let owner;
  let repo;
  let branch = null;
  if (provider === 'git') {
    if (!parts.length) return null;
    repo = parts.at(-1).replace(/\.git$/, '');
    owner = parts.slice(0, -1).join('/') || null;
  } else if (provider === 'gitlab') {
    // GitLab groups nest: /group/sub/repo, with "/-/tree/<branch>" for a browser URL.
    const dash = parts.indexOf('-');
    const repoParts = dash === -1 ? parts : parts.slice(0, dash);
    if (dash !== -1 && parts[dash + 1] === 'tree' && parts[dash + 2]) branch = decodeURIComponent(parts.slice(dash + 2).join('/'));
    if (repoParts.length < 2) return null;
    repo = repoParts.at(-1).replace(/\.git$/, '');
    owner = repoParts.slice(0, -1).join('/');
  } else {
    if (parts.length < 2) return null;
    [owner, repo] = [parts[0], parts[1].replace(/\.git$/, '')];
    const marker = provider === 'bitbucket' ? 'src' : 'tree';
    if (parts[2] === marker && parts[3]) branch = decodeURIComponent(parts.slice(3).join('/'));
  }
  const safe = /^[A-Za-z0-9._-]+$/;
  if (!repo || !safe.test(repo) || (owner && !owner.split('/').every((part) => safe.test(part)))) return null;
  const path = owner ? `${owner}/${repo}` : repo;
  return {
    host,
    provider,
    owner,
    repo,
    cloneUrl: `https://${host}/${path}.git`,
    webUrl: `https://${host}/${path}`,
    branch,
  };
}

// Build settings anyone can set. Commands run inside the isolated build, so they only need to be
// sensible text; paths must stay inside the repository.
const SETTING_FIELDS = ['branch', 'rootDir', 'installCommand', 'buildCommand', 'outputDir'];

export function settingsError(settings) {
  for (const [key, value] of Object.entries(settings || {})) {
    if (!SETTING_FIELDS.includes(key)) return `Unknown setting "${key}".`;
    if (value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > 300 || /[\0\n\r]/.test(value)) return `"${key}" must be one line of text.`;
    if (key === 'branch' && !/^[A-Za-z0-9._/-]{1,200}$/.test(value)) return 'Branch names use letters, numbers, ".", "_", "-" and "/".';
    if ((key === 'rootDir' || key === 'outputDir') && (value.startsWith('/') || value.split('/').includes('..') || !/^[A-Za-z0-9._/ -]+$/.test(value))) {
      return `"${key}" must be a folder inside the repository, like "site" or "apps/web/dist".`;
    }
  }
  return null;
}

export const cleanSettings = (settings) =>
  Object.fromEntries(SETTING_FIELDS.filter((key) => key in (settings || {})).map((key) => [key, String(settings[key] ?? '').trim() || null]));

// GitHub repository names for a copy: letters, numbers, ".", "_" and "-", up to 100.
export const repoNameError = (name) => (typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name) && !/^\.+$/.test(name) ? null : 'Repository names use letters, numbers, ".", "_" and "-".');

// Time-ordered ids, so deployments sort by creation; the counter orders ids made in the same millisecond.
let idCounter = 0;
export const newId = () => {
  idCounter = (idCounter + 1) % 1296;
  return `${Date.now().toString(36)}${idCounter.toString(36).padStart(2, '0')}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
};

// The router's value for a live site: "<projectId>/<deployId>|spa" or "|static" (see infra/cloudfront/sites-router.js).
export const routeValue = (projectId, deployId, mode) => `${projectId}/${deployId}|${mode === 'spa' ? 'spa' : 'static'}`;

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json', map: 'application/json', txt: 'text/plain; charset=utf-8',
  xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', wasm: 'application/wasm', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  webmanifest: 'application/manifest+json', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
};
export const contentTypeFor = (key) => TYPES[String(key).split('.').pop().toLowerCase()] || 'application/octet-stream';

// Every deployment has its own URLs, so the edge may keep files for good; browsers re-check HTML.
export const cacheControlFor = (key) =>
  /\.html?$/i.test(key) ? 'public, max-age=0, s-maxage=31536000, must-revalidate' : 'public, max-age=300, s-maxage=31536000';

// A site with just one page is treated as a single-page app (unknown paths serve /index.html);
// otherwise "/about" serves "/about/index.html", which publishing also creates from "about.html".
export function siteMode(keys) {
  const pages = keys.filter((key) => /\.html?$/i.test(key) && !/^404\.html?$/i.test(key));
  return pages.length <= 1 ? 'spa' : 'static';
}

export function cleanUrlCopies(keys) {
  const present = new Set(keys);
  return keys
    .filter((key) => /\.html$/i.test(key) && !/(^|\/)index\.html$/i.test(key) && !/^404\.html$/i.test(key))
    .map((key) => [key, `${key.replace(/\.html$/i, '')}/index.html`])
    .filter(([, copy]) => !present.has(copy));
}
