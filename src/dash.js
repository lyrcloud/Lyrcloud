// Lyrcloud dashboard — a dependency-free, hash-routed single-page app.
// Sign-in is real (Cognito, see src/auth.js). Websites, DNS, and settings are not backed by
// a server yet: they live in localStorage, and analytics are generated sample data (clearly
// labeled in the UI). DNS lookups and nameserver checks are real, using public DNS-over-HTTPS.
import { authFetch, CLOUD_API_BASE, DOMAINS_API_BASE, PROJECTS_API_BASE, redirectToLogin, SITES_DOMAIN } from './auth.js';
import { worldMapSvg } from './cloud-map.js';
import { clusterEstimate, NODE_TYPES, serviceEstimate, SERVICE_SIZES } from './cloud-pricing.js';
import { CATALOG_DATE, CONTINENT_NAMES, continentOf, findRegion, PROVIDERS, REGIONS } from './clouds.js';
import { avatarHtml, cacheProfile, imageFileToAvatar } from './avatar.js';
import { logo } from './logo.js';
import { endSession, getSession } from './session.js';

const STORE_KEY = 'lyrcloud.dash.v1';
const app = document.getElementById('app');

const session = getSession();
if (!session) {
  redirectToLogin(location.pathname + location.hash);
  await new Promise(() => {}); // halt the module while the redirect happens
}

// ------------------------------------------------------------------ helpers

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const hashString = (text) => {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
};

const seededRandom = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const formatBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index += 1;
  }
  return `${bytes.toFixed(bytes < 10 ? 1 : 0)} ${units[index]}`;
};
const PROVIDER_LABELS = { GoogleOIDC: 'Google', GitHubBridge: 'GitHub', Cognito: 'Email and password' };
const formatDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let toastTimer;
function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

// Two-tap confirmation on the button itself. window.confirm() is blocked or auto-cancelled in many
// mobile and in-app browsers, which made confirmed actions (like the super admin's role buttons)
// silently do nothing. The first tap arms the button and explains; a second tap within 5 s proceeds.
function confirmed(target, message) {
  if (target.dataset.confirming === '1') {
    clearTimeout(Number(target.dataset.confirmTimer));
    delete target.dataset.confirming;
    return true;
  }
  const label = target.textContent;
  target.dataset.confirming = '1';
  target.classList.add('is-confirming');
  target.textContent = 'Tap again to confirm';
  toast(message);
  target.dataset.confirmTimer = String(setTimeout(() => {
    delete target.dataset.confirming;
    target.classList.remove('is-confirming');
    target.textContent = label;
  }, 5000));
  return false;
}

// ------------------------------------------------------------------ state

const NAMESERVER_NAMES = ['ada', 'bea', 'cruz', 'dax', 'eli', 'fay', 'gus', 'ivy', 'kai', 'leo', 'max', 'nia', 'oz', 'rae', 'sol', 'zed'];

const nameserversFor = (domain) => {
  const hash = hashString(domain);
  const first = NAMESERVER_NAMES[hash % NAMESERVER_NAMES.length];
  const second = NAMESERVER_NAMES[(hash >>> 8) % NAMESERVER_NAMES.length];
  return [`${first}.ns.lyrcloud.com`, `${second === first ? 'zed' : second}.ns.lyrcloud.com`];
};

const defaultWafRules = () => [
  { id: uid(), name: 'Block known bad paths', expression: 'http.request.uri.path contains "/wp-admin"', action: 'block', enabled: true },
];

function createZone(name, plan, records = []) {
  return {
    id: uid(),
    name,
    plan,
    status: 'pending',
    createdAt: new Date().toISOString(),
    nameservers: nameserversFor(name),
    dns: records,
    ssl: { mode: 'full', alwaysHttps: true, minTls: '1.2', hsts: false },
    security: { underAttack: false, botFight: true, managedWaf: plan !== 'launch', rules: defaultWafRules() },
    caching: { level: 'standard', browserTtl: '4h', devMode: false, lastPurge: null },
  };
}

const sampleWorkerCode = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    return new Response(JSON.stringify({
      message: 'Hello from the Lyrcloud edge!',
      path: url.pathname,
      time: new Date().toISOString(),
    }, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
`;

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    if (stored && stored.owner === session.email) return stored;
  } catch {}
  return { owner: session.email, plan: 'launch', zones: [], workers: [] };
}

const state = loadState();
const save = () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {}
};

const findZone = (name) => state.zones.find((zone) => zone.name === name);
const findWorker = (id) => state.workers.find((worker) => worker.id === id);

// ------------------------------------------------------------------ DNS over HTTPS

async function dohQuery(name, type) {
  const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`);
  if (!response.ok) throw new Error(`DNS lookup failed (${response.status})`);
  const data = await response.json();
  return data.Answer || [];
}

const TYPE_CODES = { 1: 'A', 5: 'CNAME', 15: 'MX', 16: 'TXT', 28: 'AAAA', 2: 'NS' };

async function scanRecords(domain) {
  const lookups = [
    [domain, 'A'], [domain, 'AAAA'], [domain, 'MX'], [domain, 'TXT'],
    [`www.${domain}`, 'CNAME'], [`www.${domain}`, 'A'],
  ];
  const results = await Promise.allSettled(lookups.map(([name, type]) => dohQuery(name, type)));
  const records = [];
  const seen = new Set();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const answer of result.value) {
      const type = TYPE_CODES[answer.type];
      if (!type || type === 'NS') continue;
      const name = answer.name.replace(/\.$/, '');
      // A CNAME chain also returns the target's A records under the target name; keep only this zone.
      if (name !== domain && !name.endsWith(`.${domain}`)) continue;
      const content = answer.data.replace(/\.$/, '').replace(/^"|"$/g, '');
      const key = `${type}|${name}|${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ id: uid(), type, name, content, ttl: 'auto', proxied: ['A', 'AAAA', 'CNAME'].includes(type) });
    }
  }
  return records;
}

// ------------------------------------------------------------------ sample analytics

const RANGES = { '24h': { points: 24, stepHours: 1 }, '7d': { points: 28, stepHours: 6 }, '30d': { points: 30, stepHours: 24 } };

function sampleSeries(zoneName, range) {
  const { points, stepHours } = RANGES[range];
  const random = seededRandom(hashString(`${zoneName}:${range}`));
  const base = 800 + (hashString(zoneName) % 4000);
  const now = Date.now();
  const rows = [];
  for (let index = 0; index < points; index += 1) {
    const time = new Date(now - (points - 1 - index) * stepHours * 3600_000);
    const daily = stepHours < 24 ? 0.65 + 0.35 * Math.sin(((time.getHours() - 8) / 24) * Math.PI * 2) : 1;
    const requests = Math.round(base * stepHours * daily * (0.8 + random() * 0.4));
    const cached = Math.round(requests * (0.82 + random() * 0.14));
    rows.push({
      time,
      requests,
      cached,
      bandwidth: requests * (18_000 + random() * 9_000),
      threats: Math.round(requests * (0.004 + random() * 0.012) * (random() > 0.93 ? 8 : 1)),
    });
  }
  return { rows, stepHours };
}

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

function areaChart({ id, rows, key, label, format, stepHours }) {
  const width = 640;
  const height = 180;
  const pad = { top: 10, right: 8, bottom: 22, left: 8 };
  const max = Math.max(...rows.map((row) => row[key])) * 1.1 || 1;
  const x = (index) => pad.left + (index / (rows.length - 1)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
  const line = rows.map((row, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join('');
  const area = `${line}L${x(rows.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const tickFormat = stepHours < 24 ? { hour: 'numeric' } : { month: 'short', day: 'numeric' };
  const ticks = [0, Math.floor(rows.length / 2), rows.length - 1]
    .map((index) => `<text x="${x(index)}" y="${height - 4}" text-anchor="${index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'}">${rows[index].time.toLocaleString(undefined, tickFormat)}</text>`)
    .join('');
  const grid = [0.25, 0.5, 0.75].map((fraction) => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(max * fraction)}" y2="${y(max * fraction)}" />`).join('');
  const points = rows.map((row) => ({ t: row.time.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), v: format(row[key]) }));

  return `
    <figure class="chart" data-chart="${id}" data-points='${esc(JSON.stringify(points))}'>
      <figcaption><span>${label}</span><strong>${format(sum(rows, key))}</strong></figcaption>
      <div class="chart-plot">
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)} over time">
          <g class="chart-grid">${grid}</g>
          <path class="chart-area" d="${area}" />
          <path class="chart-line" d="${line}" />
          <line class="chart-cursor" x1="0" x2="0" y1="${pad.top}" y2="${y(0)}" />
          <g class="chart-ticks">${ticks}</g>
        </svg>
        <div class="chart-tooltip" hidden></div>
      </div>
    </figure>`;
}

function bindCharts() {
  for (const figure of app.querySelectorAll('[data-chart]')) {
    const points = JSON.parse(figure.dataset.points);
    const plot = figure.querySelector('.chart-plot');
    const svg = plot.querySelector('svg');
    const cursor = svg.querySelector('.chart-cursor');
    const tooltip = plot.querySelector('.chart-tooltip');
    plot.addEventListener('pointermove', (event) => {
      const box = svg.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const index = Math.round(ratio * (points.length - 1));
      const xView = 8 + (index / (points.length - 1)) * (640 - 16);
      cursor.setAttribute('x1', xView);
      cursor.setAttribute('x2', xView);
      cursor.style.opacity = 1;
      tooltip.hidden = false;
      tooltip.innerHTML = `<span>${esc(points[index].t)}</span><b>${esc(points[index].v)}</b>`;
      const left = (xView / 640) * box.width;
      tooltip.style.left = `${Math.min(box.width - tooltip.offsetWidth, Math.max(0, left - tooltip.offsetWidth / 2))}px`;
    });
    plot.addEventListener('pointerleave', () => {
      cursor.style.opacity = 0;
      tooltip.hidden = true;
    });
  }
}

// ------------------------------------------------------------------ shell

const icons = {
  home: '⌂', sites: '◎', workers: '{}', projects: '⇪', settings: '⚙', overview: '▤', analytics: '📈',
  dns: '☍', ssl: '🔒', security: '🛡', caching: '⚡', add: '+', users: '👥', plans: '★', domains: '🌐', cloud: '☁',
};

const ROLE_LABELS = { superadmin: 'Super admin', admin: 'Admin', user: 'User' };
const isStaff = (role) => role === 'admin' || role === 'superadmin';
// Mirrors canManage() in api/account/roles.mjs; the API enforces it.
const canManage = (actorRole, targetRole) =>
  targetRole === 'user' ? isStaff(actorRole) : targetRole === 'admin' ? actorRole === 'superadmin' : false;

const PLAN_INFO = {
  launch: { name: 'Launch', price: '$0', blurb: 'CDN, TLS and DDoS protection for every site.', features: ['Global CDN', 'Free TLS certificates', 'Unmetered DDoS protection', '5 custom firewall rules'] },
  scale: { name: 'Scale', price: '$29/mo', blurb: 'Adds the managed WAF and image optimization.', features: ['Everything in Launch', 'Managed WAF rules', 'Image optimization', 'Priority email support'] },
  enterprise: { name: 'Enterprise', price: 'Custom', blurb: 'SLAs, bot management and dedicated support.', features: ['Everything in Scale', '100% uptime SLA', 'Advanced bot management', 'Dedicated support engineer'] },
};
const PLAN_IDS = Object.keys(PLAN_INFO);
const planName = (plan) => PLAN_INFO[plan]?.name || plan;
const planSelect = (action, current, extra = '') =>
  `<select data-action="${action}"${extra}>${PLAN_IDS.map((id) => `<option value="${id}"${id === current ? ' selected' : ''}>${planName(id)}</option>`).join('')}</select>`;

function sidebar(route) {
  const accountLinks = [
    ['#/', 'Account home', icons.home, route.view === 'home'],
    ['#/add-site', 'Add a site', icons.add, route.view === 'add-site'],
    ...(DOMAINS_ENABLED ? [['#/domains', 'Domains', icons.domains, isDomainView(route.view)]] : []),
    ...(CLOUD_ENABLED ? [['#/cloud', 'Cloud', icons.cloud, isCloudView(route.view)]] : []),
    ...(PROJECTS_ENABLED ? [['#/projects', 'Projects', icons.projects, route.view.startsWith('project')]] : []),
    ['#/workers', 'Edge Functions', icons.workers, route.view.startsWith('worker')],
    ['#/settings', 'Account settings', icons.settings, route.view === 'settings'],
  ];
  accountLinks.splice(3, 0, ['#/plans', 'Plans', icons.plans, route.view === 'plans']);
  if (isStaff(profile?.role)) accountLinks.push(['#/admin', 'Admin console', icons.users, route.view === 'admin' || route.view === 'users']);
  const zone = route.zone && findZone(route.zone);
  const zoneLinks = zone
    ? [
        ['overview', 'Overview', icons.overview],
        ['analytics', 'Analytics', icons.analytics],
        ['dns', 'DNS', icons.dns],
        ['ssl', 'SSL/TLS', icons.ssl],
        ['security', 'Security', icons.security],
        ['caching', 'Caching', icons.caching],
      ].map(([tab, label, icon]) => [`#/zones/${encodeURIComponent(zone.name)}/${tab}`, label, icon, route.tab === tab])
    : [];

  const link = ([href, label, icon, active]) =>
    `<a href="${href}"${active ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</a>`;

  return `
    <aside class="dash-sidebar">
      <a class="brand" href="/" aria-label="Lyrcloud home">${logo('dash')}</a>
      <nav aria-label="Dashboard">
        ${accountLinks.map(link).join('')}
        ${zone ? `<p class="nav-label">${esc(zone.name)}</p>${zoneLinks.map(link).join('')}` : ''}
      </nav>
      <a class="sidebar-docs" href="/developers/">Docs ↗</a>
    </aside>`;
}

function topbar(route) {
  const options = state.zones
    .map((zone) => `<option value="${esc(zone.name)}"${zone.name === route.zone ? ' selected' : ''}>${esc(zone.name)}</option>`)
    .join('');
  return `
    <header class="dash-topbar">
      <button class="icon-button sidebar-toggle" data-action="toggle-sidebar" aria-label="Toggle navigation">☰</button>
      ${state.zones.length ? `<label class="zone-picker"><span class="visually-hidden">Website</span><select data-action="pick-zone"><option value="">All websites</option>${options}</select></label>` : '<span></span>'}
      <div class="topbar-right">
        <span class="preview-pill" title="No backend yet: data is stored in this browser">Preview</span>
        ${isStaff(profile?.role) ? `<a class="role-pill" href="#/admin" title="Open the admin console">${ROLE_LABELS[profile.role]} · Admin</a>` : ''}
        <a class="plan-pill" href="#/plans" title="Change plan">${esc(planName(state.plan))} plan</a>
        ${accountMenu()}
      </div>
    </header>`;
}

// Who is signed in: the API profile once loaded, the ID token's claims until then.
const me = () => profile || { name: session.name, email: session.email, picture: session.picture };

function accountMenu() {
  const person = me();
  const staff = isStaff(profile?.role);
  return `
    <div class="account-menu">
      <button class="account-button" type="button" data-action="account-menu" aria-haspopup="true" aria-expanded="false" aria-controls="account-panel" aria-label="Account menu">
        ${avatarHtml(person)}
      </button>
      <div class="account-panel" id="account-panel" hidden>
        <div class="account-who">
          ${avatarHtml(person, 'avatar large')}
          <div><b>${esc(person.name || 'Your account')}</b><small>${esc(person.email || '')}</small>${profile ? `<small>${ROLE_LABELS[profile.role] || ''} · ${esc(planName(state.plan))} plan</small>` : ''}</div>
        </div>
        <a href="#/settings">Profile and photo</a>
        <a href="#/plans">Plans</a>
        ${staff ? '<a href="#/admin">Admin console</a>' : ''}
        <a href="/">Lyrcloud home</a>
        <button class="account-signout" type="button" data-action="sign-out">Sign out</button>
      </div>
    </div>`;
}

function setAccountMenu(open) {
  const button = app.querySelector('.account-button');
  const panel = document.getElementById('account-panel');
  if (!button || !panel) return;
  button.setAttribute('aria-expanded', String(open));
  panel.hidden = !open;
}

const pageHead = (title, subtitle = '', actions = '') => `
  <div class="page-head">
    <div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </div>`;

const statusBadge = (status) =>
  status === 'active' ? '<span class="status ok">● Active</span>' : '<span class="status pending">◌ Pending nameservers</span>';

const toggle = (action, checked, label) => `
  <label class="switch"><input type="checkbox" data-action="${action}"${checked ? ' checked' : ''} /><span class="switch-track"></span><span class="visually-hidden">${label}</span></label>`;

const settingRow = (title, description, control) => `
  <div class="setting-row">
    <div><h3>${title}</h3><p>${description}</p></div>
    <div class="setting-control">${control}</div>
  </div>`;

function profilePanel() {
  const person = me();
  const source = profile?.avatarSource;
  const busy = profileSaving ? ' disabled' : '';
  const photoButtons = !profile
    ? '<p class="muted">Loading your profile…</p>'
    : `
        <label class="btn primary file-button${profileSaving ? ' is-busy' : ''}">
          ${source === 'upload' ? 'Change photo' : 'Upload photo'}
          <input type="file" accept="image/*" data-action="avatar-file"${busy} />
        </label>
        ${profile.picture && source !== 'provider' ? `<button class="btn" data-action="avatar-provider"${busy}>Use ${profile.provider === 'GitHubBridge' ? 'GitHub' : 'Google'} photo</button>` : ''}
        ${source !== 'initials' && (source === 'upload' || profile.picture) ? `<button class="btn" data-action="avatar-initials"${busy}>Remove photo</button>` : ''}`;
  return `
    <section class="panel profile-panel">
      <div class="profile-photo">
        ${avatarHtml(person, 'avatar xl')}
        <div>
          <h2>Profile photo</h2>
          <p class="muted">Shown in the dashboard and the site header. Square photos work best.</p>
          <div class="row">${photoButtons}</div>
        </div>
      </div>
      <form class="profile-name" data-form="profile-name">
        <label class="field">Display name
          <input name="name" maxlength="120" autocomplete="name" required value="${esc(person.name || '')}" placeholder="Your name"${profile ? '' : ' disabled'} />
        </label>
        <button class="btn" type="submit"${profile && !profileSaving ? '' : ' disabled'}>Save name</button>
      </form>
    </section>`;
}

// Mobile number: null shows the number (or the form to add one); 'code' asks for the texted code;
// 'edit' replaces a verified number.
let phoneStep = null;
let phoneBusy = false;

function contactPanel() {
  if (!profile) return '';
  const busy = phoneBusy ? ' disabled' : '';
  let phone;
  if (phoneStep === 'code' && profile.phonePending) {
    phone = `
      <form class="row phone-form" data-form="phone-verify">
        <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="6-digit code" aria-label="Code we texted you"${busy} />
        <button class="btn primary" type="submit"${busy}>Verify</button>
        <button class="btn" type="button" data-action="phone-edit"${busy}>Change number</button>
      </form>
      <p class="muted">We texted a code to <span class="mono">${esc(profile.phonePending)}</span>. It expires in 10 minutes.</p>`;
  } else if (profile.phoneVerified && phoneStep !== 'edit') {
    phone = `
      <div class="row"><span class="mono">${esc(profile.phone)}</span><span class="status ok">● Verified</span></div>
      <div class="row">
        <button class="btn" data-action="phone-edit">Change</button>
        <button class="btn danger" data-action="phone-remove"${busy}>Remove</button>
      </div>`;
  } else {
    phone = `
      <form class="row phone-form" data-form="phone-send">
        <input name="phone" type="tel" autocomplete="tel" required placeholder="+91 98765 43210" aria-label="Mobile number with country code"${busy} />
        <button class="btn primary" type="submit"${busy}>Text me a code</button>
        ${phoneStep === 'edit' ? '<button class="btn" type="button" data-action="phone-cancel">Cancel</button>' : ''}
      </form>
      <p class="muted">Include your country code. Standard text message rates may apply.</p>`;
  }
  return `
    <section class="panel">
      <div class="setting-row">
        <div><h3>Mobile number</h3><p>Verified by a code we text you. Used to reach you about your account.</p></div>
        <div class="setting-control phone-control">${phone}</div>
      </div>
      ${settingRow('Product update emails', 'Occasional news about Lyrcloud features. Emails about your account and security always arrive.', toggle('email-updates', profile.emailUpdates !== false, 'Product update emails'))}
    </section>`;
}

async function phoneRequest(path, options, message) {
  phoneBusy = true;
  render();
  try {
    profile = { ...profile, ...(await api(path, options)) };
    cacheProfile(profile);
    if (message) toast(message);
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  } finally {
    phoneBusy = false;
    render();
  }
}

let profileSaving = false;
async function saveProfile(changes, message) {
  profileSaving = true;
  render();
  try {
    profile = { ...profile, ...(await api('/me', { method: 'PUT', body: JSON.stringify(changes) })) };
    cacheProfile(profile);
    toast(message);
  } catch (error) {
    toast(error.message);
  }
  profileSaving = false;
  render();
}

// ------------------------------------------------------------------ views

const views = {
  home() {
    const zones = state.zones;
    return `
      ${pageHead(`Welcome back`, esc(session.email), '<a class="btn primary" href="#/add-site">+ Add a site</a>')}
      ${
        zones.length
          ? `<section class="panel">
              <div class="panel-head"><h2>Websites</h2><span class="muted">${zones.length} total</span></div>
              <div class="zone-list">
                ${zones
                  .map(
                    (zone) => `
                  <a class="zone-row" href="#/zones/${encodeURIComponent(zone.name)}/overview">
                    <span class="zone-favicon" aria-hidden="true">${esc(zone.name[0].toUpperCase())}</span>
                    <span class="zone-name"><b>${esc(zone.name)}</b><small>${esc(planName(zone.plan))} plan · ${zone.dns.length} DNS records</small></span>
                    ${statusBadge(zone.status)}
                  </a>`,
                  )
                  .join('')}
              </div>
            </section>`
          : `<section class="panel empty">
              <span class="empty-icon" aria-hidden="true">◎</span>
              <h2>Add your first website</h2>
              <p>Point your domain at Lyrcloud to get a global CDN, free TLS, and DDoS protection in minutes.</p>
              <div class="row center">
                <a class="btn primary" href="#/add-site">Add a site</a>
                <button class="btn" data-action="add-sample">Explore with a sample site</button>
              </div>
            </section>`
      }
      ${
        isStaff(profile?.role)
          ? `<a class="panel quick staff-quick" href="#/admin"><span aria-hidden="true">${icons.users}</span><h3>${ROLE_LABELS[profile.role]} console</h3><p>${profile.role === 'superadmin' ? 'Accounts, roles, plans, access and site announcements' : 'Accounts, plans and access for Lyrcloud users'}</p></a>`
          : ''
      }
      <div class="grid-3">
        <a class="panel quick" href="#/workers"><span aria-hidden="true">{}</span><h3>Edge Functions</h3><p>${state.workers.length} created · run code in 180+ cities</p></a>
        <a class="panel quick" href="/developers/#quickstart"><span aria-hidden="true">⌘</span><h3>Install the CLI</h3><p>Deploy from your terminal with <code>lyrcloud deploy</code></p></a>
        <a class="panel quick" href="#/plans"><span aria-hidden="true">${icons.plans}</span><h3>${state.plan === 'launch' ? 'Upgrade plan' : 'Your plan'}</h3><p>${esc(planName(state.plan))} · ${state.plan === 'launch' ? 'unlock the managed WAF and image optimization' : 'change plan or apply it to your sites'}</p></a>
      </div>`;
  },

  'add-site'(route) {
    const step = route.params.get('step') || 'domain';
    const domain = route.params.get('domain') || '';
    if (step === 'plan') {
      const plans = PLAN_IDS.map((id) => [id, PLAN_INFO[id].name, PLAN_INFO[id].price, PLAN_INFO[id].blurb]);
      return `
        ${pageHead('Select a plan', `for <b>${esc(domain)}</b>`)}
        <form class="panel" data-form="choose-plan">
          <input type="hidden" name="domain" value="${esc(domain)}" />
          <div class="plan-options">
            ${plans
              .map(
                ([id, name, price, text]) => `
              <label class="plan-option">
                <input type="radio" name="plan" value="${id}"${id === state.plan ? ' checked' : ''} />
                <span><b>${name}</b><strong>${price}</strong><small>${text}</small></span>
              </label>`,
              )
              .join('')}
          </div>
          <p class="muted">Billing isn’t connected in the preview, so any plan can be selected for free.</p>
          <div class="row"><a class="btn" href="#/add-site">Back</a><button class="btn primary" type="submit">Continue</button></div>
        </form>`;
    }
    return `
      ${pageHead('Add a site', 'Enter your domain. We’ll scan its existing DNS records so nothing breaks when you switch.')}
      <form class="panel" data-form="add-domain">
        <label class="field">Domain<input name="domain" placeholder="example.com" required autocomplete="off" value="${esc(domain)}" /></label>
        <p class="form-error" hidden></p>
        <div class="row"><button class="btn primary" type="submit">Continue</button></div>
      </form>`;
  },

  zone(route) {
    const zone = findZone(route.zone);
    if (!zone) return views.missing();
    return zoneViews[route.tab]?.(zone, route) ?? views.missing();
  },

  workers() {
    return `
      ${pageHead('Edge Functions', 'Serverless code that runs within milliseconds of every user.', '<button class="btn primary" data-action="new-worker">+ Create function</button>')}
      ${
        state.workers.length
          ? `<section class="panel"><table class="table">
              <thead><tr><th>Name</th><th>Routes</th><th>Last saved</th></tr></thead>
              <tbody>${state.workers
                .map(
                  (worker) => `<tr>
                    <td><a class="link" href="#/workers/${worker.id}">${esc(worker.name)}</a><div class="muted mono">${esc(worker.name)}.${esc(session.email.split('@')[0].replace(/[^a-z0-9-]/g, '') || 'team')}.lyrcloud.dev</div></td>
                    <td>${worker.routes.length ? worker.routes.map((routePattern) => `<code>${esc(routePattern)}</code>`).join('<br>') : '<span class="muted">—</span>'}</td>
                    <td>${worker.deployedAt ? formatDate(worker.deployedAt) : '<span class="muted">Draft</span>'}</td>
                  </tr>`,
                )
                .join('')}</tbody></table></section>`
          : `<section class="panel empty">
              <span class="empty-icon" aria-hidden="true">{}</span>
              <h2>Deploy your first function</h2>
              <p>Start from a template and edit it right here — preview runs in an isolated worker in your browser.</p>
              <div class="row center"><button class="btn primary" data-action="new-worker">Create function</button></div>
            </section>`
      }`;
  },

  worker(route) {
    const worker = findWorker(route.worker);
    if (!worker) return views.missing();
    const routeOptions = state.zones.map((zone) => `<option value="${esc(zone.name)}/*">${esc(zone.name)}/*</option>`).join('');
    return `
      ${pageHead(esc(worker.name), worker.deployedAt ? `Saved ${formatDate(worker.deployedAt)} · preview only, not yet on the network` : 'Draft — not saved yet', `
        <button class="btn danger" data-action="delete-worker" data-id="${worker.id}">Delete</button>
        <button class="btn primary" data-action="deploy-worker" data-id="${worker.id}">Save</button>`)}
      <div class="editor-grid">
        <section class="panel editor-panel">
          <div class="panel-head"><h2>index.js</h2><span class="muted">JavaScript module</span></div>
          <textarea class="code-editor" id="worker-code" spellcheck="false" aria-label="Function code">${esc(worker.code)}</textarea>
        </section>
        <section class="panel preview-panel">
          <div class="panel-head"><h2>Preview</h2></div>
          <form class="row" data-form="preview-worker">
            <select name="method" aria-label="Method"><option>GET</option><option>POST</option></select>
            <input name="path" value="/" aria-label="Path" />
            <button class="btn" type="submit">Send</button>
          </form>
          <pre class="preview-output" id="preview-output">Send a request to run your function.</pre>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Routes</h2></div>
        ${
          worker.routes.length
            ? `<ul class="route-list">${worker.routes.map((pattern, index) => `<li><code>${esc(pattern)}</code><button class="btn small" data-action="remove-route" data-id="${worker.id}" data-index="${index}">Remove</button></li>`).join('')}</ul>`
            : '<p class="muted">No routes. The function is reachable on its lyrcloud.dev subdomain only.</p>'
        }
        ${
          state.zones.length
            ? `<form class="row" data-form="add-route" data-id="${worker.id}"><select name="pattern" aria-label="Route">${routeOptions}</select><button class="btn" type="submit">Add route</button></form>`
            : '<p class="muted">Add a website to attach routes.</p>'
        }
      </section>`;
  },

  settings() {
    return `
      ${pageHead('Account settings')}
      ${profilePanel()}
      ${contactPanel()}
      <section class="panel">
        ${settingRow('Email', 'The address you sign in with.', `<span class="mono">${esc(session.email)}</span>`)}
        ${settingRow('Signed in with', 'Your identity provider.', '<span id="profile-provider" class="muted">Loading…</span>')}
        ${settingRow('Role', 'What you can manage in Lyrcloud.', '<span id="profile-role" class="muted">Loading…</span>')}
        ${settingRow('Member since', 'When your Lyrcloud account was created.', '<span id="profile-created" class="muted">Loading…</span>')}
        ${settingRow('Plan', 'Your account plan, used for new websites. <a href="#/plans">Compare plans</a>', planSelect('account-plan', state.plan))}
        ${settingRow('Sign out', 'End your session in this browser.', '<button class="btn" data-action="sign-out">Sign out</button>')}
        ${settingRow('Reset preview data', 'Delete all websites and functions stored in this browser.', '<button class="btn danger" data-action="reset">Reset</button>')}
      </section>`;
  },

  plans() {
    const current = state.plan;
    const cards = PLAN_IDS.map((id) => {
      const plan = PLAN_INFO[id];
      const isCurrent = id === current;
      return `
        <section class="panel plan-card${isCurrent ? ' is-current' : ''}">
          <div class="plan-card-head"><h2>${plan.name}</h2>${isCurrent ? '<span class="status ok">● Current plan</span>' : ''}</div>
          <strong class="plan-price">${plan.price}</strong>
          <p class="muted">${plan.blurb}</p>
          <ul class="plan-features">${plan.features.map((feature) => `<li>${feature}</li>`).join('')}</ul>
          ${isCurrent
            ? '<button class="btn" disabled>Your plan</button>'
            : `<button class="btn${PLAN_IDS.indexOf(id) > PLAN_IDS.indexOf(current) ? ' primary' : ''}" data-action="set-account-plan" data-plan="${id}">${PLAN_IDS.indexOf(id) > PLAN_IDS.indexOf(current) ? 'Upgrade' : 'Switch'} to ${plan.name}</button>`}
        </section>`;
    }).join('');
    return `
      ${pageHead('Plans', 'Your plan is saved to your Lyrcloud account and used for new websites.')}
      ${profileFailed ? '<p class="form-error">Couldn’t reach your account, so plan changes can’t be saved right now. Reload to try again.</p>' : ''}
      <div class="grid-3 plan-grid">${cards}</div>
      ${state.zones.length
        ? `<label class="check-row"><input type="checkbox" id="plan-apply-sites" checked /> Also switch my ${state.zones.length} existing website${state.zones.length === 1 ? '' : 's'} to the new plan</label>`
        : ''}
      <p class="muted">Billing isn’t connected yet, so every plan is free during the preview.</p>`;
  },

  users(route) {
    return views.admin(route);
  },

  projects: (route) => (PROJECTS_ENABLED ? projectsView(route) : views.missing()),
  project: (route) => (PROJECTS_ENABLED ? projectView(route) : views.missing()),
  domains: (route) => domainsView(route),
  'domain-buy': (route) => domainBuyView(route),
  domain: (route) => domainView(route),
  subdomain: (route) => subdomainView(route),
  cloud: () => cloudView(),
  'cloud-cluster': (route) => cloudClusterView(route),

  admin(route) {
    if (profileFailed) return `<section class="panel"><p class="form-error">Couldn’t load your account. Reload the page to try again.</p></section>`;
    if (!profile) return '<section class="panel"><p class="muted">Loading…</p></section>';
    if (!isStaff(profile.role)) return views.missing();
    const isSuper = profile.role === 'superadmin';
    const tab = ['overview', 'users', ...(PROJECTS_ENABLED ? ['projects'] : []), ...(DOMAINS_ENABLED ? ['domains'] : []), ...(CLOUD_ENABLED ? ['cloud'] : []), 'settings'].includes(route.params.get('tab')) ? route.params.get('tab') : 'overview';
    const tabs = [['overview', 'Overview'], ['users', `Users${adminUsers.list ? ` (${adminUsers.list.length})` : ''}`], ...(PROJECTS_ENABLED ? [['projects', 'Projects']] : []), ...(DOMAINS_ENABLED ? [['domains', 'Domains']] : []), ...(CLOUD_ENABLED ? [['cloud', 'Cloud']] : []), ['settings', 'Site settings']]
      .map(([id, label]) => `<a class="admin-tab" href="#/admin?tab=${id}"${id === tab ? ' aria-current="page"' : ''}>${label}</a>`)
      .join('');
    const body = adminUsers.error
      ? `<section class="panel"><p class="form-error">${esc(adminUsers.error)}</p><button class="btn" data-action="admin-refresh">Try again</button></section>`
      : !adminUsers.list && tab !== 'settings' && tab !== 'projects' && tab !== 'domains' && tab !== 'cloud'
        ? '<section class="panel"><p class="muted">Loading accounts…</p></section>'
        : adminTabs[tab](isSuper);
    return `
      ${pageHead(isSuper ? 'Super admin console' : 'Admin console', `${esc(profile.email || session.email)} · ${ROLE_LABELS[profile.role]}`, '<button class="btn" data-action="admin-refresh">Refresh</button>')}
      <nav class="admin-tabs" aria-label="Admin sections">${tabs}</nav>
      ${body}`;
  },

  missing() {
    return `<section class="panel empty"><h2>Not found</h2><p>That page doesn’t exist in your account.</p><a class="btn primary" href="#/">Go to account home</a></section>`;
  },
};

const zoneViews = {
  overview(zone) {
    const { rows } = sampleSeries(zone.name, '24h');
    const requests = sum(rows, 'requests');
    return `
      ${pageHead(esc(zone.name), `${statusBadge(zone.status)} · ${esc(planName(zone.plan))} plan`, `<a class="btn" href="https://${esc(zone.name)}" target="_blank" rel="noopener">Visit site ↗</a>`)}
      ${
        zone.status !== 'active'
          ? `<section class="panel callout">
              <h2>Finish setup: update your nameservers</h2>
              <p>Log in to your domain registrar and replace the current nameservers with:</p>
              <ul class="ns-list">${zone.nameservers.map((ns) => `<li><code>${ns}</code><button class="btn small" data-action="copy" data-value="${ns}">Copy</button></li>`).join('')}</ul>
              <p class="muted" id="ns-result">Changes can take up to 24 hours to propagate.</p>
              <div class="row">
                <button class="btn primary" data-action="check-ns">Check nameservers now</button>
                <button class="btn" data-action="force-active" title="Preview only">Mark active (preview)</button>
              </div>
            </section>`
          : ''
      }
      <div class="stat-grid">
        <div class="stat"><span>Requests · 24h</span><strong>${compact.format(requests)}</strong></div>
        <div class="stat"><span>Cached</span><strong>${((sum(rows, 'cached') / requests) * 100).toFixed(1)}%</strong></div>
        <div class="stat"><span>Bandwidth</span><strong>${formatBytes(sum(rows, 'bandwidth'))}</strong></div>
        <div class="stat"><span>Threats blocked</span><strong>${compact.format(sum(rows, 'threats'))}</strong></div>
      </div>
      <p class="sample-note">Sample data — real analytics appear once traffic flows through Lyrcloud.</p>
      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>Quick actions</h2></div>
          ${settingRow('Under Attack mode', 'Challenge every visitor during a DDoS attack.', toggle('under-attack', zone.security.underAttack, 'Under Attack mode'))}
          ${settingRow('Development mode', 'Bypass the cache for 3 hours while you test changes.', toggle('dev-mode', zone.caching.devMode, 'Development mode'))}
          ${settingRow('Purge cache', 'Remove every cached file from all edge locations.', '<button class="btn" data-action="purge-all">Purge everything</button>')}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Domain</h2></div>
          <dl class="facts">
            <dt>Plan</dt><dd>${planSelect('zone-plan', zone.plan, ' aria-label="Plan for this site"')}</dd>
            <dt>Nameservers</dt><dd>${zone.nameservers.map((ns) => `<code>${ns}</code>`).join('<br>')}</dd>
            <dt>SSL/TLS</dt><dd>${esc(zone.ssl.mode)}</dd>
            <dt>DNS records</dt><dd>${zone.dns.length}</dd>
            <dt>Added</dt><dd>${formatDate(zone.createdAt)}</dd>
          </dl>
          <button class="btn danger" data-action="delete-zone">Remove site from Lyrcloud</button>
        </section>
      </div>`;
  },

  analytics(zone, route) {
    const range = RANGES[route.params.get('range')] ? route.params.get('range') : '24h';
    const { rows, stepHours } = sampleSeries(zone.name, range);
    const base = `#/zones/${encodeURIComponent(zone.name)}/analytics`;
    return `
      ${pageHead('Analytics', esc(zone.name), `
        <div class="segmented" role="group" aria-label="Time range">
          ${Object.keys(RANGES).map((key) => `<a href="${base}?range=${key}"${key === range ? ' aria-current="true"' : ''}>${key}</a>`).join('')}
        </div>`)}
      <p class="sample-note">Sample data — real analytics appear once traffic flows through Lyrcloud.</p>
      <div class="grid-2">
        <section class="panel">${areaChart({ id: 'requests', rows, key: 'requests', label: 'Requests', format: compact.format, stepHours })}</section>
        <section class="panel">${areaChart({ id: 'bandwidth', rows, key: 'bandwidth', label: 'Bandwidth', format: formatBytes, stepHours })}</section>
        <section class="panel">${areaChart({ id: 'cached', rows, key: 'cached', label: 'Cached requests', format: compact.format, stepHours })}</section>
        <section class="panel">${areaChart({ id: 'threats', rows, key: 'threats', label: 'Threats blocked', format: compact.format, stepHours })}</section>
      </div>`;
  },

  dns(zone) {
    const types = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];
    // Domains bought through Lyrcloud have real DNS; send people to the records that actually resolve.
    if (zone.registered && zone.lyrcloudDns) {
      return `
        ${pageHead('DNS records', `<b>${esc(zone.name)}</b> is registered with Lyrcloud and uses live Lyrcloud DNS.`)}
        <section class="panel callout"><p>Records for this domain are live, not preview data.</p><a class="btn primary" href="#/domains/${encodeURIComponent(zone.name)}">Manage DNS records</a></section>`;
    }
    return `
      ${pageHead('DNS records', `Manage records for <b>${esc(zone.name)}</b>. Proxied records get CDN and security; DNS-only records resolve straight to your server.`)}
      <section class="panel">
        <form class="dns-form" data-form="add-record">
          <select name="type" aria-label="Type">${types.map((type) => `<option>${type}</option>`).join('')}</select>
          <input name="name" placeholder="Name (@ for root)" required aria-label="Name" />
          <input name="content" placeholder="IPv4 address, target, or value" required aria-label="Content" />
          <label class="inline-check"><input type="checkbox" name="proxied" checked /> Proxied</label>
          <button class="btn primary" type="submit">Add record</button>
        </form>
        <p class="form-error" hidden></p>
        ${
          zone.dns.length
            ? `<div class="table-scroll"><table class="table">
                <thead><tr><th>Type</th><th>Name</th><th>Content</th><th>Proxy</th><th>TTL</th><th></th></tr></thead>
                <tbody>${zone.dns
                  .map(
                    (record) => `<tr>
                      <td><span class="type-tag">${record.type}</span></td>
                      <td class="mono">${esc(record.name)}</td>
                      <td class="mono wrap">${esc(record.content)}</td>
                      <td>${['A', 'AAAA', 'CNAME'].includes(record.type) ? `<button class="proxy-toggle ${record.proxied ? 'on' : ''}" data-action="toggle-proxy" data-id="${record.id}">${record.proxied ? '☁ Proxied' : '○ DNS only'}</button>` : '<span class="muted">DNS only</span>'}</td>
                      <td>${esc(record.ttl)}</td>
                      <td><button class="btn small" data-action="delete-record" data-id="${record.id}" aria-label="Delete record">Delete</button></td>
                    </tr>`,
                  )
                  .join('')}</tbody></table></div>`
            : '<p class="muted">No DNS records yet.</p>'
        }
      </section>`;
  },

  ssl(zone) {
    const modes = [
      ['off', 'Off', 'No encryption. Not recommended.'],
      ['flexible', 'Flexible', 'Encrypts browser → Lyrcloud only.'],
      ['full', 'Full', 'End-to-end, accepts self-signed origin certificates.'],
      ['strict', 'Full (strict)', 'End-to-end with a valid origin certificate. Most secure.'],
    ];
    return `
      ${pageHead('SSL/TLS', `Encryption settings for <b>${esc(zone.name)}</b>`)}
      <section class="panel">
        <div class="panel-head"><h2>Encryption mode</h2></div>
        <div class="plan-options">
          ${modes
            .map(
              ([id, name, text]) => `
            <label class="plan-option">
              <input type="radio" name="ssl-mode" value="${id}" data-action="ssl-mode"${zone.ssl.mode === id ? ' checked' : ''} />
              <span><b>${name}</b><small>${text}</small></span>
            </label>`,
            )
            .join('')}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Edge certificates</h2><span class="status ok">● Universal certificate active</span></div>
        ${settingRow('Always use HTTPS', 'Redirect every HTTP request to HTTPS.', toggle('always-https', zone.ssl.alwaysHttps, 'Always use HTTPS'))}
        ${settingRow('HSTS', 'Tell browsers to only ever connect over HTTPS.', toggle('hsts', zone.ssl.hsts, 'HSTS'))}
        ${settingRow('Minimum TLS version', 'Reject connections using older protocol versions.', `
          <select data-action="min-tls">${['1.0', '1.1', '1.2', '1.3'].map((version) => `<option${zone.ssl.minTls === version ? ' selected' : ''}>${version}</option>`).join('')}</select>`)}
      </section>`;
  },

  security(zone) {
    const random = seededRandom(hashString(`${zone.name}:events`));
    const countries = ['US', 'DE', 'BR', 'IN', 'CN', 'RU', 'NL', 'VN'];
    const paths = ['/wp-login.php', '/.env', '/api/login', '/xmlrpc.php', '/admin', '/checkout'];
    const actions = ['Block', 'Managed challenge', 'Block', 'JS challenge'];
    const events = Array.from({ length: 8 }, (_, index) => ({
      time: new Date(Date.now() - (index * 7 + Math.floor(random() * 6)) * 60_000),
      ip: `${Math.floor(random() * 200) + 20}.${Math.floor(random() * 255)}.${Math.floor(random() * 255)}.${Math.floor(random() * 255)}`,
      country: countries[Math.floor(random() * countries.length)],
      path: paths[Math.floor(random() * paths.length)],
      action: actions[Math.floor(random() * actions.length)],
    }));
    return `
      ${pageHead('Security', `Firewall and bot protection for <b>${esc(zone.name)}</b>`)}
      <section class="panel">
        ${settingRow('Under Attack mode', 'Show an interstitial challenge to every visitor.', toggle('under-attack', zone.security.underAttack, 'Under Attack mode'))}
        ${settingRow('Bot fight mode', 'Challenge requests that match known bot patterns.', toggle('bot-fight', zone.security.botFight, 'Bot fight mode'))}
        ${settingRow('Managed WAF rules', zone.plan === 'launch' ? 'Available on Scale and Enterprise plans.' : 'OWASP core ruleset and Lyrcloud managed rules.', zone.plan === 'launch' ? '<button class="btn small" data-action="zone-upgrade">Upgrade to Scale</button>' : toggle('managed-waf', zone.security.managedWaf, 'Managed WAF rules'))}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Custom rules</h2><span class="muted">${zone.security.rules.length} of 5 used</span></div>
        <ul class="rule-list">
          ${zone.security.rules
            .map(
              (rule) => `<li>
                <div><b>${esc(rule.name)}</b><code>${esc(rule.expression)}</code></div>
                <span class="type-tag">${esc(rule.action)}</span>
                <label class="switch"><input type="checkbox" data-action="toggle-rule" data-id="${rule.id}"${rule.enabled ? ' checked' : ''} /><span class="switch-track"></span><span class="visually-hidden">Enable ${esc(rule.name)}</span></label>
                <button class="btn small" data-action="delete-rule" data-id="${rule.id}">Delete</button>
              </li>`,
            )
            .join('')}
        </ul>
        ${
          zone.security.rules.length < 5
            ? `<form class="rule-form" data-form="add-rule">
                <input name="name" placeholder="Rule name" required aria-label="Rule name" />
                <input name="expression" placeholder='ip.geo.country eq "XX"' required aria-label="Expression" class="mono" />
                <select name="action" aria-label="Action"><option value="block">block</option><option value="challenge">challenge</option><option value="allow">allow</option><option value="log">log</option></select>
                <button class="btn primary" type="submit">Add rule</button>
              </form>`
            : ''
        }
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Recent security events</h2><span class="sample-note inline">Sample data</span></div>
        <div class="table-scroll"><table class="table">
          <thead><tr><th>Time</th><th>Action</th><th>Country</th><th>IP</th><th>Path</th></tr></thead>
          <tbody>${events.map((event) => `<tr><td>${event.time.toLocaleTimeString()}</td><td>${event.action}</td><td>${event.country}</td><td class="mono">${event.ip}</td><td class="mono">${event.path}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>`;
  },

  caching(zone) {
    return `
      ${pageHead('Caching', `Cache configuration for <b>${esc(zone.name)}</b>`)}
      <section class="panel">
        <div class="panel-head"><h2>Purge cache</h2>${zone.caching.lastPurge ? `<span class="muted">Last purge ${formatDate(zone.caching.lastPurge)}</span>` : ''}</div>
        <form class="row" data-form="purge-urls">
          <input name="urls" placeholder="https://${esc(zone.name)}/styles.css" aria-label="URL to purge" class="grow" required />
          <button class="btn" type="submit">Purge URL</button>
          <button class="btn danger" type="button" data-action="purge-all">Purge everything</button>
        </form>
      </section>
      <section class="panel">
        ${settingRow('Caching level', 'How query strings affect what is cached.', `
          <select data-action="cache-level">${[['basic', 'No query string'], ['standard', 'Standard'], ['aggressive', 'Ignore query string']].map(([value, label]) => `<option value="${value}"${zone.caching.level === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`)}
        ${settingRow('Browser cache TTL', 'How long browsers keep cached resources.', `
          <select data-action="browser-ttl">${['30m', '1h', '4h', '1d', '7d', '30d'].map((ttl) => `<option${zone.caching.browserTtl === ttl ? ' selected' : ''}>${ttl}</option>`).join('')}</select>`)}
        ${settingRow('Development mode', 'Temporarily bypass the cache so changes show up immediately.', toggle('dev-mode', zone.caching.devMode, 'Development mode'))}
      </section>`;
  },
};

// ------------------------------------------------------------------ admin console

const DAY = 86_400_000;
const within = (iso, days) => Boolean(iso) && Date.now() - new Date(iso).getTime() < days * DAY;
const countBy = (list, key) => list.reduce((counts, item) => ({ ...counts, [key(item)]: (counts[key(item)] || 0) + 1 }), {});

function bars(counts, labels = {}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  return `<ul class="bars">${Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `<li><span>${esc(labels[key] || key)}</span><span class="bar" aria-hidden="true"><i style="width:${(count / total) * 100}%"></i></span><b>${count}</b></li>`)
    .join('')}</ul>`;
}

const userLabel = (user) => user.name || user.email || user.userId;

const adminTabs = {
  projects: () => adminProjectsTab(),
  overview() {
    const users = adminUsers.list;
    const stat = (label, value, href) => `<a class="stat" href="${href}"><span>${label}</span><strong>${value}</strong></a>`;
    const recent = users.slice(0, 5)
      .map((user) => `<li><b>${esc(userLabel(user))}</b> <span class="muted">${user.lastLoginAt ? formatDate(user.lastLoginAt) : '—'}</span></li>`)
      .join('');
    return `
      <div class="stat-grid">
        ${stat('Accounts', users.length, '#/admin?tab=users')}
        ${stat('Active · 7 days', users.filter((user) => within(user.lastLoginAt, 7)).length, '#/admin?tab=users')}
        ${stat('New · 7 days', users.filter((user) => within(user.createdAt, 7)).length, '#/admin?tab=users')}
        ${stat('Admins', users.filter((user) => isStaff(user.role)).length, '#/admin?tab=users')}
      </div>
      <div class="grid-2">
        <section class="panel"><div class="panel-head"><h2>Plans</h2></div>${bars(countBy(users, (user) => user.plan), Object.fromEntries(PLAN_IDS.map((id) => [id, planName(id)])))}</section>
        <section class="panel"><div class="panel-head"><h2>Sign-in methods</h2></div>${bars(countBy(users, (user) => user.provider || 'Unknown'), PROVIDER_LABELS)}</section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Recent sign-ins</h2><a href="#/admin?tab=users">All users →</a></div>
        <ul class="recent-list">${recent || '<li class="muted">No accounts yet.</li>'}</ul>
        ${users.some((user) => user.disabled) ? `<p class="muted">${users.filter((user) => user.disabled).length} disabled account(s).</p>` : ''}
      </section>`;
  },

  users(isSuper) {
    const { q, role } = adminFilter;
    const rows = adminUsers.list.filter((user) => role === 'all' || (role === 'disabled' ? user.disabled : user.role === role));
    const badge = (cls, text) => `<span class="badge ${cls}">${text}</span>`;
    const card = (user) => {
      const self = user.userId === profile.userId;
      const manageable = canManage(profile.role, user.role);
      const actions = manageable
        ? `<div class="user-actions">
            <button class="btn small" data-action="admin-edit" data-id="${esc(user.userId)}">${adminEditing === user.userId ? 'Close' : 'Edit'}</button>
            ${isSuper ? `<button class="btn small" data-action="admin-role" data-id="${esc(user.userId)}" data-role="${user.role === 'admin' ? 'user' : 'admin'}">${user.role === 'admin' ? 'Remove admin' : 'Make admin'}</button>` : ''}
            <button class="btn small${user.disabled ? '' : ' danger'}" data-action="admin-disable" data-id="${esc(user.userId)}" data-disabled="${!user.disabled}">${user.disabled ? 'Enable' : 'Disable'}</button>
            <button class="btn small" data-action="admin-sign-out" data-id="${esc(user.userId)}">Sign out everywhere</button>
            ${isSuper ? `<button class="btn small danger" data-action="admin-delete" data-id="${esc(user.userId)}">Delete</button>` : ''}
          </div>`
        : '';
      const editor = adminEditing === user.userId && manageable
        ? `<form class="user-editor" data-form="admin-edit-user" data-id="${esc(user.userId)}">
            <label>Name<input name="name" value="${esc(user.name || '')}" maxlength="120" placeholder="${esc(user.email || '')}" /></label>
            <label>Plan<select name="plan">${PLAN_IDS.map((id) => `<option value="${id}"${id === user.plan ? ' selected' : ''}>${planName(id)}</option>`).join('')}</select></label>
            <button class="btn primary" type="submit">Save</button>
          </form>`
        : '';
      return `
        <li class="user-card" data-search="${esc(`${user.name || ''} ${user.email || ''} ${user.provider || ''} ${user.role} ${user.plan}`.toLowerCase())}">
          <div class="user-main">
            <div class="user-who"><b>${esc(userLabel(user))}</b><small class="muted mono">${esc(user.email || '—')}</small></div>
            <div class="badges">
              ${badge(`role-badge role-${esc(user.role)}`, ROLE_LABELS[user.role] || esc(user.role))}
              ${badge('plan-badge', `${esc(planName(user.plan))} plan`)}
              ${badge('', esc(PROVIDER_LABELS[user.provider] || user.provider || '—'))}
              ${user.disabled ? badge('badge-danger', 'Disabled') : ''}
              ${self ? badge('', 'You') : ''}
              <small class="muted">Joined ${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'} · last sign-in ${user.lastLoginAt ? formatDate(user.lastLoginAt) : '—'}</small>
            </div>
          </div>
          ${actions}
          ${editor}
        </li>`;
    };
    return `
      <section class="panel">
        <div class="admin-toolbar">
          <input type="search" id="admin-search" placeholder="Search name, email, plan or sign-in method" value="${esc(q)}" aria-label="Search users" />
          <select data-action="admin-role-filter" aria-label="Filter users">
            ${[['all', 'Everyone'], ['superadmin', 'Super admin'], ['admin', 'Admins'], ['user', 'Users'], ['disabled', 'Disabled']]
              .map(([id, label]) => `<option value="${id}"${id === role ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        <p class="muted admin-hint">${isSuper ? 'You can manage every account except your own. Destructive actions need a second tap.' : 'You can manage regular users. Only the super admin can manage admins or delete accounts.'}</p>
        <ul class="user-list">${rows.map(card).join('') || '<li class="muted">No accounts match.</li>'}</ul>
        <p class="muted" id="admin-no-match" hidden>No accounts match your search.</p>
      </section>`;
  },

  settings(isSuper) {
    if (adminSettings.error) return `<section class="panel"><p class="form-error">${esc(adminSettings.error)}</p></section>`;
    if (!adminSettings.data) return '<section class="panel"><p class="muted">Loading settings…</p></section>';
    const { announcement, updatedAt } = adminSettings.data;
    return `
      <section class="panel">
        <div class="panel-head"><h2>Dashboard announcement</h2>${updatedAt ? `<span class="muted">Updated ${formatDate(updatedAt)}</span>` : ''}</div>
        <p class="muted">Shown at the top of every signed-in user’s dashboard. Leave empty to hide it.</p>
        <form data-form="admin-settings" class="stack">
          <textarea name="announcement" rows="3" maxlength="500"${isSuper ? '' : ' disabled'} placeholder="e.g. Scheduled maintenance on Saturday 02:00–03:00 UTC">${esc(announcement)}</textarea>
          ${isSuper ? '<div class="row"><button class="btn primary" type="submit">Save announcement</button></div>' : '<p class="muted">Only the super admin can change site settings.</p>'}
        </form>
      </section>
      ${adminUpdatesPanel(isSuper)}
      ${adminGithubAppPanel(isSuper)}
      <section class="panel">
        <div class="panel-head"><h2>Access rules</h2></div>
        <dl class="facts">
          <dt>Super admin</dt><dd>The configured owner email, signed in with Google. Can’t be changed, disabled or deleted here.</dd>
          <dt>Admins</dt><dd>See every account; manage plans, access and sessions for regular users.</dd>
          <dt>Users</dt><dd>Manage their own websites, functions and plan.</dd>
        </dl>
      </section>`;
  },
};

function adminUpdatesPanel(isSuper) {
  const data = adminUpdates.data;
  if (!data) return '';
  const sending = adminUpdates.sending;
  const history = data.updates.length
    ? `<ul class="update-list">${data.updates.map((update) => `
        <li><b>${esc(update.subject)}</b><span class="muted">${formatDate(update.sentAt)} · ${update.sent} sent${update.failed ? ` · ${update.failed} failed` : ''}</span></li>`).join('')}</ul>`
    : '<p class="muted">No updates sent yet.</p>';
  return `
    <section class="panel">
      <div class="panel-head"><h2>Email an update</h2><span class="muted">${data.recipients} subscribed</span></div>
      <p class="muted">Goes to every active account with product updates turned on. Each email has an unsubscribe link.</p>
      ${data.mailEnabled ? '' : '<p class="form-error">Email sending isn’t set up on the server yet.</p>'}
      ${isSuper
        ? `<form data-form="admin-update" class="stack">
            <label class="field">Subject<input name="subject" maxlength="150" required placeholder="e.g. Edge functions are now in beta"${sending ? ' disabled' : ''} /></label>
            <label class="field">Message<textarea name="message" rows="6" maxlength="5000" required placeholder="Plain text. Blank lines start new paragraphs; https:// links become clickable."${sending ? ' disabled' : ''}></textarea></label>
            <div class="row"><button class="btn primary" type="submit"${sending || !data.mailEnabled ? ' disabled' : ''}>${sending ? esc(sending) : `Send to ${data.recipients} account${data.recipients === 1 ? '' : 's'}`}</button></div>
          </form>`
        : '<p class="muted">Only the super admin can send updates.</p>'}
      <h3>Sent</h3>
      ${history}
    </section>`;
}

// ------------------------------------------------------------------ Lyrcloud Projects

// Import any git repository, build it and host it at <name>.lyrcloud.app (the projects API).
const projects = { data: null, error: '', loading: false, repos: null, reposError: '', detail: null, detailError: '', logs: {}, openLog: null };
const adminProjects = { list: null, error: '', loading: false };
const adminGithubApp = { data: null, error: '', loading: false };
let projectsTimer = null;

const projectsApi = (path, options) => api(path, options, PROJECTS_API_BASE);
// Projects stays hidden until its API is deployed and PROJECTS_API_BASE (src/auth.js) points at it.
const PROJECTS_ENABLED = !PROJECTS_API_BASE.endsWith('.invalid');

const DEPLOY_STATUS = {
  queued: ['pending', '◌ Queued'], building: ['pending', '◌ Building'], live: ['ok', '● Live'], ready: ['', 'Ready'],
  failed: ['bad', '✕ Failed'], expired: ['', 'Expired'], disabled: ['bad', '✕ Disabled'],
};
const deployBadge = (status) => {
  const [cls, label] = DEPLOY_STATUS[status] || ['', esc(status || '—')];
  return `<span class="status ${cls}">${label}</span>`;
};
const SOURCE_LABELS = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', codeberg: 'Codeberg', git: 'Git' };
const isWorking = (status) => status === 'queued' || status === 'building';

async function loadProjects() {
  projects.loading = true;
  try {
    projects.data = await projectsApi('/projects');
    projects.error = '';
  } catch (error) {
    projects.error = error.message;
  }
  projects.loading = false;
  if (currentRoute?.view.startsWith('project')) render();
}

async function loadProject(id) {
  try {
    projects.detail = await projectsApi(`/projects/${encodeURIComponent(id)}`);
    projects.detailError = '';
  } catch (error) {
    projects.detailError = error.message;
  }
  if (currentRoute?.view === 'project' && currentRoute.projectId === id) render();
}

async function loadRepos() {
  projects.repos = [];
  try {
    projects.repos = (await projectsApi('/projects/github/repos')).repos;
  } catch (error) {
    projects.reposError = error.message;
  }
  if (currentRoute?.view === 'projects') render();
}

// Loads what the current projects page needs, and polls while a build is running.
function projectsAfterRender(route) {
  clearTimeout(projectsTimer);
  if (!projects.data && !projects.loading && !projects.error) loadProjects();
  if (route.view === 'projects' && route.params.get('new') && projects.data?.github.connected && !projects.repos) loadRepos();
  const github = route.params.get('github');
  if (github) {
    toast(github === 'connected' ? 'GitHub connected' : 'GitHub wasn’t connected');
    history.replaceState(null, '', '#/projects');
    projects.data = null;
    loadProjects();
  }
  if (route.view === 'project') {
    if (projects.detail?.project.projectId !== route.projectId && !projects.detailError) {
      projects.detail = null;
      loadProject(route.projectId);
      return;
    }
    if (projects.detail?.deployments.some((item) => isWorking(item.status))) {
      projectsTimer = setTimeout(() => currentRoute?.projectId === route.projectId && loadProject(route.projectId), 4000);
    }
  } else if (projects.data?.projects.some((item) => isWorking(item.status))) {
    projectsTimer = setTimeout(() => currentRoute?.view === 'projects' && loadProjects(), 5000);
  }
}

function githubPanel(github) {
  if (!github.available) return '';
  return github.connected
    ? `<section class="panel github-panel">
        <div><h3>GitHub connected</h3><p class="muted">Signed in as <b>@${esc(github.login)}</b>${github.repositorySelection === 'selected' ? ' · access to selected repositories' : ''}. Pushes to linked repositories deploy automatically.</p></div>
        <div class="row"><button class="btn" data-action="github-connect">Change access</button><button class="btn" data-action="github-disconnect">Disconnect</button></div>
      </section>`
    : `<section class="panel github-panel">
        <div><h3>Connect GitHub</h3><p class="muted">Import your private repositories, copy or fork projects into your account, and redeploy on every push.</p></div>
        <button class="btn primary" data-action="github-connect">Connect GitHub</button>
      </section>`;
}

function importView() {
  const { github, domain, limits } = projects.data;
  const atLimit = limits.used >= limits.projects;
  const repoOptions = !github.connected ? '' : projects.repos === null || (!projects.repos.length && !projects.reposError)
    ? '<option value="">Loading your repositories…</option>'
    : projects.repos.length
      ? projects.repos.map((repo) => `<option value="${esc(repo.fullName)}" data-branch="${esc(repo.defaultBranch)}">${esc(repo.fullName)}${repo.private ? ' 🔒' : ''}</option>`).join('')
      : `<option value="">${esc(projects.reposError || 'No repositories shared with Lyrcloud yet')}</option>`;
  const needsGithub = github.connected ? '' : ' disabled';
  return `
    ${pageHead('Import a project', 'From GitHub, GitLab, Bitbucket or any public git URL.', '<a class="btn" href="#/projects">Cancel</a>')}
    ${atLimit ? `<p class="form-error">You’re using all ${limits.projects} projects on your plan. <a href="#/plans">Upgrade</a> or delete a project first.</p>` : ''}
    <form class="panel import-form" data-form="project-import" data-kind="url" data-mode="deploy">
      <fieldset class="choice-row">
        <legend>Source</legend>
        <label class="choice"><input type="radio" name="kind" value="url" checked data-action="import-kind" /> <span><b>Git URL</b><small>Any public repository</small></span></label>
        <label class="choice"><input type="radio" name="kind" value="repo" data-action="import-kind"${needsGithub} /> <span><b>My GitHub</b><small>${github.connected ? `@${esc(github.login)}’s repositories` : 'Connect GitHub first'}</small></span></label>
      </fieldset>

      <label class="field only-url">Repository URL
        <input name="url" id="import-url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/repo" />
        <small class="muted">GitHub, GitLab, Bitbucket, Codeberg or any https git URL. A “/tree/branch” link picks that branch.</small>
      </label>
      <label class="field only-repo">Repository
        <select name="repo" id="import-repo">${repoOptions}</select>
      </label>

      <fieldset class="choice-row only-url">
        <legend>What should Lyrcloud do?</legend>
        <label class="choice"><input type="radio" name="mode" value="deploy" checked data-action="import-mode" /> <span><b>Deploy it</b><small>Build and host it as it is</small></span></label>
        <label class="choice"><input type="radio" name="mode" value="copy" data-action="import-mode"${needsGithub} /> <span><b>Copy to my GitHub</b><small>A new repository you own</small></span></label>
        <label class="choice"><input type="radio" name="mode" value="fork" data-action="import-mode"${needsGithub} /> <span><b>Fork on GitHub</b><small>GitHub sources only</small></span></label>
      </fieldset>
      ${github.connected ? '' : github.available ? '<p class="muted only-url">Copy and fork need GitHub. <button class="text-link" type="button" data-action="github-connect">Connect GitHub</button></p>' : ''}
      <div class="only-copy grid-2">
        <label class="field">New repository name<input name="copyName" id="import-copy-name" maxlength="100" placeholder="my-site" /></label>
        <label class="check-row"><input type="checkbox" name="copyPrivate" checked /> Make it private</label>
      </div>

      <label class="field">Project name
        <span class="name-field"><input name="name" id="import-name" required maxlength="40" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" placeholder="my-site" autocomplete="off" spellcheck="false" /><span class="suffix">.${esc(domain)}</span></span>
        <small class="muted">Your site’s address. Lower-case letters, numbers and hyphens.</small>
      </label>

      <details class="advanced">
        <summary>Build settings</summary>
        <p class="muted">Leave blank to detect them: Lyrcloud finds npm, pnpm or yarn, runs the build script and publishes dist, build, out or public.</p>
        <div class="grid-2">
          <label class="field">Branch<input name="branch" placeholder="default branch" /></label>
          <label class="field">Root folder<input name="rootDir" placeholder="e.g. apps/web" /></label>
          <label class="field">Install command<input name="installCommand" placeholder="e.g. npm ci" /></label>
          <label class="field">Build command<input name="buildCommand" placeholder="e.g. npm run build" /></label>
          <label class="field">Output folder<input name="outputDir" placeholder="e.g. dist" /></label>
        </div>
      </details>
      <p class="form-error" role="alert" hidden></p>
      <div class="row"><button class="btn primary" type="submit"${atLimit ? ' disabled' : ''}>Import and deploy</button></div>
    </form>`;
}

function projectsView(route) {
  if (projects.error) return `${pageHead('Projects')}<section class="panel"><p class="form-error">${esc(projects.error)}</p><button class="btn" data-action="projects-retry">Try again</button></section>`;
  if (!projects.data) return `${pageHead('Projects')}<section class="panel"><p class="muted">Loading projects…</p></section>`;
  if (route.params.get('new')) return importView();
  const { projects: list, limits, github } = projects.data;
  const rows = list.map((item) => `
    <tr>
      <td><a class="link" href="#/projects/${item.projectId}">${esc(item.name)}</a><div class="muted mono">${esc(item.url.replace('https://', ''))}</div></td>
      <td>${item.github ? `GitHub · ${esc(item.github.fullName)}` : item.source ? `${SOURCE_LABELS[item.source.provider] || 'Git'} · ${esc(item.source.url.replace(/^https:\/\/[^/]+\//, ''))}` : '—'}</td>
      <td>${deployBadge(item.status)}</td>
      <td>${item.lastDeployAt ? formatDate(item.lastDeployAt) : '<span class="muted">—</span>'}</td>
    </tr>`).join('');
  return `
    ${pageHead('Projects', `Import any git repository and put it live at <span class="mono">name.${esc(projects.data.domain)}</span>.`, '<a class="btn primary" href="#/projects?new=1">+ Import project</a>')}
    ${githubPanel(github)}
    ${list.length
      ? `<section class="panel"><div class="table-scroll"><table class="table">
          <thead><tr><th>Project</th><th>Source</th><th>Status</th><th>Last deploy</th></tr></thead>
          <tbody>${rows}</tbody></table></div></section>`
      : `<section class="panel empty">
          <span class="empty-icon" aria-hidden="true">⇪</span>
          <h2>Put your first project live</h2>
          <p>Paste a link to any git repository. Lyrcloud builds it and gives it an address in about a minute.</p>
          <div class="row center"><a class="btn primary" href="#/projects?new=1">Import project</a></div>
        </section>`}
    <p class="muted">${limits.used} of ${limits.projects} projects on your ${esc(PLAN_INFO[limits.plan]?.name || limits.plan)} plan · ${limits.buildsPerDay} builds a day.</p>`;
}

const shortCommit = (commit) => (commit ? `<code>${esc(commit.slice(0, 7))}</code>` : '');

function projectView(route) {
  if (projects.detailError) return `${pageHead('Project')}<section class="panel"><p class="form-error">${esc(projects.detailError)}</p><a class="btn" href="#/projects">All projects</a></section>`;
  const detail = projects.detail?.project.projectId === route.projectId ? projects.detail : null;
  if (!detail) return `${pageHead('Project')}<section class="panel"><p class="muted">Loading project…</p></section>`;
  const { project, deployments } = detail;
  const settings = project.settings || {};
  const sourceLink = project.github
    ? `<a class="link" href="${esc(project.github.url)}" target="_blank" rel="noopener">github.com/${esc(project.github.fullName)}</a>${project.github.mode === 'copy' ? ' <span class="muted">(your copy)</span>' : project.github.mode === 'fork' ? ' <span class="muted">(your fork)</span>' : ''}`
    : project.source ? `<a class="link" href="${esc(project.source.url)}" target="_blank" rel="noopener">${esc(project.source.url.replace('https://', ''))}</a>` : '—';
  const rows = deployments.map((item) => {
    const open = projects.openLog === item.deployId;
    const actions = [
      `<button class="btn small" data-action="project-log" data-id="${item.deployId}">${open ? 'Hide log' : 'Log'}</button>`,
      item.status === 'ready' ? `<button class="btn small" data-action="project-promote" data-id="${item.deployId}">Make live</button>` : '',
    ].join('');
    return `
      <tr>
        <td>${deployBadge(item.status)}${item.error ? `<div class="form-error small-text">${esc(item.error)}</div>` : ''}</td>
        <td>${shortCommit(item.commit)} ${esc(item.message || '')}<div class="muted">${esc({ create: 'First deploy', copy: 'Copied and deployed', push: 'Push', manual: 'Redeploy' }[item.trigger] || item.trigger || '')}${item.branch ? ` · ${esc(item.branch)}` : ''}${item.framework ? ` · ${esc(item.framework)}` : ''}</div></td>
        <td>${formatDate(item.createdAt)}${item.finishedAt ? `<div class="muted">${Math.max(1, Math.round((new Date(item.finishedAt) - new Date(item.createdAt)) / 1000))} s</div>` : ''}</td>
        <td><div class="row">${actions}</div></td>
      </tr>
      ${open ? `<tr class="log-row"><td colspan="4"><pre class="build-log">${esc(projects.logs[item.deployId] ?? 'Loading log…')}</pre></td></tr>` : ''}`;
  }).join('');
  return `
    ${pageHead(esc(project.name), `<a class="link" href="${esc(project.url)}" target="_blank" rel="noopener">${esc(project.url.replace('https://', ''))}</a> ${deployBadge(project.status)}`,
      `<a class="btn" href="#/projects">All projects</a>${project.liveDeployId ? `<a class="btn" href="${esc(project.url)}" target="_blank" rel="noopener">Visit ↗</a>` : ''}<button class="btn primary" data-action="project-redeploy"${project.disabled ? ' disabled' : ''}>Redeploy</button>`)}
    ${project.disabled ? '<p class="form-error">Lyrcloud has disabled this project, so it’s offline. Contact hello@lyrcloud.com.</p>' : ''}
    <section class="panel">
      <dl class="facts">
        <dt>Source</dt><dd>${sourceLink}</dd>
        <dt>Branch</dt><dd>${esc(project.github?.branch || settings.branch || 'default')}</dd>
        <dt>Deploys</dt><dd>${project.github ? 'Automatically on every push to this branch, or with Redeploy' : 'When you press Redeploy (it fetches the latest commit)'}</dd>
        <dt>Created</dt><dd>${formatDate(project.createdAt)}</dd>
      </dl>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Deployments</h2><span class="muted">The last few stay ready, so you can roll back</span></div>
      ${deployments.length ? `<div class="table-scroll"><table class="table deploy-table"><thead><tr><th>Status</th><th>Commit</th><th>Started</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No deployments yet.</p>'}
    </section>
    <form class="panel" data-form="project-settings">
      <div class="panel-head"><h2>Build settings</h2></div>
      <p class="muted">Blank fields are detected automatically. Changes apply to the next deploy.</p>
      <div class="grid-2">
        ${[['branch', 'Branch', 'default branch'], ['rootDir', 'Root folder', 'e.g. apps/web'], ['installCommand', 'Install command', 'e.g. npm ci'], ['buildCommand', 'Build command', 'e.g. npm run build'], ['outputDir', 'Output folder', 'e.g. dist']]
          .map(([field, label, hint]) => `<label class="field">${label}<input name="${field}" value="${esc(field === 'branch' ? project.github?.branch || settings.branch || '' : settings[field] || '')}" placeholder="${hint}" /></label>`).join('')}
      </div>
      <div class="row"><button class="btn primary" type="submit">Save settings</button></div>
    </form>
    <section class="panel">
      ${settingRow('Delete project', `Takes ${esc(project.url.replace('https://', ''))} offline and frees the name. Your GitHub repository isn’t touched.`, '<button class="btn danger" data-action="project-delete">Delete</button>')}
    </section>`;
}

// Fills the project and repository names from the URL while the person hasn't typed their own.
function suggestImportNames(form) {
  const url = form.querySelector('#import-url').value.trim();
  const repo = form.dataset.kind === 'repo' ? form.querySelector('#import-repo').value : '';
  const source = repo || url;
  const repoName = source.replace(/\.git$/, '').replace(/\/(-\/)?(tree|src)\/.*$/, '').split(/[/:]/).filter(Boolean).pop() || '';
  const name = form.querySelector('#import-name');
  if (!name.dataset.touched) name.value = repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const copyName = form.querySelector('#import-copy-name');
  if (copyName && !copyName.dataset.touched) copyName.value = repoName.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100);
}

async function importProject(form, data) {
  const errorNode = form.querySelector('.form-error');
  const button = form.querySelector('[type="submit"]');
  const kind = String(data.get('kind'));
  const mode = kind === 'repo' ? 'deploy' : String(data.get('mode'));
  const settings = Object.fromEntries(['branch', 'rootDir', 'installCommand', 'buildCommand', 'outputDir'].map((field) => [field, String(data.get(field) || '').trim()]).filter(([, value]) => value));
  const body = {
    name: String(data.get('name')).trim().toLowerCase(),
    source: kind === 'repo' ? { repo: String(data.get('repo')) } : { url: String(data.get('url')).trim() },
    mode,
    settings,
    ...(mode === 'copy' || mode === 'fork' ? { copy: { name: String(data.get('copyName') || '').trim() || undefined, private: data.get('copyPrivate') === 'on' } } : {}),
  };
  if (kind === 'url' && !body.source.url) return showFormError(form, 'Paste a repository URL.');
  if (kind === 'repo' && !body.source.repo) return showFormError(form, 'Pick a repository.');
  errorNode.hidden = true;
  button.disabled = true;
  button.textContent = mode === 'copy' ? 'Copying…' : mode === 'fork' ? 'Forking…' : 'Importing…';
  try {
    const result = await projectsApi('/projects', { method: 'POST', body: JSON.stringify(body) });
    projects.data = null;
    projects.detail = { project: result.project, deployments: result.deployment ? [result.deployment] : [] };
    if (result.warning) toast(result.warning);
    go(`#/projects/${result.project.projectId}`);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Import and deploy';
    showFormError(form, error.message);
  }
}

async function openLog(deployId) {
  projects.openLog = projects.openLog === deployId ? null : deployId;
  render();
  if (!projects.openLog) return;
  try {
    projects.logs[deployId] = (await projectsApi(`/projects/${projects.detail.project.projectId}/deployments/${deployId}/log`)).log || 'The log is empty.';
  } catch (error) {
    projects.logs[deployId] = error.message;
  }
  render();
  const log = app.querySelector('.build-log');
  if (log) log.scrollTop = log.scrollHeight;
}

async function connectGithubAccount(target) {
  target.disabled = true;
  try {
    location.href = (await projectsApi('/projects/github/connect', { method: 'POST' })).installUrl;
  } catch (error) {
    target.disabled = false;
    toast(error.message);
  }
}

// Admin: every project, with a switch to take one offline.
async function loadAdminProjects() {
  adminProjects.loading = true;
  try {
    adminProjects.list = (await projectsApi('/admin/projects')).projects;
    adminProjects.error = '';
  } catch (error) {
    adminProjects.error = error.message;
  }
  adminProjects.loading = false;
  if (isAdminView()) render();
}

async function loadAdminGithubApp() {
  adminGithubApp.loading = true;
  try {
    adminGithubApp.data = await projectsApi('/admin/github-app');
  } catch (error) {
    adminGithubApp.error = error.message;
  }
  adminGithubApp.loading = false;
  if (isAdminView()) render();
}

function adminProjectsTab() {
  if (adminProjects.error) return `<section class="panel"><p class="form-error">${esc(adminProjects.error)}</p></section>`;
  if (!adminProjects.list) return '<section class="panel"><p class="muted">Loading projects…</p></section>';
  const rows = adminProjects.list.map((item) => `
    <tr>
      <td><a class="link" href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.name)}</a><div class="muted">${esc(item.ownerEmail || '—')}</div></td>
      <td>${esc(item.github?.fullName || item.source?.url.replace('https://', '') || '—')}</td>
      <td>${deployBadge(item.status)}</td>
      <td>${formatDate(item.createdAt)}</td>
      <td><button class="btn small${item.disabled ? '' : ' danger'}" data-action="admin-project-toggle" data-id="${item.projectId}">${item.disabled ? 'Enable' : 'Disable'}</button></td>
    </tr>`).join('');
  return `
    <section class="panel">
      <div class="panel-head"><h2>Projects</h2><span class="muted">${adminProjects.list.length} total</span></div>
      <p class="muted">Disabling a project takes its site offline at once and stops new deploys. Use it for phishing, malware or abuse.</p>
      ${adminProjects.list.length ? `<div class="table-scroll"><table class="table"><thead><tr><th>Project</th><th>Source</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No projects yet.</p>'}
    </section>`;
}

function adminGithubAppPanel(isSuper) {
  const { data, error } = adminGithubApp;
  if (error) return `<section class="panel"><div class="panel-head"><h2>GitHub App</h2></div><p class="form-error">${esc(error)}</p></section>`;
  if (!data) return '';
  return `
    <section class="panel">
      <div class="panel-head"><h2>GitHub App</h2>${data.configured ? '<span class="status ok">● Ready</span>' : '<span class="status pending">◌ Not set up</span>'}</div>
      ${data.configured
        ? `<p class="muted">Customers connect GitHub through <a class="link" href="${esc(data.url)}" target="_blank" rel="noopener">${esc(data.name)}</a> to import private repositories, copy or fork projects, and deploy on push.</p>`
        : isSuper
          ? `<p class="muted">Projects need a GitHub App for private repositories, copies, forks and deploy-on-push. GitHub creates it from Lyrcloud’s settings in one step; you only confirm the name.</p>
            <form class="row" data-form="github-app">
              <input name="name" maxlength="34" value="Lyrcloud Deploy" aria-label="GitHub App name" />
              <button class="btn primary" type="submit">Create GitHub App</button>
            </form>
            <p class="muted">GitHub app names are unique across GitHub. If the name is taken, GitHub asks for another.</p>`
          : '<p class="muted">The super admin hasn’t set up the GitHub App yet.</p>'}
    </section>`;
}

// ------------------------------------------------------------------ Lyrcloud Domains

// Real: domains are bought from the registrar (DNA, Domain Name API) through the domains API once the
// customer has paid with Stripe. Registered domains get Lyrcloud DNS, edited here with real records.
const domainsApi = (path, options) => api(path, options, DOMAINS_API_BASE);
const DOMAINS_ENABLED = !DOMAINS_API_BASE.endsWith('.invalid');
const isDomainView = (view) => Boolean(view) && (view.startsWith('domain') || view === 'subdomain');

const domains = {
  data: null, error: '', loading: false,
  prices: null, pricesTried: false,
  checked: new Set(), // names the buy page already looked up, so a failed check isn't retried in a loop
  search: null, searchError: '', searching: false, query: '',
  check: {}, // domain -> search result for the buy page
  detail: null, detailError: '', detailFor: null, loadingDetail: false,
  sub: null, subError: '', subFor: null, loadingSub: false, // one name.lyr.cloud subdomain
  refreshTimer: null,
};
const adminDomains = { data: null, pricing: null, lyr: null, error: '', loading: false };

const money = (cents) => (Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : '—');
const DOMAIN_STATUS = {
  awaiting_payment: ['pending', 'Awaiting payment'],
  registering: ['pending', 'Registering…'],
  transferring: ['pending', 'Transferring…'],
  active: ['ok', 'Active'],
  failed: ['bad', 'Failed · refunded'],
  expired: ['bad', 'Expired'],
  cancelled: ['bad', 'Cancelled'],
};
const domainStatus = (status) => {
  const [cls, label] = DOMAIN_STATUS[status] || ['pending', status];
  return `<span class="status ${cls}">${cls === 'ok' ? '●' : cls === 'bad' ? '✕' : '◌'} ${esc(label)}</span>`;
};
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

// Countries the registrar accepts (ISO 3166-1), named in the visitor's language.
const COUNTRY_CODES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IS IT JE JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');
let countryOptionsCache;
function countryOptions(selected) {
  if (!countryOptionsCache) {
    let names;
    try {
      names = new Intl.DisplayNames(undefined, { type: 'region' });
    } catch {}
    countryOptionsCache = COUNTRY_CODES.map((code) => [code, names?.of(code) || code]).sort((a, b) => a[1].localeCompare(b[1]));
  }
  return countryOptionsCache.map(([code, name]) => `<option value="${code}"${code === selected ? ' selected' : ''}>${esc(name)}</option>`).join('');
}

async function loadDomains() {
  domains.loading = true;
  try {
    domains.data = await domainsApi('/domains');
    domains.error = '';
    syncDomainSites();
  } catch (error) {
    domains.error = error.message;
  }
  domains.loading = false;
  if (isDomainView(currentRoute?.view)) render();
}

async function loadDomainPrices() {
  if (domains.prices || domains.pricesTried) return;
  domains.pricesTried = true;
  try {
    const response = await fetch(`${DOMAINS_API_BASE}/public/domains/prices`);
    const data = await response.json();
    if (response.ok) domains.prices = Object.fromEntries(data.tlds.map((item) => [item.tld, item]));
  } catch {}
  if (currentRoute?.view === 'domain-buy') render();
}

async function loadDomainDetail(name) {
  domains.loadingDetail = true;
  domains.detailFor = name;
  try {
    domains.detail = await domainsApi(`/domains/${encodeURIComponent(name)}`);
    domains.detailError = '';
    if (domains.detail.domain.status === 'active') syncDomainSites([domains.detail.domain]);
  } catch (error) {
    domains.detail = null;
    domains.detailError = error.message;
  }
  domains.loadingDetail = false;
  if (currentRoute?.view === 'domain' && currentRoute.domain === name) render();
}

async function searchDomains(query) {
  domains.query = query;
  domains.searching = true;
  domains.searchError = '';
  render();
  try {
    const response = await fetch(`${DOMAINS_API_BASE}/public/domains/search?q=${encodeURIComponent(query)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Search failed (${response.status})`);
    domains.search = data;
    for (const item of [...data.results, ...data.suggestions]) domains.check[item.domain] = item;
  } catch (error) {
    domains.searchError = error.message;
  }
  domains.searching = false;
  render();
}

// Registered domains show up as active websites, with the registrar's real nameservers.
function syncDomainSites(list = domains.data?.domains || []) {
  let changed = false;
  for (const item of list) {
    if (item.status !== 'active') continue;
    let zone = findZone(item.domain);
    if (!zone) {
      zone = createZone(item.domain, state.plan, []);
      state.zones.push(zone);
      changed = true;
    }
    if (zone.status !== 'active' || !zone.registered || String(zone.nameservers) !== String(item.nameservers)) {
      Object.assign(zone, { status: 'active', registered: true, lyrcloudDns: item.lyrcloudDns, nameservers: item.nameservers.length ? item.nameservers : zone.nameservers });
      changed = true;
    }
  }
  if (changed) save();
}

function domainsAfterRender(route) {
  if (!DOMAINS_ENABLED) return;
  clearTimeout(domains.refreshTimer);
  if (!domains.data && !domains.loading && !domains.error) loadDomains();
  if (route.view === 'subdomain' && (domains.subFor !== route.label || (!domains.sub && !domains.subError)) && !domains.loadingSub) loadSubdomain(route.label);
  if (route.view === 'subdomain' && domains.sub?.subdomain?.status === 'awaiting_payment' && route.params.get('paid')) {
    domains.refreshTimer = setTimeout(() => currentRoute.view === 'subdomain' && loadSubdomain(currentRoute.label), 5000);
  }
  if (route.view === 'domain-buy') {
    loadDomainPrices();
    const name = route.params.get('domain');
    if (name && route.params.get('action') !== 'transfer' && !domains.check[name] && !domains.checked.has(name) && !domains.searching) {
      domains.checked.add(name);
      searchDomains(name);
    }
  }
  if (route.view === 'domain' && (domains.detailFor !== route.domain || (!domains.detail && !domains.detailError)) && !domains.loadingDetail) loadDomainDetail(route.domain);
  // Registrations finish within minutes; keep the page fresh while one is under way.
  const status = domains.detail?.domain?.status;
  const confirming = status === 'awaiting_payment' && route.params.get('paid');
  if (route.view === 'domain' && (status === 'registering' || status === 'transferring' || confirming || domains.detail?.domain?.renewing)) {
    domains.refreshTimer = setTimeout(() => {
      if (currentRoute.view === 'domain') loadDomainDetail(currentRoute.domain);
    }, 20_000);
  }
}

function domainResult(item) {
  const buy = `#/domains/buy?domain=${encodeURIComponent(item.domain)}`;
  const action = item.available
    ? `<a class="btn primary small" href="${buy}">Buy</a>`
    : item.status === 'UNAVAILABLE'
      ? `<a class="btn small" href="${buy}&action=transfer">Transfer in</a>`
      : ['NOT_SOLD', 'PREMIUM', 'DOCUMENTS'].includes(item.status) ? '' : `<button class="btn small" data-action="domain-search-again" data-q="${esc(item.domain)}">Check again</button>`;
  const unavailable = {
    UNAVAILABLE: 'Taken', NOT_SOLD: `We don’t sell .${esc(item.tld)} yet`, DONT_KNOW: 'Couldn’t check right now',
    PREMIUM: 'Premium name, not sold here', DOCUMENTS: 'Needs registry documents',
  };
  const note = item.available
    ? `<b>${money(item.price)}</b><small>first year · renews at ${money(item.renew)}/yr</small>`
    : `<span class="muted">${unavailable[item.status] || 'Not available'}</span>`;
  return `<li class="domain-result${item.available ? ' is-available' : ''}"><span class="domain-name mono">${esc(item.domain)}</span><span class="domain-price">${note}</span>${action}</li>`;
}

function domainSearchPanel() {
  const result = domains.search;
  return `
    <section class="panel">
      <form class="domain-search" data-form="domain-search" role="search">
        <input name="q" placeholder="Find your domain, like mybrand.com" aria-label="Domain name" autocomplete="off" value="${esc(domains.query)}" required />
        <button class="btn primary" type="submit"${domains.searching ? ' disabled' : ''}>${domains.searching ? 'Searching…' : 'Search'}</button>
      </form>
      ${domains.searchError ? `<p class="form-error">${esc(domains.searchError)}</p>` : ''}
      ${result ? `
        <ul class="domain-results">${result.results.map(domainResult).join('')}</ul>
        ${result.suggestions.length ? `<h3 class="domain-subhead">More ideas</h3><ul class="domain-results">${result.suggestions.map(domainResult).join('')}</ul>` : ''}` : ''}
    </section>`;
}

function domainsView(route) {
  if (!DOMAINS_ENABLED) return views.missing();
  const list = domains.data?.domains || [];
  const table = domains.error
    ? `<p class="form-error">${esc(domains.error)}</p><button class="btn" data-action="domains-retry">Try again</button>`
    : !domains.data
      ? '<p class="muted">Loading your domains…</p>'
      : list.length
        ? `<div class="table-scroll"><table class="table">
            <thead><tr><th>Domain</th><th>Status</th><th>Expires</th><th>Auto-renew</th><th>Renews at</th></tr></thead>
            <tbody>${list.map((item) => `<tr>
              <td><a class="link mono" href="#/domains/${encodeURIComponent(item.domain)}">${esc(item.domain)}</a></td>
              <td>${domainStatus(item.status)}</td>
              <td>${shortDate(item.expiresAt)}</td>
              <td>${item.status === 'active' || item.status === 'registering' || item.status === 'transferring' ? (item.autoRenew ? 'On' : 'Off') : '—'}</td>
              <td>${item.renewPrice ? `${money(item.renewPrice)}/yr` : '—'}</td>
            </tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">No domains yet. Search above to register one, or transfer one you already own.</p>';
  return `
    ${pageHead('Domains', 'Register a new domain or bring one you own. Free WHOIS privacy and Lyrcloud DNS included.')}
    ${domains.data && !domains.data.paymentsReady ? '<p class="notice">Domain checkout opens soon — you can search and see prices now.</p>' : ''}
    ${domainSearchPanel()}
    <section class="panel">
      <div class="panel-head"><h2>Your domains</h2>${list.length ? `<span class="muted">${list.length} total</span>` : ''}</div>
      ${table}
    </section>
    ${subdomainsPanel(route)}
    <section class="panel">
      <div class="panel-head"><h2>Transfer a domain to Lyrcloud</h2></div>
      <p class="muted">Moving a domain adds a year to its registration. Unlock it at your current registrar and get its transfer (EPP) code first.</p>
      <form class="row" data-form="domain-transfer-start">
        <input class="grow" name="domain" placeholder="example.com" aria-label="Domain to transfer" required autocomplete="off" />
        <button class="btn" type="submit">Start transfer</button>
      </form>
    </section>
    ${lyrWaitlistPanel(route)}`;
}

const contactField = (name, label, value, attrs = '') =>
  `<label class="field">${label}<input name="${name}" value="${esc(value || '')}"${attrs} /></label>`;

function domainBuyView(route) {
  if (!DOMAINS_ENABLED) return views.missing();
  const domain = String(route.params.get('domain') || '').trim().toLowerCase();
  const action = route.params.get('action') === 'transfer' ? 'transfer' : 'register';
  if (!/^[a-z0-9-]+\.[a-z]{2,63}$/.test(domain)) return `${pageHead('Buy a domain')}<section class="panel"><p class="form-error">Pick a domain first.</p><a class="btn" href="#/domains">Search domains</a></section>`;
  const tld = domain.slice(domain.indexOf('.') + 1);
  const price = domains.prices?.[tld];
  const check = domains.check[domain];
  const saved = domains.data?.contact || {};
  const person = me();
  const [first = '', ...rest] = String(person.name || '').split(' ');
  const contact = { firstName: first, lastName: rest.join(' '), email: person.email || '', phoneCountry: '+1', country: 'US', ...saved };
  const paymentsReady = domains.data?.paymentsReady;
  const cancelled = route.params.get('cancelled');

  let status = '';
  if (action === 'register') {
    if (domains.searching && !check) status = '<p class="muted">Checking availability…</p>';
    else if (check && !check.available) {
      status = `<p class="form-error">${esc(domain)} isn’t available to register. ${check.status === 'UNAVAILABLE' ? `If it’s yours, <a href="#/domains/buy?domain=${encodeURIComponent(domain)}&action=transfer">transfer it in</a>.` : ''}</p>`;
    } else if (check) status = `<p class="status ok">● ${esc(domain)} is available</p>`;
  }
  const years = [1, 2, 3, 4, 5]
    .map((n) => `<option value="${n}">${n} year${n === 1 ? '' : 's'}${price ? ` · ${money(price.register + price.renew * (n - 1))}` : ''}</option>`).join('');
  const total = price ? (action === 'transfer' ? price.transfer : price.register) : null;
  const blocked = !paymentsReady || (action === 'register' && check && !check.available);

  return `
    ${pageHead(action === 'transfer' ? `Transfer ${esc(domain)}` : `Register ${esc(domain)}`,
      price ? `${action === 'transfer' ? `${money(price.transfer)} including one more year` : `${money(price.register)} for the first year`} · renews at ${money(price.renew)}/yr` : domains.prices ? `Lyrcloud doesn’t sell .${esc(tld)} domains yet` : 'Loading price…',
      '<a class="btn" href="#/domains">Back to domains</a>')}
    ${cancelled ? '<p class="notice">Payment was cancelled. Nothing was charged — you can try again below.</p>' : ''}
    ${domains.data && !paymentsReady ? '<p class="notice">Domain checkout opens soon. You can fill this in, but payment isn’t switched on yet.</p>' : ''}
    <form class="panel stack domain-checkout" data-form="domain-checkout">
      <input type="hidden" name="domain" value="${esc(domain)}" />
      <input type="hidden" name="action" value="${action}" />
      ${status}
      ${action === 'register'
        ? `<label class="field">Registration length<select name="years" data-action="domain-years">${years}</select></label>`
        : `<label class="field">Transfer (EPP) code<input name="authCode" required autocomplete="off" placeholder="From your current registrar" /></label>
           <p class="muted small">Before you start: unlock the domain at your current registrar and turn off its WHOIS privacy if they require it. Domains registered or transferred in the last 60 days can’t move yet. Transfers take 5–7 days; your site keeps working on its current DNS.</p>`}
      <label class="check-row"><input type="checkbox" name="autoRenew" checked /> Renew automatically every year with the card I pay with now</label>

      <fieldset class="contact-fields">
        <legend>Registrant contact</legend>
        <p class="muted small">Registries require the owner’s real details. They stay private: WHOIS privacy is on for free. Watch for a verification email to this address and click it within 15 days, or the registry suspends the domain.</p>
        <div class="field-grid">
          ${contactField('firstName', 'First name', contact.firstName, ' required autocomplete="given-name"')}
          ${contactField('lastName', 'Last name', contact.lastName, ' required autocomplete="family-name"')}
          ${contactField('organization', 'Company (optional)', contact.organization, ' autocomplete="organization"')}
          ${contactField('email', 'Email', contact.email, ' type="email" required autocomplete="email"')}
          <div class="field phone-field"><span>Phone</span><div class="row tight">
            <input name="phoneCountry" value="${esc(contact.phoneCountry || '+1')}" aria-label="Country calling code" size="4" required />
            <input name="phone" value="${esc(contact.phone || '')}" aria-label="Phone number" required autocomplete="tel-national" inputmode="tel" class="grow" />
          </div></div>
          ${contactField('address1', 'Address', contact.address1, ' required autocomplete="address-line1"')}
          ${contactField('address2', 'Address line 2 (optional)', contact.address2, ' autocomplete="address-line2"')}
          ${contactField('city', 'City', contact.city, ' required autocomplete="address-level2"')}
          ${contactField('state', 'State / region', contact.state, ' autocomplete="address-level1"')}
          ${contactField('zip', 'Postal code', contact.zip, ' required autocomplete="postal-code"')}
          <label class="field">Country<select name="country" required autocomplete="country">${countryOptions(contact.country)}</select></label>
        </div>
      </fieldset>
      <p class="form-error" hidden></p>
      <div class="row">
        <button class="btn primary" type="submit"${blocked ? ' disabled' : ''}>Continue to payment<span id="domain-total">${total ? ` · ${money(total)}` : ''}</span></button>
        <span class="muted small">Secure card payment with Stripe. If the registry refuses the domain, you’re refunded in full.</span>
      </div>
    </form>`;
}

function recordRows(records) {
  if (!records.length) return '<p class="muted">No records yet. Add an A record to point the domain at your server.</p>';
  return `<div class="table-scroll"><table class="table">
    <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>TTL</th><th></th></tr></thead>
    <tbody>${records.map((record) => `<tr>
      <td><span class="type-tag">${record.type}</span></td>
      <td class="mono">${esc(record.label)}</td>
      <td class="mono wrap">${record.values.map(esc).join('<br>')}</td>
      <td>${record.ttl ?? '—'}</td>
      <td class="row tight">
        <button class="btn small" data-action="record-edit" data-type="${record.type}" data-name="${esc(record.label)}">Edit</button>
        <button class="btn small danger" data-action="record-delete" data-type="${record.type}" data-name="${esc(record.label)}">Delete</button>
      </td>
    </tr>`).join('')}</tbody></table></div>`;
}

function domainView(route) {
  if (!DOMAINS_ENABLED) return views.missing();
  const name = route.domain;
  if (domains.detailError && domains.detailFor === name) {
    return `${pageHead(esc(name))}<section class="panel"><p class="form-error">${esc(domains.detailError)}</p><a class="btn" href="#/domains">All domains</a></section>`;
  }
  const detail = domains.detailFor === name ? domains.detail : null;
  if (!detail) return `${pageHead(esc(name))}<section class="panel"><p class="muted">Loading domain…</p></section>`;
  const item = detail.domain;
  const live = item.status === 'active';
  const paid = route.params.get('paid');
  const progress = item.status === 'registering'
    ? 'Payment received. Registration usually finishes within 15 minutes — this page updates by itself.'
    : item.status === 'transferring'
      ? `Payment received. Transfers take 5–7 days. Your current registrar may email the owner to approve it; approving it there makes it faster.${item.operationMessage ? ` <span class="muted">(${esc(item.operationMessage)})</span>` : ''}`
      : item.status === 'awaiting_payment' && paid
        ? 'Confirming your payment with Stripe… this page updates by itself.'
        : item.status === 'awaiting_payment'
        ? `This domain is held for you until ${formatDate(item.holdUntil)}.${item.checkoutUrl ? ` <a href="${esc(item.checkoutUrl)}">Finish paying</a>` : ''}`
        : '';
  const years = [1, 2, 3].map((n) => `<option value="${n}">${n} year${n === 1 ? '' : 's'} · ${money(item.renewPrice * n)}</option>`).join('');
  return `
    ${pageHead(`<span class="mono">${esc(item.domain)}</span>`, `${domainStatus(item.status)}${item.expiresAt ? ` · expires ${shortDate(item.expiresAt)}` : ''}${detail.owner ? ` · owner ${esc(detail.owner)}` : ''}`,
      `${live ? `<a class="btn" href="https://${esc(item.domain)}" target="_blank" rel="noopener">Visit ↗</a>` : ''}<a class="btn" href="#/domains">All domains</a>`)}
    ${paid && item.status !== 'active' ? '<p class="notice">Thanks — your payment went through.</p>' : ''}
    ${progress ? `<section class="panel callout"><p>${progress}</p></section>` : ''}
    ${item.failureReason ? `<section class="panel"><p class="form-error">The registry didn’t accept this ${item.action === 'transfer' ? 'transfer' : 'registration'}: ${esc(item.failureReason)}. Your payment was refunded in full.</p></section>` : ''}
    ${item.lastRenewalError ? `<section class="panel"><p class="form-error">${esc(item.lastRenewalError)}</p></section>` : ''}
    ${item.testRegistry ? '<section class="panel callout"><p>Bought with a Stripe test card, so this domain lives in the registrar’s test registry. It isn’t real and doesn’t resolve.</p></section>' : ''}
    ${detail.verification?.pending ? `
      <section class="panel callout">
        <p><b>Confirm the owner’s e-mail address.</b> The registry sent a link to <b>${esc(detail.verification.email || 'the registrant')}</b>.
        ${detail.verification.expired ? 'The link has expired and the domain may be suspended — send a new one.' : `If nobody clicks it by ${detail.verification.deadline ? formatDate(detail.verification.deadline) : 'its deadline'}, the registry suspends the domain and it stops working until it’s confirmed.`}</p>
        <button class="btn small" data-action="domain-verify-email">Send the e-mail again</button>
      </section>` : ''}
    ${live ? `
      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>Renewal</h2></div>
          ${settingRow('Auto-renew', `Charges ${money(item.renewPrice)} to your saved card 30 days before the domain expires.`, toggle('domain-autorenew', item.autoRenew, 'Auto-renew'))}
          <form class="row" data-form="domain-renew">
            <select name="years" aria-label="Renew for">${years}</select>
            <button class="btn" type="submit"${item.renewing ? ' disabled' : ''}>${item.renewing ? 'Renewing…' : 'Renew now'}</button>
          </form>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Nameservers</h2>${item.lyrcloudDns ? '<span class="status ok">● Lyrcloud DNS</span>' : ''}</div>
          <ul class="ns-list">${item.nameservers.map((ns) => `<li><code>${esc(ns)}</code></li>`).join('') || '<li class="muted">—</li>'}</ul>
          ${findZone(item.domain) ? `<a class="link" href="#/zones/${encodeURIComponent(item.domain)}/overview">Open as a website →</a>` : ''}
        </section>
      </div>
      ${item.lyrcloudDns ? `
        <section class="panel">
          <div class="panel-head"><h2>DNS records</h2><span class="muted">Live on Lyrcloud DNS</span></div>
          ${recordEditor(detail.records || [])}
        </section>`
        : '<section class="panel"><p class="muted">This domain uses the DNS it had before the transfer. Manage records with your DNS provider.</p></section>'}` : ''}
    ${detail.orders.length ? `
      <section class="panel">
        <div class="panel-head"><h2>Payments</h2></div>
        <div class="table-scroll"><table class="table">
          <thead><tr><th>Date</th><th>What</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>${detail.orders.map((order) => `<tr><td>${shortDate(order.createdAt)}</td><td>${esc(order.action)}${order.auto ? ' (auto)' : ''} · ${order.years} yr</td><td>${money(order.amount)}</td><td>${esc(order.status)}${order.failureReason ? ` <span class="muted">${esc(order.failureReason)}</span>` : ''}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>` : ''}`;
}

// The record form and table, shared by domains and subdomains.
function recordEditor(records, { apexHint = 'Name (@ for root)' } = {}) {
  return `
    <form class="dns-form" data-form="record-save" id="record-form">
      <select name="type" aria-label="Type">${['A', 'AAAA', 'CNAME', 'MX', 'TXT'].map((type) => `<option>${type}</option>`).join('')}</select>
      <input name="name" placeholder="${apexHint}" value="@" required aria-label="Name" />
      <textarea name="values" rows="1" placeholder="Value (one per line)" required aria-label="Values"></textarea>
      <select name="ttl" aria-label="TTL">${[[300, '5 min'], [3600, '1 hour'], [86400, '1 day'], [60, '1 min']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <button class="btn primary" type="submit">Save record</button>
    </form>
    <p class="form-error" hidden></p>
    <p class="muted small">Saving a type and name that already exist replaces them. Changes reach resolvers within the TTL.</p>
    ${recordRows(records)}`;
}

// ---- name.lyr.cloud subdomains (switched on once lyr.cloud is registered)

async function loadSubdomain(label) {
  domains.loadingSub = true;
  domains.subFor = label;
  try {
    domains.sub = await domainsApi(`/domains/subdomains/${encodeURIComponent(label)}`);
    domains.subError = '';
  } catch (error) {
    domains.sub = null;
    domains.subError = error.message;
  }
  domains.loadingSub = false;
  if (currentRoute?.view === 'subdomain' && currentRoute.label === label) render();
}

function subdomainsPanel(route) {
  const info = domains.data?.subdomains;
  if (!info?.enabled) return '';
  const price = info.freeWithPlan ? `Included with your ${esc(planName(state.plan))} plan` : `${money(info.price)}/year · free on ${info.freePlans.map(planName).join(' and ')}`;
  const cancelled = route.params.get('cancelled');
  return `
    <section class="panel">
      <div class="panel-head"><h2>Your name.${esc(info.zone)}</h2><span class="muted">${price}</span></div>
      <p class="muted">A free-to-remember address that works everywhere, with HTTPS-ready DNS. Point it at a Lyrcloud project, your server, or any site.</p>
      ${cancelled ? `<p class="notice">Payment for ${esc(cancelled)}.${esc(info.zone)} was cancelled. Nothing was charged.</p>` : ''}
      <form class="domain-search" data-form="subdomain-claim">
        <div class="suffix-input"><input name="label" placeholder="my-shop" aria-label="Name" autocomplete="off" required maxlength="63" /><span>.${esc(info.zone)}</span></div>
        <button class="btn primary" type="submit">${info.freeWithPlan ? 'Claim it' : `Claim for ${money(info.price)}/yr`}</button>
      </form>
      ${info.items.length ? `<ul class="domain-results">${info.items.map((item) => `
        <li class="domain-result is-available">
          <a class="domain-name mono link" href="#/domains/sub/${encodeURIComponent(item.label)}">${esc(item.name)}</a>
          <span class="domain-price">${domainStatus(item.status)}<small>${item.free ? 'Included with your plan' : item.expiresAt ? `Renews ${shortDate(item.expiresAt)}` : ''}</small></span>
          <a class="btn small" href="#/domains/sub/${encodeURIComponent(item.label)}">DNS</a>
        </li>`).join('')}</ul>` : ''}
    </section>`;
}

function subdomainView(route) {
  if (!DOMAINS_ENABLED) return views.missing();
  const label = route.label;
  if (domains.subError && domains.subFor === label) return `${pageHead(esc(label))}<section class="panel"><p class="form-error">${esc(domains.subError)}</p><a class="btn" href="#/domains">All domains</a></section>`;
  const detail = domains.subFor === label ? domains.sub : null;
  if (!detail) return `${pageHead(esc(label))}<section class="panel"><p class="muted">Loading…</p></section>`;
  const item = detail.subdomain;
  const active = item.status === 'active';
  return `
    ${pageHead(`<span class="mono">${esc(item.name)}</span>`, `${domainStatus(item.status)}${item.free ? ' · included with your plan' : item.expiresAt ? ` · renews ${shortDate(item.expiresAt)} at ${money(item.renewPrice)}` : ''}`,
      `${active ? `<a class="btn" href="https://${esc(item.name)}" target="_blank" rel="noopener">Visit ↗</a>` : ''}<a class="btn" href="#/domains">All domains</a>`)}
    ${item.status === 'awaiting_payment' ? `<section class="panel callout"><p>${route.params.get('paid') ? 'Confirming your payment… this page updates by itself.' : `Held for you until ${formatDate(item.holdUntil)}.${item.checkoutUrl ? ` <a href="${esc(item.checkoutUrl)}">Finish paying</a>` : ''}`}</p></section>` : ''}
    ${item.failureReason ? `<section class="panel"><p class="form-error">${esc(item.failureReason)} Your payment was refunded.</p></section>` : ''}
    ${item.lastRenewalError ? `<section class="panel"><p class="form-error">${esc(item.lastRenewalError)}</p></section>` : ''}
    ${active ? `
      <section class="panel">
        <div class="panel-head"><h2>DNS records</h2><span class="muted">Live everywhere</span></div>
        <p class="muted small">Tip: to use it for a Lyrcloud project or another site, add a CNAME for @ pointing at that site’s address.</p>
        ${recordEditor(detail.records || [], { apexHint: `Name (@ for ${esc(item.name)})` })}
      </section>
      <section class="panel">
        ${item.free ? '' : settingRow('Auto-renew', `Charges ${money(item.renewPrice)} to your saved card 30 days before it renews.`, toggle('subdomain-autorenew', item.autoRenew, 'Auto-renew'))}
        ${settingRow('Release this name', 'Deletes its DNS records and lets someone else claim it.', `<button class="btn danger" data-action="subdomain-release">Release ${esc(item.name)}</button>`)}
      </section>` : ''}`;
}

// ---- .lyr waitlist: free reservations for when .lyr becomes official

function lyrWaitlistPanel(route) {
  const list = domains.data?.lyrReservations || [];
  const prefill = route.params.get('reserve') || '';
  return `
    <section class="panel" id="lyr-waitlist">
      <div class="panel-head"><h2>Reserve a .lyr name</h2><span class="status pending">◌ Free · preview</span></div>
      <p class="muted">.lyr is Lyrcloud’s own extension, <a href="/lyr/" target="_blank" rel="noopener">in preview</a>. Reserve up to three names for free; you’ll get first claim on them when .lyr opens. Nothing is charged.</p>
      <form class="domain-search" data-form="lyr-reserve">
        <div class="suffix-input"><input name="name" placeholder="mybrand" value="${esc(prefill.replace(/\.lyr$/, ''))}" aria-label=".lyr name" autocomplete="off" required maxlength="63" /><span>.lyr</span></div>
        <button class="btn primary" type="submit"${list.length >= 3 ? ' disabled' : ''}>Reserve</button>
      </form>
      ${list.length ? `<ul class="domain-results">${list.map((item) => `
        <li class="domain-result"><span class="domain-name mono">${esc(item.name)}</span><span class="domain-price"><small>Reserved ${shortDate(item.createdAt)}</small></span>
          <button class="btn small" data-action="lyr-unreserve" data-name="${esc(item.name)}">Give up</button></li>`).join('')}</ul>` : ''}
    </section>`;
}

// ---- admin

async function loadAdminDomains() {
  adminDomains.loading = true;
  try {
    const [data, pricing, lyr] = await Promise.all([domainsApi('/admin/domains'), domainsApi('/admin/domain-pricing'), domainsApi('/admin/lyr')]);
    Object.assign(adminDomains, { data, pricing, lyr: lyr.names, lyrReservations: lyr.reservations || [], error: '' });
  } catch (error) {
    adminDomains.error = error.message;
  }
  adminDomains.loading = false;
  if (isAdminView()) render();
}

const overridesText = (overrides) => Object.entries(overrides || {})
  .map(([tld, rule]) => `${tld} ${rule.percent ?? ''}${rule.percent !== undefined ? '%' : ''}${rule.flatCents !== undefined ? ` +${(rule.flatCents / 100).toFixed(2)}` : ''}`.trim()).join('\n');

function parseOverrides(text) {
  const overrides = {};
  for (const line of String(text).split('\n').map((value) => value.trim()).filter(Boolean)) {
    const match = line.match(/^\.?([a-z]{2,63})\s+(?:(\d+(?:\.\d+)?)%)?\s*(?:\+\s*\$?(\d+(?:\.\d+)?))?$/i);
    if (!match || (match[2] === undefined && match[3] === undefined)) throw new Error(`Couldn’t read “${line}”. Use lines like “io 5% +2.00”.`);
    overrides[match[1].toLowerCase()] = {
      ...(match[2] !== undefined ? { percent: Number(match[2]) } : {}),
      ...(match[3] !== undefined ? { flatCents: Math.round(Number(match[3]) * 100) } : {}),
    };
  }
  return overrides;
}

function adminDomainsTab(isSuper) {
  if (adminDomains.error) return `<section class="panel"><p class="form-error">${esc(adminDomains.error)}</p><button class="btn" data-action="admin-refresh">Try again</button></section>`;
  if (!adminDomains.data) return '<section class="panel"><p class="muted">Loading domains…</p></section>';
  const { data, pricing } = adminDomains;
  const { config, stripe } = pricing;
  const lock = isSuper ? '' : ' disabled';
  const stat = (label, value) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
  return `
    <div class="stat-grid">
      ${stat('Domain sales', money(data.totals.revenue))}
      ${stat('Registrar cost', money(data.totals.cost))}
      ${stat('Card fees (est.)', money(data.totals.fees))}
      ${stat('Profit (est.)', money(data.totals.profit))}
    </div>
    <section class="panel">
      <div class="panel-head"><h2>Payments</h2>${stripe.connected ? `<span class="status ok">● Stripe ${esc(stripe.mode)} mode</span>` : '<span class="status pending">◌ Not connected</span>'}</div>
      ${stripe.connected
        ? `<p class="muted">Connected${stripe.account ? ` to <b>${esc(stripe.account)}</b>` : ''} on ${formatDate(stripe.connectedAt)}. ${stripe.mode === 'test' ? 'Test mode: pay with card 4242 4242 4242 4242 to try the whole checkout. Test orders are refunded automatically and never buy a real domain.' : 'Live mode: customers are charged for real and domains are registered.'}</p>`
        : '<p class="muted">Customers can search and see prices, but checkout stays closed until Stripe is connected.</p>'}
      ${isSuper ? `
        <form class="row" data-form="admin-stripe">
          <input class="grow mono" name="secretKey" type="password" autocomplete="off" placeholder="${stripe.connected ? 'Paste a new key to replace it' : 'Stripe secret key (sk_live_… or sk_test_…)'}" aria-label="Stripe secret key" required />
          <button class="btn primary" type="submit">${stripe.connected ? 'Replace key' : 'Connect Stripe'}</button>
          ${stripe.connected ? '<button class="btn danger" type="button" data-action="admin-stripe-disconnect">Disconnect</button>' : ''}
        </form>
        <p class="muted small">Find it in Stripe → Developers → API keys. Lyrcloud stores it in AWS Secrets Manager and registers its own webhook.</p>` : ''}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Commission</h2></div>
      <form class="stack" data-form="admin-domain-pricing">
        <div class="field-grid">
          <label class="field">Commission (%)<input name="percent" type="number" min="0" max="500" step="0.1" value="${config.percent}"${lock} /></label>
          <label class="field">Plus flat fee ($ per year)<input name="flat" type="number" min="0" step="0.01" value="${(config.flatCents / 100).toFixed(2)}"${lock} /></label>
          <label class="field">DNS hosting cost ($ per year)<input name="dns" type="number" min="0" step="0.01" value="${(config.dnsCentsPerYear / 100).toFixed(2)}"${lock} /></label>
          <label class="field">name.${esc(pricing.subdomains?.zone || 'lyr.cloud')} price ($ per year)${pricing.subdomains?.enabled ? '' : ' · <span class="muted">off until registered</span>'}<input name="subdomain" type="number" min="0.5" step="0.01" value="${((config.subdomainCents ?? 499) / 100).toFixed(2)}"${lock} /></label>
          <label class="field">…free on plans (comma separated)<input name="subdomainFree" value="${esc((config.subdomainFreePlans || []).join(', '))}"${lock} /></label>
          <label class="check-row"><input type="checkbox" name="round99"${config.round99 ? ' checked' : ''}${lock} /> Round prices up to .99</label>
        </div>
        <label class="field">TLDs for sale (comma separated)<input name="tlds" class="mono" value="${esc(config.tlds.join(', '))}"${lock} /></label>
        <label class="field">Per-TLD commission (one per line, e.g. “io 5% +2.00”)<textarea name="overrides" rows="3" class="mono"${lock}>${esc(overridesText(config.overrides))}</textarea></label>
        ${isSuper ? '<div class="row"><button class="btn primary" type="submit">Save prices</button></div>' : '<p class="muted">Only the super admin can change prices.</p>'}
      </form>
      <p class="muted small">Price = (registrar cost + DNS hosting) × (1 + commission) + flat fee. Domains are bought from DNA, paid from Lyrcloud’s prepaid DNA balance, and DNA hosts their DNS for free; transfers keep their own DNS, so they never include it. Stripe’s fee is paid out of the commission.</p>
      <div class="table-scroll"><table class="table">
        <thead><tr><th>TLD</th><th>Your cost</th><th>Register</th><th>Renew</th><th>Transfer</th><th>Card fee</th><th>Margin / yr</th></tr></thead>
        <tbody>${pricing.tlds.map((row) => `<tr${row.sold ? '' : ' class="muted"'}>
          <td class="mono">.${esc(row.tld)}${row.sold ? '' : ' <small>(no registrar price)</small>'}</td>
          <td>${money(row.cost.register)}</td><td><b>${money(row.register)}</b></td><td>${money(row.renew)}</td><td>${money(row.transfer)}</td>
          <td>${money(row.fee)}</td><td>${Number.isFinite(row.register) ? money(row.register - row.cost.register - row.fee) : '—'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>
    ${adminLyrPanel(isSuper)}
    <section class="panel">
      <div class="panel-head"><h2>All domains</h2><span class="muted">${data.domains.length}</span></div>
      ${data.domains.length ? `<div class="table-scroll"><table class="table">
        <thead><tr><th>Domain</th><th>Owner</th><th>Status</th><th>Expires</th><th>Auto-renew</th></tr></thead>
        <tbody>${data.domains.map((item) => `<tr><td><a class="link mono" href="#/domains/${encodeURIComponent(item.domain)}">${esc(item.domain)}</a></td><td>${esc(item.ownerEmail || '—')}</td><td>${domainStatus(item.status)}</td><td>${shortDate(item.expiresAt)}</td><td>${item.autoRenew ? 'On' : 'Off'}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No domains sold yet.</p>'}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Recent payments</h2></div>
      ${data.orders.length ? `<div class="table-scroll"><table class="table">
        <thead><tr><th>Date</th><th>Domain</th><th>What</th><th>Paid</th><th>Cost</th><th>Status</th></tr></thead>
        <tbody>${data.orders.map((order) => `<tr><td>${shortDate(order.createdAt)}</td><td class="mono">${esc(order.domain)}</td><td>${esc(order.action)}${order.auto ? ' (auto)' : ''} · ${order.years} yr</td><td>${money(order.amount)}</td><td>${money(order.cost)}</td><td>${esc(order.status)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No payments yet.</p>'}
    </section>`;
}

// ---- actions

// The DNS editor serves both registered domains and name.lyr.cloud subdomains.
const recordTarget = () => (currentRoute.view === 'subdomain'
  ? { base: `/domains/subdomains/${encodeURIComponent(currentRoute.label)}`, records: domains.sub?.records, reload: () => loadSubdomain(currentRoute.label) }
  : { base: `/domains/${encodeURIComponent(currentRoute.domain)}`, records: domains.detail?.records, reload: () => loadDomainDetail(currentRoute.domain) });
const recordFor = (type, label) => recordTarget().records?.find((record) => record.type === type && record.label === label);

// ---- .lyr registry (preview): names Lyrcloud answers for itself through its own DNS resolver.

// Records as editable lines: "@ A 203.0.113.10", "www CNAME target.example.net ttl=60".
function lyrRecordLines(entry) {
  return (entry.records || []).flatMap((record) => {
    const label = record.name === entry.name ? '@' : record.name.slice(0, -(entry.name.length + 1));
    return record.values.map((value) => `${label} ${record.type} ${record.type === 'TXT' ? `"${value}"` : value}${record.ttl && record.ttl !== 300 ? ` ttl=${record.ttl}` : ''}`);
  }).join('\n');
}

function parseLyrRecords(text) {
  const sets = new Map();
  for (const raw of String(text).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))) {
    const match = raw.match(/^(\S+)\s+(A|AAAA|CNAME|MX|TXT)\s+(.+?)(?:\s+ttl=(\d+))?$/i);
    if (!match) throw new Error(`Couldn’t read “${raw}”. Use lines like “@ A 203.0.113.10”.`);
    const [, name, type, value, ttl] = match;
    const key = `${name.toLowerCase()}|${type.toUpperCase()}`;
    const set = sets.get(key) || { name: name.toLowerCase(), type: type.toUpperCase(), values: [], ttl: ttl ? Number(ttl) : 300 };
    set.values.push(type.toUpperCase() === 'TXT' ? value.replace(/^"([\s\S]*)"$/, '$1') : value);
    if (ttl) set.ttl = Number(ttl);
    sets.set(key, set);
  }
  return [...sets.values()];
}

function adminLyrPanel(isSuper) {
  const names = adminDomains.lyr || [];
  return `
    <section class="panel">
      <div class="panel-head"><h2>.lyr names</h2><span class="status pending">◌ Preview · not for sale</span></div>
      <p class="muted small">.lyr is Lyrcloud’s own extension. It isn’t an ICANN TLD, so these names only open on devices using Lyrcloud DNS (see <a href="/lyr/" target="_blank" rel="noopener">lyrcloud.com/lyr</a>). Changes are live within a minute.</p>
      ${names.length ? `<div class="table-scroll"><table class="table">
        <thead><tr><th>Name</th><th>Records</th><th>Owner</th><th></th></tr></thead>
        <tbody>${names.map((entry) => `<tr>
          <td class="mono"><b>${esc(entry.name)}</b>${entry.note ? `<div class="muted small">${esc(entry.note)}</div>` : ''}</td>
          <td class="mono wrap small">${esc(lyrRecordLines(entry)).replace(/\n/g, '<br>') || '<span class="muted">none</span>'}</td>
          <td>${esc(entry.owner || '—')}</td>
          <td class="row tight">${isSuper ? `<button class="btn small" data-action="lyr-edit" data-name="${esc(entry.name)}">Edit</button><button class="btn small danger" data-action="lyr-delete" data-name="${esc(entry.name)}">Delete</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No .lyr names yet.</p>'}
      <h3 class="domain-subhead">Waitlist${adminDomains.lyrReservations?.length ? ` (${adminDomains.lyrReservations.length})` : ''}</h3>
      ${adminDomains.lyrReservations?.length ? `<div class="table-scroll"><table class="table"><thead><tr><th>Name</th><th>Reserved by</th><th>Since</th></tr></thead><tbody>${adminDomains.lyrReservations.map((item) => `<tr><td class="mono">${esc(item.name)}</td><td>${esc(item.ownerEmail || '—')}</td><td>${shortDate(item.createdAt)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Nobody has reserved a .lyr name yet.</p>'}
      ${isSuper ? `
        <form class="stack" data-form="admin-lyr-save" id="lyr-form">
          <div class="field-grid">
            <label class="field">Name<input name="name" class="mono" placeholder="hello.lyr" required autocomplete="off" /></label>
            <label class="field">Owner email (optional)<input name="owner" type="email" autocomplete="off" /></label>
            <label class="field">Note (optional)<input name="note" maxlength="300" /></label>
          </div>
          <label class="field">Records, one per line<textarea name="records" rows="4" class="mono" placeholder="@ A 203.0.113.10&#10;www CNAME mysite.lyrcloud.app&#10;@ TXT &quot;hello from .lyr&quot;"></textarea></label>
          <div class="row"><button class="btn primary" type="submit">Save .lyr name</button><span class="muted small">Saving an existing name replaces its records.</span></div>
        </form>` : '<p class="muted">Only the super admin can add .lyr names.</p>'}
    </section>`;
}

const domainClickActions = {
  'subdomain-release': async (target) => {
    if (!confirmed(target, `Release ${domains.sub.subdomain.name}? Its DNS records are deleted and anyone can claim it.`)) return;
    target.disabled = true;
    try {
      await domainsApi(`/domains/subdomains/${encodeURIComponent(currentRoute.label)}`, { method: 'DELETE' });
      toast(`${domains.sub.subdomain.name} released`);
      domains.data = null;
      go('#/domains');
    } catch (error) {
      target.disabled = false;
      toast(error.message);
    }
  },
  'lyr-unreserve': async (target) => {
    if (!confirmed(target, `Give up ${target.dataset.name}? Someone else can reserve it.`)) return;
    target.disabled = true;
    try {
      await domainsApi(`/domains/lyr-waitlist/${encodeURIComponent(target.dataset.name)}`, { method: 'DELETE' });
      domains.data.lyrReservations = domains.data.lyrReservations.filter((item) => item.name !== target.dataset.name);
      render();
      toast(`${target.dataset.name} released`);
    } catch (error) {
      target.disabled = false;
      toast(error.message);
    }
  },
  'lyr-edit': (target) => {
    const entry = adminDomains.lyr?.find((item) => item.name === target.dataset.name);
    const form = document.getElementById('lyr-form');
    if (!entry || !form) return;
    form.elements.name.value = entry.name;
    form.elements.owner.value = entry.owner || '';
    form.elements.note.value = entry.note || '';
    form.elements.records.value = lyrRecordLines(entry);
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.elements.records.focus();
  },
  'lyr-delete': async (target) => {
    if (!confirmed(target, `Delete ${target.dataset.name}? It stops resolving right away.`)) return;
    target.disabled = true;
    try {
      await domainsApi(`/admin/lyr/${encodeURIComponent(target.dataset.name)}`, { method: 'DELETE' });
      adminDomains.lyr = adminDomains.lyr.filter((item) => item.name !== target.dataset.name);
      render();
      toast(`${target.dataset.name} deleted`);
    } catch (error) {
      target.disabled = false;
      toast(error.message);
    }
  },
  'domains-retry': () => {
    domains.error = '';
    domains.data = null;
    render();
  },
  'domain-search-again': (target) => searchDomains(target.dataset.q),
  'record-edit': (target) => {
    const record = recordFor(target.dataset.type, target.dataset.name);
    const form = document.getElementById('record-form');
    if (!record || !form) return;
    form.elements.type.value = record.type;
    form.elements.name.value = record.label;
    form.elements.values.value = record.values.join('\n');
    form.elements.values.rows = Math.min(6, record.values.length);
    if ([...form.elements.ttl.options].some((option) => Number(option.value) === record.ttl)) form.elements.ttl.value = String(record.ttl);
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.elements.values.focus();
  },
  'record-delete': async (target) => {
    if (!confirmed(target, `Delete the ${target.dataset.type} record for ${target.dataset.name}?`)) return;
    target.disabled = true;
    try {
      const where = recordTarget();
      await domainsApi(`${where.base}/records?type=${encodeURIComponent(target.dataset.type)}&name=${encodeURIComponent(target.dataset.name)}`, { method: 'DELETE' });
      toast('Record deleted');
      where.reload();
    } catch (error) {
      target.disabled = false;
      toast(error.message);
    }
  },
  'admin-stripe-disconnect': async (target) => {
    if (!confirmed(target, 'Disconnect Stripe? Checkout closes and auto-renewals stop charging until you connect again.')) return;
    target.disabled = true;
    try {
      await domainsApi('/admin/stripe', { method: 'DELETE' });
      toast('Stripe disconnected');
      loadAdminDomains();
    } catch (error) {
      target.disabled = false;
      toast(error.message);
    }
  },
};

const domainChangeActions = {
  'subdomain-autorenew': async (target) => {
    target.disabled = true;
    try {
      const { subdomain } = await domainsApi(`/domains/subdomains/${encodeURIComponent(currentRoute.label)}`, { method: 'PUT', body: JSON.stringify({ autoRenew: target.checked }) });
      domains.sub.subdomain = subdomain;
      toast(`Auto-renew ${target.checked ? 'on' : 'off'}`);
    } catch (error) {
      target.checked = !target.checked;
      toast(error.message);
    }
    target.disabled = false;
  },
  'domain-verify-email': async (target) => {
    target.disabled = true;
    try {
      const result = await domainsApi(`/domains/${encodeURIComponent(currentRoute.domain)}/verify-email`, { method: 'POST' });
      toast(result.verified ? 'Already confirmed — nothing to send.' : 'Sent. Check the inbox, and the spam folder.');
    } catch (error) {
      toast(error.message);
    }
    target.disabled = false;
  },
  'domain-autorenew': async (target) => {
    target.disabled = true;
    try {
      const { domain } = await domainsApi(`/domains/${encodeURIComponent(currentRoute.domain)}`, { method: 'PUT', body: JSON.stringify({ autoRenew: target.checked }) });
      domains.detail.domain = { ...domains.detail.domain, ...domain };
      toast(`Auto-renew ${target.checked ? 'on' : 'off'}`);
    } catch (error) {
      target.checked = !target.checked;
      toast(error.message);
    }
    target.disabled = false;
  },
  'domain-years': (target) => {
    const tld = target.form.elements.domain.value.split('.').slice(1).join('.');
    const price = domains.prices?.[tld];
    const node = document.getElementById('domain-total');
    if (price && node) node.textContent = ` · ${money(price.register + price.renew * (Number(target.value) - 1))}`;
  },
};

const domainFormActions = {
  'subdomain-claim': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    const label = String(data.get('label') || '').trim().toLowerCase();
    button.disabled = true;
    try {
      const result = await domainsApi('/domains/subdomains', { method: 'POST', body: JSON.stringify({ label }) });
      if (result.url) {
        location.href = result.url;
        return;
      }
      domains.data = null;
      toast(`${result.subdomain.name} is yours`);
      go(`#/domains/sub/${encodeURIComponent(result.subdomain.label)}`);
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
  'lyr-reserve': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    const name = String(data.get('name') || '').trim().toLowerCase();
    button.disabled = true;
    try {
      const { reservation } = await domainsApi('/domains/lyr-waitlist', { method: 'POST', body: JSON.stringify({ name }) });
      const list = domains.data.lyrReservations.filter((item) => item.name !== reservation.name);
      domains.data.lyrReservations = [...list, { createdAt: new Date().toISOString(), ...reservation }];
      render();
      toast(`${reservation.name} is reserved for you`);
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
  'admin-lyr-save': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    const name = String(data.get('name') || '').trim().toLowerCase().replace(/\.lyr$/, '');
    let records;
    try {
      records = parseLyrRecords(data.get('records'));
    } catch (error) {
      return toast(error.message);
    }
    button.disabled = true;
    try {
      const { name: saved } = await domainsApi(`/admin/lyr/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify({ records, owner: String(data.get('owner') || '').trim() || null, note: String(data.get('note') || '').trim() || null }),
      });
      adminDomains.lyr = [...(adminDomains.lyr || []).filter((item) => item.name !== saved.name), saved].sort((a, b) => a.name.localeCompare(b.name));
      render();
      toast(`${saved.name} saved`);
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
  'domain-search': (form, data) => {
    const q = String(data.get('q') || '').trim();
    if (q) searchDomains(q);
  },
  'domain-transfer-start': (form, data) => {
    const domain = String(data.get('domain') || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+\.[a-z]{2,63}$/.test(domain)) return toast('Enter a domain like example.com');
    go(`#/domains/buy?domain=${encodeURIComponent(domain)}&action=transfer`);
  },
  'domain-checkout': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    const action = String(data.get('action'));
    const contact = Object.fromEntries(['firstName', 'lastName', 'organization', 'email', 'phoneCountry', 'phone', 'address1', 'address2', 'city', 'state', 'zip', 'country']
      .map((key) => [key, String(data.get(key) || '').trim()]).filter(([, value]) => value));
    const body = {
      action,
      domain: String(data.get('domain')),
      years: action === 'register' ? Number(data.get('years')) : 1,
      autoRenew: data.get('autoRenew') === 'on',
      contact,
      ...(action === 'transfer' ? { authCode: String(data.get('authCode') || '').trim() } : {}),
    };
    button.disabled = true;
    const label = button.innerHTML;
    button.textContent = 'Opening secure payment…';
    try {
      const { url } = await domainsApi('/domains/checkout', { method: 'POST', body: JSON.stringify(body) });
      domains.data = null; // the hold and saved contact show up when they come back
      location.href = url;
    } catch (error) {
      button.disabled = false;
      button.innerHTML = label;
      showFormError(form, error.message);
    }
  },
  'domain-renew': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { url } = await domainsApi('/domains/checkout', { method: 'POST', body: JSON.stringify({ action: 'renew', domain: currentRoute.domain, years: Number(data.get('years')) }) });
      location.href = url;
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
  'record-save': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    const record = {
      type: String(data.get('type')),
      name: String(data.get('name') || '@').trim(),
      values: String(data.get('values') || '').split('\n').map((value) => value.trim()).filter(Boolean),
      ttl: Number(data.get('ttl')),
    };
    button.disabled = true;
    try {
      const where = recordTarget();
      await domainsApi(`${where.base}/records`, { method: 'PUT', body: JSON.stringify(record) });
      toast(`${record.type} record saved`);
      where.reload();
    } catch (error) {
      button.disabled = false;
      showFormError(form, error.message);
    }
  },
  'admin-stripe': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const result = await domainsApi('/admin/stripe', { method: 'PUT', body: JSON.stringify({ secretKey: String(data.get('secretKey')).trim() }) });
      toast(`Stripe connected in ${result.mode} mode`);
      loadAdminDomains();
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
  'admin-domain-pricing': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    let body;
    try {
      body = {
        percent: Number(data.get('percent')),
        flatCents: Math.round(Number(data.get('flat')) * 100),
        dnsCentsPerYear: Math.round(Number(data.get('dns')) * 100),
        round99: data.get('round99') === 'on',
        tlds: String(data.get('tlds')).split(/[\s,]+/).map((tld) => tld.replace(/^\./, '').toLowerCase()).filter(Boolean),
        overrides: parseOverrides(data.get('overrides')),
        subdomainCents: Math.round(Number(data.get('subdomain')) * 100),
        subdomainFreePlans: String(data.get('subdomainFree') || '').split(/[\s,]+/).map((plan) => plan.toLowerCase()).filter(Boolean),
      };
    } catch (error) {
      return toast(error.message);
    }
    button.disabled = true;
    try {
      adminDomains.pricing = await domainsApi('/admin/domain-pricing', { method: 'PUT', body: JSON.stringify(body) });
      domains.prices = null;
      domains.pricesTried = false;
      render();
      toast('Domain prices saved');
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
};

adminTabs.domains = adminDomainsTab;

// ------------------------------------------------------------------ Lyrcloud Cloud

// Real: clusters and services are built with CloudFormation in the customer's own AWS account, through
// the LyrcloudAccess role they create. The region map covers every major provider (src/clouds.js).
const cloudApi = (path, options) => api(path, options, CLOUD_API_BASE);
const CLOUD_ENABLED = !CLOUD_API_BASE.endsWith('.invalid');
const isCloudView = (view) => view === 'cloud' || view === 'cloud-cluster';

const cloud = { data: null, error: '', loading: false, detail: null, detailError: '', detailFor: null, loadingDetail: false, editing: null, timer: null };
const adminCloud = { data: null, error: '', loading: false };

const usd = (value) => (Number.isFinite(value) ? `$${value.toFixed(2)}` : '—');
const CLOUD_BUSY = ['creating', 'updating', 'deleting'];
const CLOUD_STATUS = {
  creating: ['pending', 'Creating…'], updating: ['pending', 'Updating…'], deleting: ['pending', 'Deleting…'],
  ready: ['ok', 'Ready'], failed: ['bad', 'Failed'], delete_failed: ['bad', 'Couldn’t delete'], deleted: ['bad', 'Deleted'],
};
const cloudStatus = (status) => {
  const [cls, label] = CLOUD_STATUS[status] || ['pending', status];
  return `<span class="status ${cls}">${cls === 'ok' ? '●' : cls === 'bad' ? '✕' : '◌'} ${esc(label)}</span>`;
};
const regionLabel = (provider, code) => {
  const region = findRegion(provider, code);
  return region ? `${region.city} · <span class="mono">${esc(code)}</span>` : `<span class="mono">${esc(code)}</span>`;
};
const estimateLines = (estimate) => `
  <ul class="estimate-lines">${estimate.lines.map(([label, value]) => `<li><span>${esc(label)}</span><b>${usd(value)}</b></li>`).join('')}
    <li class="estimate-total"><span>About per month</span><b>${usd(estimate.monthly)}</b></li></ul>`;

async function loadCloud() {
  cloud.loading = true;
  try {
    cloud.data = await cloudApi('/cloud');
    cloud.error = '';
  } catch (error) {
    cloud.error = error.message;
  }
  cloud.loading = false;
  if (isCloudView(currentRoute?.view)) render();
}

async function loadCloudCluster(id) {
  cloud.loadingDetail = true;
  cloud.detailFor = id;
  try {
    cloud.detail = await cloudApi(`/cloud/clusters/${encodeURIComponent(id)}`);
    cloud.detailError = '';
  } catch (error) {
    cloud.detail = null;
    cloud.detailError = error.message;
  }
  cloud.loadingDetail = false;
  if (currentRoute?.view === 'cloud-cluster' && currentRoute.clusterId === id) render();
}

function cloudAfterRender(route) {
  if (!CLOUD_ENABLED) return;
  clearTimeout(cloud.timer);
  if (!cloud.data && !cloud.loading && !cloud.error) loadCloud();
  if (route.view === 'cloud-cluster' && (cloud.detailFor !== route.clusterId || (!cloud.detail && !cloud.detailError)) && !cloud.loadingDetail) loadCloudCluster(route.clusterId);
  // CloudFormation takes minutes; refresh while anything is changing.
  const busy = route.view === 'cloud-cluster'
    ? cloud.detail && (CLOUD_BUSY.includes(cloud.detail.cluster.status) || cloud.detail.services.some((s) => CLOUD_BUSY.includes(s.status)))
    : cloud.data?.clusters.some((c) => CLOUD_BUSY.includes(c.status));
  if (busy) {
    cloud.timer = setTimeout(() => {
      if (currentRoute.view === 'cloud-cluster') loadCloudCluster(currentRoute.clusterId);
      else if (currentRoute.view === 'cloud') loadCloud();
    }, 15_000);
  }
  updateClusterEstimate();
}

function regionOptions() {
  const aws = REGIONS.filter((region) => region.provider === 'aws');
  return CONTINENT_NAMES.map((continent) => {
    const here = aws.filter((region) => continentOf(region.country) === continent);
    return here.length ? `<optgroup label="${esc(continent)}">${here.map((region) => `<option value="${region.code}"${region.code === 'us-east-1' ? ' selected' : ''}>${esc(region.city)} (${region.code})${region.optIn ? ' · opt-in' : ''}</option>`).join('')}</optgroup>` : '';
  }).join('');
}

function connectionPanel(connection) {
  if (!connection) {
    return `
      <section class="panel">
        <div class="panel-head"><h2>Connect your AWS account</h2></div>
        <p class="muted">Lyrcloud builds clusters in <b>your</b> AWS account, so you own them and AWS bills you directly. You create one role that lets Lyrcloud in; delete it any time to cut access.</p>
        <button class="btn primary" data-action="cloud-connect">Connect AWS</button>
      </section>`;
  }
  if (connection.status === 'connected') {
    return `
      <section class="panel">
        <div class="panel-head"><h2>AWS account</h2><span class="status ok">● Connected</span></div>
        ${settingRow('Account', `Lyrcloud signs in through the <span class="mono">LyrcloudAccess</span> role with your connection ID.`, `<span class="mono">${esc(connection.accountId)}</span>`)}
        ${settingRow('Disconnect', 'Delete your clusters first. To cut access completely, also delete the lyrcloud-access stack in your AWS account.', '<button class="btn" data-action="cloud-disconnect">Disconnect</button>')}
      </section>`;
  }
  return `
    <section class="panel">
      <div class="panel-head"><h2>Connect your AWS account</h2><span class="status pending">◌ Waiting for you</span></div>
      <ol class="steps-list">
        <li><b>Create the access role.</b> <a class="btn small primary" href="${esc(connection.launchUrl)}" target="_blank" rel="noopener">Open AWS setup ↗</a><br>
          <span class="muted small">Sign in to your AWS account, tick “I acknowledge that AWS CloudFormation might create IAM resources with custom names”, and click <b>Create stack</b>. Your connection ID <code>${esc(connection.externalId)}</code> is already filled in.</span></li>
        <li><b>Paste the role here</b> once the stack says CREATE_COMPLETE: its <b>Outputs</b> tab shows <span class="mono">RoleArn</span>, or just enter your 12-digit account ID.
          <form class="row" data-form="cloud-connect-finish">
            <input class="grow mono" name="roleArn" placeholder="arn:aws:iam::123456789012:role/LyrcloudAccess" required autocomplete="off" />
            <button class="btn primary" type="submit">Connect</button>
          </form>
        </li>
      </ol>
      <p class="muted small">What the role can do: create and manage EKS, ECS, VPC, load balancer and log resources, and IAM roles named <span class="mono">lyrcloud-*</span> only. It trusts Lyrcloud’s AWS account, and only with your connection ID.</p>
    </section>`;
}

function clusterForm() {
  return `
    <section class="panel">
      <div class="panel-head"><h2>Create a cluster</h2></div>
      <form class="stack" data-form="cloud-create-cluster" id="cluster-form">
        <div class="field-grid">
          <label class="field">Name<input name="name" placeholder="prod" required pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]" maxlength="32" autocomplete="off" /></label>
          <label class="field">Provider<select name="provider">${PROVIDERS.map((provider) => `<option value="${provider.id}"${provider.provisioning ? '' : ' disabled'}>${esc(provider.name)}${provider.provisioning ? '' : ' (coming soon)'}</option>`).join('')}</select></label>
          <label class="field">Region<select name="region">${regionOptions()}</select></label>
        </div>
        <div class="plan-options cluster-kinds">
          <label class="plan-option"><input type="radio" name="kind" value="serverless" checked data-action="cloud-estimate" /><span><b>Serverless containers</b><small>ECS on Fargate. Pay only for running containers; Lyrcloud deploys your images with a load balancer.</small></span></label>
          <label class="plan-option"><input type="radio" name="kind" value="kubernetes" data-action="cloud-estimate" /><span><b>Kubernetes</b><small>Amazon EKS with worker nodes. Full Kubernetes; you deploy with kubectl or Helm.</small></span></label>
        </div>
        <fieldset class="contact-fields kube-only" hidden>
          <legend>Kubernetes</legend>
          <div class="field-grid">
            <label class="field">Worker size<select name="nodeType" data-action="cloud-estimate">${Object.entries(NODE_TYPES).map(([type, spec]) => `<option value="${type}"${type === 't3.medium' ? ' selected' : ''}>${type} · ${spec.vcpu} vCPU · ${spec.memory} GB</option>`).join('')}</select></label>
            <label class="field">Workers<input name="nodes" type="number" min="1" max="20" value="2" data-action="cloud-estimate" /></label>
          </div>
          <label class="field">Cluster admin (your IAM user or role ARN)<input name="adminArn" class="mono" placeholder="arn:aws:iam::123456789012:user/you" autocomplete="off" /></label>
          <p class="muted small">Find it with <code>aws sts get-caller-identity</code>. This identity gets kubectl admin access.</p>
        </fieldset>
        <div class="estimate" id="cluster-estimate"></div>
        <p class="form-error" hidden></p>
        <div class="row"><button class="btn primary" type="submit">Create cluster</button><span class="muted small">Takes 1 minute for serverless, about 15 for Kubernetes. AWS bills your account.</span></div>
      </form>
    </section>`;
}

function updateClusterEstimate() {
  const form = document.getElementById('cluster-form');
  const box = document.getElementById('cluster-estimate');
  if (!form || !box) return;
  const kind = form.elements.kind.value;
  form.querySelector('.kube-only').hidden = kind !== 'kubernetes';
  const estimate = clusterEstimate({ kind, nodeType: form.elements.nodeType.value, nodes: Math.max(1, Math.min(20, Number(form.elements.nodes.value) || 1)) });
  box.innerHTML = kind === 'serverless'
    ? `<p class="muted small">The cluster itself is free. Each service costs about ${usd(serviceEstimate({ size: 'small', count: 1 }).monthly)}/month at the smallest size (one container plus its load balancer).</p>`
    : `${estimateLines(estimate)}<p class="muted small">Estimate for us-east-1; other regions cost up to about 40% more. Data transfer is extra.</p>`;
}

function cloudView() {
  if (!CLOUD_ENABLED) return views.missing();
  const data = cloud.data;
  const clusters = data?.clusters || [];
  const highlight = new Set(clusters.map((c) => `${c.provider}:${c.region}`));
  return `
    ${pageHead('Cloud', `Container clusters in ${REGIONS.length} regions of ${PROVIDERS.length} clouds, run in your own account.`)}
    ${cloud.error ? `<section class="panel"><p class="form-error">${esc(cloud.error)}</p><button class="btn" data-action="cloud-retry">Try again</button></section>` : ''}
    <section class="panel">
      <div class="panel-head"><h2>Data centers</h2><span class="muted">${clusters.length ? 'Rings show your clusters' : `Regions as of ${CATALOG_DATE}`}</span></div>
      <div class="cloud-map dash-map">${worldMapSvg(REGIONS, { highlight })}</div>
      <div class="provider-legend">${PROVIDERS.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.name)} <small>${p.regions.length}${p.provisioning ? '' : ' · soon'}</small></span>`).join('')}</div>
    </section>
    ${!data ? '<section class="panel"><p class="muted">Loading…</p></section>' : `
      ${connectionPanel(data.connection)}
      <section class="panel">
        <div class="panel-head"><h2>Your clusters</h2>${clusters.length ? `<span class="muted">${clusters.length}</span>` : ''}</div>
        ${clusters.length ? `<div class="table-scroll"><table class="table">
          <thead><tr><th>Name</th><th>Region</th><th>Type</th><th>Status</th><th>About / month</th></tr></thead>
          <tbody>${clusters.map((c) => `<tr>
            <td><a class="link mono" href="#/cloud/clusters/${c.id}">${esc(c.name)}</a></td>
            <td>${regionLabel(c.provider, c.region)}</td>
            <td>${c.kind === 'kubernetes' ? `Kubernetes · ${c.nodes} × ${esc(c.nodeType)}` : 'Serverless'}</td>
            <td>${cloudStatus(c.status)}</td>
            <td>${usd(c.estimate.monthly)}${c.kind === 'serverless' ? ' + services' : ''}</td>
          </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No clusters yet.</p>'}
      </section>
      ${data.connection?.status === 'connected' ? clusterForm() : ''}
      <section class="panel">
        <div class="panel-head"><h2>Other clouds</h2></div>
        <p class="muted">Their regions are on the map now. Connecting an account and building clusters there is next.</p>
        <div class="provider-legend">${PROVIDERS.filter((p) => !p.provisioning).map((p) => `<span><i style="background:${p.color}"></i>${esc(p.fullName)} <small>coming soon</small></span>`).join('')}</div>
      </section>`}`;
}

function serviceRow(service) {
  const editing = cloud.editing === service.id;
  return `
    <li class="service-card">
      <div class="service-main">
        <div><b class="mono">${esc(service.name)}</b> ${cloudStatus(service.status)}<div class="muted small mono">${esc(service.image)} · port ${service.port} · ${service.count} × ${esc(SERVICE_SIZES[service.size]?.label || service.size)}</div>
          ${service.url ? `<a class="link" href="${esc(service.url)}" target="_blank" rel="noopener">${esc(service.url)} ↗</a>` : ''}
          ${service.failureReason ? `<p class="form-error">${esc(service.failureReason)}</p>` : ''}</div>
        <div class="row tight"><span class="muted small">≈ ${usd(service.estimate.monthly)}/mo</span>
          <button class="btn small" data-action="cloud-edit-service" data-id="${service.id}"${CLOUD_BUSY.includes(service.status) ? ' disabled' : ''}>${editing ? 'Close' : 'Change'}</button>
          <button class="btn small danger" data-action="cloud-delete-service" data-id="${service.id}"${service.status === 'deleting' ? ' disabled' : ''}>Remove</button></div>
      </div>
      ${editing ? serviceForm(service) : ''}
    </li>`;
}

const envText = (env) => Object.entries(env || {}).map(([key, value]) => `${key}=${value}`).join('\n');

function serviceForm(service) {
  const edit = Boolean(service);
  return `
    <form class="stack service-form" data-form="${edit ? 'cloud-update-service' : 'cloud-create-service'}"${edit ? ` data-id="${service.id}"` : ''}>
      <div class="field-grid">
        ${edit ? '' : '<label class="field">Name<input name="name" placeholder="web" required pattern="[a-z][a-z0-9-]{1,30}[a-z0-9]" maxlength="32" autocomplete="off" /></label>'}
        <label class="field">Container image<input name="image" class="mono" placeholder="nginx:latest or ghcr.io/you/app:1.0" value="${esc(service?.image || '')}" required autocomplete="off" /></label>
        <label class="field">Port<input name="port" type="number" min="1" max="65535" value="${service?.port ?? 80}" /></label>
        <label class="field">Size<select name="size">${Object.entries(SERVICE_SIZES).map(([id, size]) => `<option value="${id}"${id === (service?.size || 'small') ? ' selected' : ''}>${size.label}</option>`).join('')}</select></label>
        <label class="field">Copies<input name="count" type="number" min="0" max="20" value="${service?.count ?? 1}" /></label>
        <label class="field">Health check path<input name="healthPath" value="${esc(service?.healthPath || '/')}" /></label>
      </div>
      <label class="field">Environment variables (NAME=value, one per line)<textarea name="env" rows="3" class="mono">${esc(envText(service?.env))}</textarea></label>
      <div class="row"><button class="btn primary" type="submit">${edit ? 'Redeploy' : 'Deploy'}</button><span class="muted small">Public images (Docker Hub, GHCR, ECR Public) and private ECR images in your account work.</span></div>
    </form>`;
}

function cloudClusterView(route) {
  if (!CLOUD_ENABLED) return views.missing();
  const id = route.clusterId;
  if (cloud.detailError && cloud.detailFor === id) return `${pageHead('Cluster')}<section class="panel"><p class="form-error">${esc(cloud.detailError)}</p><a class="btn" href="#/cloud">All clusters</a></section>`;
  const detail = cloud.detailFor === id ? cloud.detail : null;
  if (!detail) return `${pageHead('Cluster')}<section class="panel"><p class="muted">Loading…</p></section>`;
  const { cluster, services } = detail;
  const ready = cluster.status === 'ready';
  const kube = cluster.kind === 'kubernetes';
  return `
    ${pageHead(`<span class="mono">${esc(cluster.name)}</span>`, `${cloudStatus(cluster.status)} · ${kube ? 'Kubernetes (EKS)' : 'Serverless (ECS Fargate)'} · ${regionLabel(cluster.provider, cluster.region)}`, '<a class="btn" href="#/cloud">All clusters</a>')}
    ${cluster.status === 'creating' ? `<section class="panel callout"><p>Building in your AWS account… ${kube ? 'Kubernetes clusters take about 15 minutes.' : 'This takes about a minute.'} This page updates by itself.</p></section>` : ''}
    ${cluster.failureReason ? `<section class="panel"><p class="form-error">${esc(cluster.failureReason)}</p>${cluster.status === 'failed' ? '<p class="muted small">Nothing keeps running from a failed cluster; delete it to try again with the same name.</p>' : ''}</section>` : ''}
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>Cost estimate</h2></div>
        ${estimateLines(cluster.estimate)}
        ${services.length ? `<p class="muted small">Plus services: about ${usd(services.reduce((sum, s) => sum + s.estimate.monthly, 0))}/month.</p>` : ''}
        <p class="muted small">AWS bills your account directly. us-east-1 prices; data transfer extra.</p>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Details</h2></div>
        <dl class="facts">
          <dt>Stack</dt><dd class="mono">${esc(cluster.stackName)}</dd>
          ${cluster.outputs.ClusterName ? `<dt>Cluster</dt><dd class="mono">${esc(cluster.outputs.ClusterName)}</dd>` : ''}
          ${cluster.outputs.VpcId ? `<dt>VPC</dt><dd class="mono">${esc(cluster.outputs.VpcId)}</dd>` : ''}
          ${kube ? `<dt>Admin</dt><dd class="mono wrap">${esc(cluster.adminArn)}</dd>` : ''}
          <dt>Created</dt><dd>${formatDate(cluster.createdAt)}</dd>
        </dl>
      </section>
    </div>
    ${kube && ready ? `
      <section class="panel">
        <div class="panel-head"><h2>Use it with kubectl</h2></div>
        <pre class="preview-output">aws eks update-kubeconfig --region ${esc(cluster.region)} --name ${esc(cluster.outputs.ClusterName || `lyrcloud-${cluster.name}`)}
kubectl get nodes</pre>
        <p class="muted small">Run these as <span class="mono">${esc(cluster.adminArn)}</span>. Services of type LoadBalancer get a public AWS load balancer.</p>
        <form class="row" data-form="cloud-resize"><label class="inline-check">Workers <input name="nodes" type="number" min="1" max="20" value="${cluster.nodes}" /></label><button class="btn" type="submit">Resize</button></form>
      </section>` : ''}
    ${!kube && ready ? `
      <section class="panel">
        <div class="panel-head"><h2>Services</h2><span class="muted">${services.length}</span></div>
        ${services.length ? `<ul class="service-list">${services.map(serviceRow).join('')}</ul>` : '<p class="muted">No services yet. Deploy a container image below.</p>'}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Deploy a container</h2><span class="muted small">≈ ${usd(serviceEstimate({ size: 'small', count: 1 }).monthly)}/month at the smallest size</span></div>
        ${serviceForm(null)}
      </section>` : ''}
    <section class="panel">
      ${settingRow('Delete this cluster', services.length ? 'Remove its services first.' : 'Takes down everything Lyrcloud built for it in your account.', `<button class="btn danger" data-action="cloud-delete-cluster"${services.length || cluster.status === 'deleting' ? ' disabled' : ''}>Delete cluster</button>`)}
    </section>`;
}

// ---- admin

async function loadAdminCloud() {
  adminCloud.loading = true;
  try {
    adminCloud.data = await cloudApi('/admin/cloud');
    adminCloud.error = '';
  } catch (error) {
    adminCloud.error = error.message;
  }
  adminCloud.loading = false;
  if (isAdminView()) render();
}

function adminCloudTab() {
  if (adminCloud.error) return `<section class="panel"><p class="form-error">${esc(adminCloud.error)}</p></section>`;
  if (!adminCloud.data) return '<section class="panel"><p class="muted">Loading…</p></section>';
  const { connections, clusters, services } = adminCloud.data;
  const stat = (label, value) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
  return `
    <div class="stat-grid">
      ${stat('Connected accounts', connections.filter((c) => c.status === 'connected').length)}
      ${stat('Clusters', clusters.length)}
      ${stat('Services', services.length)}
      ${stat('Customer spend (est. / mo)', usd(clusters.reduce((s, c) => s + c.estimate.monthly, 0) + services.reduce((s, v) => s + v.estimate.monthly, 0)))}
    </div>
    <section class="panel">
      <div class="panel-head"><h2>Clusters</h2></div>
      ${clusters.length ? `<div class="table-scroll"><table class="table"><thead><tr><th>Name</th><th>Owner</th><th>Region</th><th>Type</th><th>Status</th></tr></thead>
        <tbody>${clusters.map((c) => `<tr><td><a class="link mono" href="#/cloud/clusters/${c.id}">${esc(c.name)}</a></td><td>${esc(c.ownerEmail || '—')}</td><td>${regionLabel(c.provider, c.region)}</td><td>${esc(c.kind)}</td><td>${cloudStatus(c.status)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">No clusters yet.</p>'}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Connections</h2></div>
      ${connections.length ? `<ul class="recent-list">${connections.map((c) => `<li><b>${esc(c.ownerEmail || '—')}</b> <span class="muted">${c.status}${c.accountId ? ` · ${esc(c.accountId)}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">Nobody has connected a cloud account yet.</p>'}
    </section>`;
}
adminTabs.cloud = adminCloudTab;

// ---- actions

const parseEnv = (text) => {
  const env = {};
  for (const line of String(text || '').split('\n').map((value) => value.trim()).filter(Boolean)) {
    const at = line.indexOf('=');
    if (at < 1) throw new Error(`Write “${line}” as NAME=value.`);
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return env;
};
const serviceBody = (data) => ({
  image: String(data.get('image') || '').trim(),
  port: Number(data.get('port')),
  size: String(data.get('size')),
  count: Number(data.get('count')),
  healthPath: String(data.get('healthPath') || '/').trim() || '/',
  env: parseEnv(data.get('env')),
});
const findCloudService = (id) => cloud.detail?.services.find((s) => s.id === id);

async function cloudRun(target, request, message, after) {
  if (target) target.disabled = true;
  try {
    const result = await request();
    if (message) toast(message);
    await after?.(result);
  } catch (error) {
    if (target) target.disabled = false;
    toast(error.message);
  }
}

const cloudClickActions = {
  'cloud-retry': () => {
    cloud.error = '';
    cloud.data = null;
    render();
  },
  'cloud-connect': (target) => cloudRun(target, () => cloudApi('/cloud/connections/aws', { method: 'POST' }), '', loadCloud),
  'cloud-disconnect': (target) => {
    if (!confirmed(target, 'Disconnect your AWS account from Lyrcloud?')) return;
    cloudRun(target, () => cloudApi('/cloud/connections/aws', { method: 'DELETE' }), 'Disconnected. Delete the lyrcloud-access stack in AWS to remove the role.', loadCloud);
  },
  'cloud-delete-cluster': (target) => {
    if (!confirmed(target, `Delete ${cloud.detail.cluster.name}? Everything Lyrcloud built for it in your AWS account is removed.`)) return;
    cloudRun(target, () => cloudApi(`/cloud/clusters/${currentRoute.clusterId}`, { method: 'DELETE' }), 'Deleting the cluster…', () => { cloud.data = null; return loadCloudCluster(currentRoute.clusterId); });
  },
  'cloud-edit-service': (target) => {
    cloud.editing = cloud.editing === target.dataset.id ? null : target.dataset.id;
    render();
  },
  'cloud-delete-service': (target) => {
    const service = findCloudService(target.dataset.id);
    if (!confirmed(target, `Remove ${service.name}? Its containers and load balancer are deleted.`)) return;
    cloudRun(target, () => cloudApi(`/cloud/services/${service.id}`, { method: 'DELETE' }), `Removing ${service.name}…`, () => loadCloudCluster(currentRoute.clusterId));
  },
};

const cloudChangeActions = {
  'cloud-estimate': () => updateClusterEstimate(),
};

const cloudFormActions = {
  'cloud-connect-finish': (form, data) => cloudRun(form.querySelector('[type="submit"]'),
    () => cloudApi('/cloud/connections/aws', { method: 'PUT', body: JSON.stringify({ roleArn: String(data.get('roleArn')).trim() }) }), 'AWS account connected', loadCloud),
  'cloud-create-cluster': (form, data) => {
    const kind = String(data.get('kind'));
    const body = {
      name: String(data.get('name')).trim().toLowerCase(), provider: String(data.get('provider')), region: String(data.get('region')), kind,
      ...(kind === 'kubernetes' ? { nodeType: String(data.get('nodeType')), nodes: Number(data.get('nodes')), adminArn: String(data.get('adminArn') || '').trim() } : {}),
    };
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    cloudApi('/cloud/clusters', { method: 'POST', body: JSON.stringify(body) }).then(({ cluster }) => {
      cloud.data = null;
      toast(`Building ${cluster.name}…`);
      go(`#/cloud/clusters/${cluster.id}`);
    }, (error) => {
      button.disabled = false;
      showFormError(form, error.message);
    });
  },
  'cloud-resize': (form, data) => cloudRun(form.querySelector('[type="submit"]'),
    () => cloudApi(`/cloud/clusters/${currentRoute.clusterId}`, { method: 'PUT', body: JSON.stringify({ nodes: Number(data.get('nodes')) }) }), 'Resizing…', () => loadCloudCluster(currentRoute.clusterId)),
  'cloud-create-service': (form, data) => {
    let body;
    try {
      body = { name: String(data.get('name')).trim().toLowerCase(), ...serviceBody(data) };
    } catch (error) {
      return toast(error.message);
    }
    cloudRun(form.querySelector('[type="submit"]'), () => cloudApi(`/cloud/clusters/${currentRoute.clusterId}/services`, { method: 'POST', body: JSON.stringify(body) }),
      `Deploying ${body.name}… load balancers take about 5 minutes`, () => loadCloudCluster(currentRoute.clusterId));
  },
  'cloud-update-service': (form, data) => {
    let body;
    try {
      body = serviceBody(data);
    } catch (error) {
      return toast(error.message);
    }
    cloudRun(form.querySelector('[type="submit"]'), () => cloudApi(`/cloud/services/${form.dataset.id}`, { method: 'PUT', body: JSON.stringify(body) }),
      'Redeploying…', () => { cloud.editing = null; return loadCloudCluster(currentRoute.clusterId); });
  },
};

// ------------------------------------------------------------------ routing

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (parts[0] === 'zones' && parts[1]) return { view: 'zone', zone: parts[1], tab: parts[2] || 'overview', params };
  if (parts[0] === 'workers' && parts[1]) return { view: 'worker', worker: parts[1], params };
  if (parts[0] === 'projects' && parts[1]) return { view: 'project', projectId: parts[1], params };
  if (parts[0] === 'domains' && parts[1] === 'buy') return { view: 'domain-buy', params };
  if (parts[0] === 'cloud' && parts[1] === 'clusters' && /^[a-f0-9]{8}$/.test(parts[2] || '')) return { view: 'cloud-cluster', clusterId: parts[2], params };
  if (parts[0] === 'domains' && parts[1] === 'sub' && parts[2]) return { view: 'subdomain', label: parts[2].toLowerCase(), params };
  if (parts[0] === 'domains' && parts[1]) return { view: 'domain', domain: parts[1].toLowerCase(), params };
  if (parts[0] && views[parts[0]]) return { view: parts[0], params };
  return { view: parts.length ? 'missing' : 'home', params };
}

let currentRoute;
function render() {
  currentRoute = parseRoute();
  const content = views[currentRoute.view](currentRoute);
  app.innerHTML = `
    ${sidebar(currentRoute)}
    <div class="dash-main">
      ${topbar(currentRoute)}
      <main class="dash-content">${profile?.announcement ? `<div class="announcement" role="status"><b>Notice</b> ${esc(profile.announcement)}</div>` : ''}${content}</main>
    </div>`;
  app.classList.remove('sidebar-open');
  bindCharts();
  if (currentRoute.view === 'settings') showProfile();
  if (PROJECTS_ENABLED && currentRoute.view.startsWith('project')) projectsAfterRender(currentRoute);
  if (isDomainView(currentRoute.view)) domainsAfterRender(currentRoute);
  if (isCloudView(currentRoute.view)) cloudAfterRender(currentRoute);
  if (isAdminView() && profile && isStaff(profile.role)) {
    if (!adminUsers.list && !adminUsers.loading && !adminUsers.error) loadUsers();
    if (currentRoute.params.get('tab') === 'settings' && !adminSettings.data && !adminSettings.loading) loadAdminSettings();
    if (PROJECTS_ENABLED && currentRoute.params.get('tab') === 'settings' && !adminGithubApp.data && !adminGithubApp.loading) loadAdminGithubApp();
    if (PROJECTS_ENABLED && currentRoute.params.get('tab') === 'projects' && !adminProjects.list && !adminProjects.loading) loadAdminProjects();
    if (DOMAINS_ENABLED && currentRoute.params.get('tab') === 'domains' && !adminDomains.data && !adminDomains.loading && !adminDomains.error) loadAdminDomains();
    if (CLOUD_ENABLED && currentRoute.params.get('tab') === 'cloud' && !adminCloud.data && !adminCloud.loading && !adminCloud.error) loadAdminCloud();
    applyAdminSearch();
  }
  document.title = `${document.querySelector('.page-head h1')?.textContent || 'Dashboard'} | Lyrcloud`;
}

// Account profile from the Lyrcloud account API (GET /me), loaded once per page load.
// Its role decides whether the admin pages show; the API re-checks it on every admin request.
let profile = null;
let profileFailed = false;
async function loadProfile() {
  try {
    const response = await authFetch('/me');
    if (response.status === 403) {
      app.innerHTML = `<section class="panel empty disabled-account"><h2>This account has been disabled</h2><p>Contact hello@lyrcloud.com if you think this is a mistake.</p><button class="btn" data-action="sign-out">Sign out</button></section>`;
      return;
    }
    if (!response.ok) throw new Error(`me failed: ${response.status}`);
    profile = await response.json();
    cacheProfile(profile);
    // The account's plan lives on the server; this browser's copy follows it.
    if (profile.plan && profile.plan !== state.plan) {
      state.plan = profile.plan;
      save();
    }
  } catch {
    profileFailed = true;
  }
  render();
}

function showProfile() {
  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  if (profile) {
    set('profile-provider', PROVIDER_LABELS[profile.provider] || profile.provider || '—');
    set('profile-role', ROLE_LABELS[profile.role] || profile.role || '—');
    set('profile-created', profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—');
  } else if (profileFailed) {
    for (const id of ['profile-provider', 'profile-role', 'profile-created']) set(id, 'Unavailable');
  }
}

// Admin console data (GET /admin/users, GET /admin/settings) and the user-list filter.
const adminUsers = { list: null, error: '', loading: false };
const adminSettings = { data: null, error: '', loading: false };
const adminUpdates = { data: null, error: '', sending: null };
const adminFilter = { q: '', role: 'all' };
let adminEditing = null;
const isAdminView = () => currentRoute?.view === 'admin' || currentRoute?.view === 'users';

async function api(path, options = {}, base = undefined) {
  const response = await authFetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  }, base);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadUsers() {
  adminUsers.loading = true;
  try {
    adminUsers.list = (await api('/admin/users')).users;
    adminUsers.error = '';
  } catch (error) {
    adminUsers.error = error.message;
  }
  adminUsers.loading = false;
  if (isAdminView()) render();
}

async function loadAdminSettings() {
  adminSettings.loading = true;
  try {
    [adminSettings.data, adminUpdates.data] = await Promise.all([api('/admin/settings'), api('/admin/updates')]);
    adminSettings.error = '';
    adminUpdates.error = '';
  } catch (error) {
    adminSettings.error = error.message;
  }
  adminSettings.loading = false;
  if (isAdminView()) render();
}

// Emails an update, calling again with its id while recipients remain (each call runs ~20 seconds).
async function sendAdminUpdate(button, body, form) {
  button.disabled = true;
  adminUpdates.sending = 'Sending…';
  if (isAdminView()) render();
  try {
    let request = body;
    for (;;) {
      const { update, remaining } = await api('/admin/updates', { method: 'POST', body: JSON.stringify(request) });
      const list = (adminUpdates.data?.updates || []).filter((item) => item.id !== update.id);
      adminUpdates.data = { ...adminUpdates.data, updates: [update, ...list] };
      if (!remaining) {
        toast(`Sent to ${update.sent} account${update.sent === 1 ? '' : 's'}${update.failed ? `, ${update.failed} failed` : ''}`);
        form?.reset();
        break;
      }
      adminUpdates.sending = `Sent ${update.sent}, ${remaining} to go…`;
      if (isAdminView()) render();
      request = { updateId: update.id };
    }
  } catch (error) {
    toast(error.message);
  }
  adminUpdates.sending = null;
  if (isAdminView()) render();
}

// Filters the rendered user cards in place, so typing doesn't re-render (and lose focus).
function applyAdminSearch() {
  const list = document.querySelector('.user-list');
  if (!list) return;
  const q = adminFilter.q.trim().toLowerCase();
  let shown = 0;
  for (const card of list.querySelectorAll('.user-card')) {
    card.hidden = Boolean(q) && !card.dataset.search.includes(q);
    if (!card.hidden) shown += 1;
  }
  const empty = document.getElementById('admin-no-match');
  if (empty) empty.hidden = shown > 0 || !list.querySelector('.user-card');
}

const findAdminUser = (id) => adminUsers.list?.find((user) => user.userId === id);
const replaceAdminUser = (user) => {
  adminUsers.list = adminUsers.list.map((item) => (item.userId === user.userId ? user : item));
};

// Runs an admin action from a button: disables it while the request is in flight.
async function adminAction(target, request, message) {
  target.disabled = true;
  try {
    const data = await request();
    if (data?.user) replaceAdminUser(data.user);
    render();
    toast(message);
  } catch (error) {
    target.disabled = false;
    toast(error.message);
  }
}

async function setAccountPlan(plan, applyToSites) {
  try {
    profile = { ...profile, ...(await api('/me', { method: 'PUT', body: JSON.stringify({ plan }) })) };
  } catch (error) {
    toast(`Couldn’t change plan: ${error.message}`);
    render();
    return;
  }
  state.plan = plan;
  if (applyToSites) {
    for (const zone of state.zones) {
      zone.plan = plan;
      zone.security.managedWaf = plan !== 'launch';
    }
  }
  save();
  render();
  toast(`You’re now on the ${planName(plan)} plan${applyToSites && state.zones.length ? ', and so are your websites' : ''}`);
}

const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

window.addEventListener('hashchange', render);

// ------------------------------------------------------------------ actions

const currentZone = () => currentRoute.zone && findZone(currentRoute.zone);

const updateZone = (mutate, message) => {
  const zone = currentZone();
  if (!zone) return;
  mutate(zone);
  save();
  render();
  if (message) toast(message);
};

const clickActions = {
  'toggle-sidebar': () => app.classList.toggle('sidebar-open'),
  'add-sample': () => {
    if (findZone('example.com')) return go('#/zones/example.com/overview');
    const zone = createZone('example.com', state.plan, [
      { id: uid(), type: 'A', name: 'example.com', content: '93.184.215.14', ttl: 'auto', proxied: true },
      { id: uid(), type: 'CNAME', name: 'www.example.com', content: 'example.com', ttl: 'auto', proxied: true },
      { id: uid(), type: 'TXT', name: 'example.com', content: 'v=spf1 -all', ttl: 'auto', proxied: false },
    ]);
    zone.status = 'active';
    state.zones.push(zone);
    save();
    go('#/zones/example.com/overview');
  },
  copy: (target) => {
    navigator.clipboard?.writeText(target.dataset.value).then(() => toast('Copied to clipboard'), () => toast('Copy failed'));
  },
  'check-ns': async (target) => {
    const zone = currentZone();
    const result = document.getElementById('ns-result');
    target.disabled = true;
    result.textContent = 'Checking public DNS…';
    try {
      const current = (await dohQuery(zone.name, 'NS')).map((answer) => answer.data.replace(/\.$/, '').toLowerCase());
      if (zone.nameservers.every((ns) => current.includes(ns))) {
        updateZone((item) => { item.status = 'active'; }, `${zone.name} is now active on Lyrcloud`);
        return;
      }
      result.innerHTML = current.length
        ? `Currently using: ${current.map((ns) => `<code>${esc(ns)}</code>`).join(', ')}. Not updated yet.`
        : 'No nameservers found for this domain yet.';
    } catch (error) {
      result.textContent = `Couldn’t reach public DNS: ${error.message}`;
    }
    target.disabled = false;
  },
  'force-active': () => updateZone((zone) => { zone.status = 'active'; }, 'Marked active (preview only)'),
  'purge-all': (target) => {
    if (!confirmed(target, 'Purge every cached file for this site?')) return;
    updateZone((zone) => { zone.caching.lastPurge = new Date().toISOString(); }, 'Purge requested for all files');
  },
  'delete-zone': (target) => {
    const zone = currentZone();
    if (!confirmed(target, `Remove ${zone.name} from Lyrcloud? DNS records and settings will be deleted.`)) return;
    state.zones = state.zones.filter((item) => item.id !== zone.id);
    for (const worker of state.workers) worker.routes = worker.routes.filter((pattern) => !pattern.startsWith(`${zone.name}/`));
    save();
    toast(`${zone.name} removed`);
    go('#/');
  },
  'toggle-proxy': (target) =>
    updateZone((zone) => {
      const record = zone.dns.find((item) => item.id === target.dataset.id);
      record.proxied = !record.proxied;
    }),
  'delete-record': (target) => updateZone((zone) => { zone.dns = zone.dns.filter((item) => item.id !== target.dataset.id); }, 'Record deleted'),
  'delete-rule': (target) => updateZone((zone) => { zone.security.rules = zone.security.rules.filter((rule) => rule.id !== target.dataset.id); }, 'Rule deleted'),
  'new-worker': () => {
    const name = prompt('Function name (lowercase letters, numbers, dashes)', `function-${state.workers.length + 1}`);
    if (!name) return;
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return toast('Enter a valid name');
    if (state.workers.some((worker) => worker.name === slug)) return toast('A function with that name already exists');
    const worker = { id: uid(), name: slug, code: sampleWorkerCode, routes: [], createdAt: new Date().toISOString(), deployedAt: null };
    state.workers.push(worker);
    save();
    go(`#/workers/${worker.id}`);
  },
  'deploy-worker': (target) => {
    const worker = findWorker(target.dataset.id);
    worker.code = document.getElementById('worker-code').value;
    worker.deployedAt = new Date().toISOString();
    save();
    render();
    toast(`${worker.name} saved (preview — not deployed to the network yet)`);
  },
  'delete-worker': (target) => {
    const worker = findWorker(target.dataset.id);
    if (!confirmed(target, `Delete ${worker.name}?`)) return;
    state.workers = state.workers.filter((item) => item.id !== worker.id);
    save();
    go('#/workers');
  },
  'remove-route': (target) => {
    const worker = findWorker(target.dataset.id);
    worker.routes.splice(Number(target.dataset.index), 1);
    save();
    render();
  },
  'set-account-plan': (target) => {
    target.disabled = true;
    setAccountPlan(target.dataset.plan, document.getElementById('plan-apply-sites')?.checked ?? false);
  },
  'zone-upgrade': () => updateZone((zone) => { zone.plan = 'scale'; zone.security.managedWaf = true; }, 'Upgraded this site to Scale: managed WAF rules are on'),
  'admin-refresh': () => {
    adminCloud.data = null;
    adminCloud.error = '';
    adminDomains.data = null;
    adminDomains.error = '';
    adminUsers.list = null;
    adminUsers.error = '';
    adminSettings.data = null;
    adminSettings.error = '';
    render();
  },
  'admin-edit': (target) => {
    adminEditing = adminEditing === target.dataset.id ? null : target.dataset.id;
    render();
  },
  'admin-role': (target) => {
    const user = findAdminUser(target.dataset.id);
    const role = target.dataset.role;
    if (!confirmed(target, role === 'admin' ? `Give ${userLabel(user)} admin access?` : `Remove admin access from ${userLabel(user)}?`)) return;
    adminAction(target, () => api(`/admin/users/${encodeURIComponent(user.userId)}`, { method: 'PUT', body: JSON.stringify({ role }) }),
      role === 'admin' ? `${userLabel(user)} is now an admin` : `${userLabel(user)} is no longer an admin`);
  },
  'admin-disable': (target) => {
    const user = findAdminUser(target.dataset.id);
    const disabled = target.dataset.disabled === 'true';
    if (disabled && !confirmed(target, `Disable ${userLabel(user)}? They’ll be signed out and can’t sign in until you enable them.`)) return;
    adminAction(target, () => api(`/admin/users/${encodeURIComponent(user.userId)}`, { method: 'PUT', body: JSON.stringify({ disabled }) }),
      disabled ? `${userLabel(user)} is disabled` : `${userLabel(user)} is enabled again`);
  },
  'admin-sign-out': (target) => {
    const user = findAdminUser(target.dataset.id);
    if (!confirmed(target, `Sign ${userLabel(user)} out on every device?`)) return;
    adminAction(target, () => api(`/admin/users/${encodeURIComponent(user.userId)}/sign-out`, { method: 'POST' }),
      `${userLabel(user)} will be asked to sign in again`);
  },
  'admin-delete': (target) => {
    const user = findAdminUser(target.dataset.id);
    if (!confirmed(target, `Delete ${userLabel(user)}? This removes the account for good.`)) return;
    adminAction(target, async () => {
      await api(`/admin/users/${encodeURIComponent(user.userId)}`, { method: 'DELETE' });
      adminUsers.list = adminUsers.list.filter((item) => item.userId !== user.userId);
    }, `${userLabel(user)} was deleted`);
  },
  'account-menu': (target) => setAccountMenu(target.getAttribute('aria-expanded') !== 'true'),
  'avatar-provider': () => saveProfile({ avatar: null }, 'Using your sign-in photo'),
  'avatar-initials': () => saveProfile({ avatar: 'initials' }, 'Photo removed'),
  'github-connect': (target) => connectGithubAccount(target),
  'github-disconnect': async (target) => {
    if (!confirmed(target, 'Disconnect GitHub? Linked projects stop deploying on push until you reconnect.')) return;
    try {
      await projectsApi('/projects/github', { method: 'DELETE' });
      projects.data = null;
      projects.repos = null;
      loadProjects();
      toast('GitHub disconnected');
    } catch (error) {
      toast(error.message);
    }
  },
  'projects-retry': () => {
    projects.error = '';
    loadProjects();
  },
  'project-redeploy': async (target) => {
    target.disabled = true;
    try {
      const { deployment } = await projectsApi(`/projects/${projects.detail.project.projectId}/deployments`, { method: 'POST' });
      projects.detail.deployments.unshift(deployment);
      toast('Deploying the latest commit');
    } catch (error) {
      toast(error.message);
    }
    render();
  },
  'project-log': (target) => openLog(target.dataset.id),
  'project-promote': async (target) => {
    if (!confirmed(target, 'Make this deployment live? Visitors see it at once.')) return;
    target.disabled = true;
    try {
      await projectsApi(`/projects/${projects.detail.project.projectId}/deployments/${target.dataset.id}/promote`, { method: 'POST' });
      toast('Deployment is live');
      loadProject(projects.detail.project.projectId);
    } catch (error) {
      target.disabled = false;
      toast(error.message);
    }
  },
  'project-delete': async (target) => {
    const { project } = projects.detail;
    if (!confirmed(target, `Delete ${project.name}? The site goes offline and the name is freed.`)) return;
    target.disabled = true;
    try {
      await projectsApi(`/projects/${project.projectId}`, { method: 'DELETE' });
      projects.data = null;
      projects.detail = null;
      toast(`${project.name} deleted`);
      go('#/projects');
    } catch (error) {
      target.disabled = false;
      toast(error.message);
    }
  },
  'admin-project-toggle': async (target) => {
    const item = adminProjects.list.find((entry) => entry.projectId === target.dataset.id);
    if (!item.disabled && !confirmed(target, `Disable ${item.name}? Its site goes offline immediately.`)) return;
    target.disabled = true;
    try {
      const { project } = await projectsApi(`/admin/projects/${item.projectId}`, { method: 'PUT', body: JSON.stringify({ disabled: !item.disabled }) });
      Object.assign(item, project);
      toast(`${item.name} ${project.disabled ? 'disabled' : 'enabled'}`);
    } catch (error) {
      toast(error.message);
    }
    render();
  },
  'phone-edit': () => {
    phoneStep = 'edit';
    render();
  },
  'phone-cancel': () => {
    phoneStep = null;
    render();
  },
  'phone-remove': (target) => {
    if (!confirmed(target, 'Remove your mobile number from your account?')) return;
    phoneStep = null;
    phoneRequest('/me/phone', { method: 'DELETE' }, 'Mobile number removed');
  },
  'sign-out': (target) => {
    target.disabled = true;
    target.textContent = 'Signing out…';
    endSession();
  },
  reset: (target) => {
    if (!confirmed(target, 'Delete all websites and functions stored in this browser?')) return;
    state.zones = [];
    state.workers = [];
    save();
    go('#/');
  },
};

const changeActions = {
  'import-kind': (target) => {
    const form = target.closest('form');
    form.dataset.kind = target.value;
    suggestImportNames(form);
  },
  'import-mode': (target) => {
    target.closest('form').dataset.mode = target.value;
  },
  'email-updates': (target) => saveProfile({ emailUpdates: target.checked }, target.checked ? 'You’ll get product updates' : 'Product update emails turned off'),
  'avatar-file': async (target) => {
    const [file] = target.files;
    target.value = '';
    if (!file) return;
    try {
      await saveProfile({ avatar: await imageFileToAvatar(file) }, 'Profile photo updated');
    } catch (error) {
      toast(error.message);
    }
  },
  'pick-zone': (target) => go(target.value ? `#/zones/${encodeURIComponent(target.value)}/overview` : '#/'),
  'under-attack': (target) => updateZone((zone) => { zone.security.underAttack = target.checked; }, `Under Attack mode ${target.checked ? 'on' : 'off'}`),
  'dev-mode': (target) => updateZone((zone) => { zone.caching.devMode = target.checked; }, `Development mode ${target.checked ? 'on' : 'off'}`),
  'bot-fight': (target) => updateZone((zone) => { zone.security.botFight = target.checked; }, 'Bot fight mode updated'),
  'managed-waf': (target) => updateZone((zone) => { zone.security.managedWaf = target.checked; }, 'Managed rules updated'),
  'toggle-rule': (target) =>
    updateZone((zone) => {
      zone.security.rules.find((rule) => rule.id === target.dataset.id).enabled = target.checked;
    }, 'Rule updated'),
  'ssl-mode': (target) => updateZone((zone) => { zone.ssl.mode = target.value; }, 'Encryption mode updated'),
  'always-https': (target) => updateZone((zone) => { zone.ssl.alwaysHttps = target.checked; }, 'Saved'),
  hsts: (target) => updateZone((zone) => { zone.ssl.hsts = target.checked; }, 'Saved'),
  'min-tls': (target) => updateZone((zone) => { zone.ssl.minTls = target.value; }, `Minimum TLS set to ${target.value}`),
  'cache-level': (target) => updateZone((zone) => { zone.caching.level = target.value; }, 'Caching level updated'),
  'browser-ttl': (target) => updateZone((zone) => { zone.caching.browserTtl = target.value; }, 'Browser cache TTL updated'),
  'account-plan': (target) => setAccountPlan(target.value, false),
  'zone-plan': (target) =>
    updateZone((zone) => {
      zone.plan = target.value;
      zone.security.managedWaf = target.value !== 'launch';
    }, `This site is now on the ${planName(target.value)} plan`),
  'admin-role-filter': (target) => {
    adminFilter.role = target.value;
    render();
  },
};

const showFormError = (form, message) => {
  const node = form.querySelector('.form-error') || form.parentElement.querySelector('.form-error');
  node.textContent = message;
  node.hidden = false;
};

const RECORD_VALIDATORS = {
  A: [/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/, 'Enter a valid IPv4 address.'],
  AAAA: [/^[0-9a-f:]+$/i, 'Enter a valid IPv6 address.'],
  CNAME: [DOMAIN_RE, 'Enter a valid hostname.'],
  MX: [/^\d{1,5}\s+\S+$/, 'Use "priority hostname", e.g. "10 mail.example.com".'],
  TXT: [/^.{1,2048}$/s, 'TXT content is required.'],
};

const formActions = {
  'project-import': (form, data) => importProject(form, data),
  'project-settings': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    const settings = Object.fromEntries(['branch', 'rootDir', 'installCommand', 'buildCommand', 'outputDir'].map((field) => [field, String(data.get(field) || '').trim()]));
    try {
      const { project } = await projectsApi(`/projects/${projects.detail.project.projectId}`, { method: 'PUT', body: JSON.stringify({ settings }) });
      projects.detail.project = project;
      toast('Settings saved. Redeploy to use them.');
    } catch (error) {
      toast(error.message);
    }
    button.disabled = false;
    render();
  },
  'github-app': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { action, manifest } = await projectsApi('/admin/github-app/manifest', { method: 'POST', body: JSON.stringify({ name: String(data.get('name')) }) });
      // GitHub's manifest flow needs a real form POST from the browser.
      const post = document.createElement('form');
      post.method = 'post';
      post.action = action;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'manifest';
      field.value = manifest;
      post.append(field);
      document.body.append(post);
      post.submit();
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
  'phone-send': async (form, data) => {
    if (await phoneRequest('/me/phone', { method: 'POST', body: JSON.stringify({ phone: String(data.get('phone')) }) }, 'Code sent')) {
      phoneStep = 'code';
      render();
      app.querySelector('[data-form="phone-verify"] input')?.focus();
    }
  },
  'phone-verify': async (form, data) => {
    if (await phoneRequest('/me/phone/verify', { method: 'POST', body: JSON.stringify({ code: String(data.get('code')).trim() }) }, 'Mobile number verified')) {
      phoneStep = null;
      render();
    }
  },
  'admin-update': (form, data) => {
    const button = form.querySelector('[type="submit"]');
    const subject = String(data.get('subject')).trim();
    const message = String(data.get('message')).trim();
    if (!subject || !message) return toast('Add a subject and a message.');
    if (!confirmed(button, `Email “${subject}” to ${adminUpdates.data?.recipients ?? 'every'} subscribed account(s)? This can’t be undone.`)) return;
    sendAdminUpdate(button, { subject, message }, form);
  },
  'profile-name': (form, data) => {
    const name = String(data.get('name') || '').trim();
    if (!name) return toast('Enter a name.');
    if (name === profile?.name) return toast('That’s already your name.');
    saveProfile({ name }, 'Name saved');
  },
  'admin-edit-user': async (form, data) => {
    const user = findAdminUser(form.dataset.id);
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { user: saved } = await api(`/admin/users/${encodeURIComponent(user.userId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: String(data.get('name')), plan: String(data.get('plan')) }),
      });
      replaceAdminUser(saved);
      adminEditing = null;
      render();
      toast(`Saved ${userLabel(saved)}`);
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
  'admin-settings': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      adminSettings.data = await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ announcement: String(data.get('announcement')) }) });
      profile = { ...profile, announcement: adminSettings.data.announcement };
      render();
      toast(adminSettings.data.announcement ? 'Announcement published' : 'Announcement removed');
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
  'add-domain': async (form, data) => {
    const domain = String(data.get('domain')).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!DOMAIN_RE.test(domain)) return showFormError(form, 'Enter a valid domain like example.com.');
    if (findZone(domain)) return showFormError(form, `${domain} is already in your account.`);
    go(`#/add-site?step=plan&domain=${encodeURIComponent(domain)}`);
  },
  'choose-plan': async (form, data) => {
    const domain = String(data.get('domain'));
    if (!DOMAIN_RE.test(domain) || findZone(domain)) return go('#/add-site');
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = 'Scanning DNS records…';
    let records = [];
    try {
      records = await scanRecords(domain);
    } catch {}
    state.zones.push(createZone(domain, String(data.get('plan')), records));
    save();
    toast(records.length ? `Imported ${records.length} DNS records` : 'No existing DNS records found');
    go(`#/zones/${encodeURIComponent(domain)}/overview`);
  },
  'add-record': (form, data) => {
    const zone = currentZone();
    const type = String(data.get('type'));
    const rawName = String(data.get('name')).trim().toLowerCase();
    const name = rawName === '@' || rawName === zone.name ? zone.name : `${rawName.replace(new RegExp(`\\.${zone.name.replace(/\./g, '\\.')}$`), '')}.${zone.name}`;
    const content = String(data.get('content')).trim();
    if (!DOMAIN_RE.test(name)) return showFormError(form, 'Enter a valid record name.');
    const [pattern, message] = RECORD_VALIDATORS[type];
    if (!pattern.test(content)) return showFormError(form, message);
    if (type === 'CNAME' && zone.dns.some((record) => record.name === name)) return showFormError(form, 'A CNAME cannot share a name with other records.');
    updateZone((item) => {
      item.dns.push({ id: uid(), type, name, content, ttl: 'auto', proxied: ['A', 'AAAA', 'CNAME'].includes(type) && data.get('proxied') === 'on' });
    }, `${type} record added`);
  },
  'add-rule': (form, data) =>
    updateZone((zone) => {
      zone.security.rules.push({ id: uid(), name: String(data.get('name')).trim(), expression: String(data.get('expression')).trim(), action: String(data.get('action')), enabled: true });
    }, 'Rule added'),
  'purge-urls': (form, data) => {
    const zone = currentZone();
    let url;
    try {
      url = new URL(String(data.get('urls')).trim());
    } catch {
      return toast('Enter a full URL including https://');
    }
    if (url.hostname !== zone.name && !url.hostname.endsWith(`.${zone.name}`)) return toast(`URL must be on ${zone.name}`);
    updateZone((item) => { item.caching.lastPurge = new Date().toISOString(); }, `Purge requested for ${url.pathname}`);
  },
  'add-route': (form, data) => {
    const worker = findWorker(form.dataset.id);
    const pattern = String(data.get('pattern'));
    if (!worker.routes.includes(pattern)) worker.routes.push(pattern);
    save();
    render();
  },
  'preview-worker': (form, data) => runPreview(String(data.get('method')), String(data.get('path'))),
};

Object.assign(clickActions, domainClickActions);
Object.assign(changeActions, domainChangeActions);
Object.assign(formActions, domainFormActions);
Object.assign(clickActions, cloudClickActions);
Object.assign(changeActions, cloudChangeActions);
Object.assign(formActions, cloudFormActions);

app.addEventListener('click', (event) => {
  // Any click outside the account menu closes it.
  if (!event.target.closest('.account-menu')) setAccountMenu(false);
  const target = event.target.closest('[data-action]');
  if (!target || target.matches('select, input')) return;
  clickActions[target.dataset.action]?.(target);
});

app.addEventListener('change', (event) => {
  const target = event.target.closest('[data-action]');
  if (target) changeActions[target.dataset.action]?.(target);
});

app.addEventListener('input', (event) => {
  if (event.target.dataset?.action === 'cloud-estimate') return updateClusterEstimate();
  const { id } = event.target;
  if (id === 'import-name' || id === 'import-copy-name') event.target.dataset.touched = '1';
  if (id === 'import-url' || id === 'import-repo') suggestImportNames(event.target.closest('form'));
  if (id !== 'admin-search') return;
  adminFilter.q = event.target.value;
  applyAdminSearch();
});

app.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  formActions[form.dataset.form]?.(form, new FormData(form));
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.getElementById('account-panel')?.hidden !== false) return;
  setAccountMenu(false);
  app.querySelector('.account-button')?.focus();
});

// Tab inserts two spaces in the code editor instead of moving focus.
app.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !event.target.matches('.code-editor') || event.shiftKey) return;
  event.preventDefault();
  const editor = event.target;
  editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
});

// ------------------------------------------------------------------ function preview

// Runs the user's module in a dedicated Web Worker so it can't touch the dashboard page,
// and kills it if it doesn't respond in time.
function runPreview(method, path) {
  const output = document.getElementById('preview-output');
  const code = document.getElementById('worker-code').value;
  const userUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const runner = `
    self.onmessage = async ({ data }) => {
      try {
        const mod = await import(data.userUrl);
        const handler = mod.default && mod.default.fetch;
        if (typeof handler !== 'function') throw new Error('Module must export default { fetch(request) }');
        const request = new Request(data.url, { method: data.method });
        const response = await handler.call(mod.default, request, {}, { waitUntil() {} });
        if (!(response instanceof Response)) throw new Error('fetch() must return a Response');
        self.postMessage({ ok: true, status: response.status, headers: [...response.headers], body: await response.text() });
      } catch (error) {
        self.postMessage({ ok: false, error: String(error && error.stack || error) });
      }
    };`;
  const runnerUrl = URL.createObjectURL(new Blob([runner], { type: 'text/javascript' }));
  const worker = new Worker(runnerUrl, { type: 'module' });
  const cleanup = () => {
    worker.terminate();
    URL.revokeObjectURL(userUrl);
    URL.revokeObjectURL(runnerUrl);
  };
  const timer = setTimeout(() => {
    cleanup();
    output.textContent = 'Error: function did not respond within 3 seconds.';
  }, 3000);
  const started = performance.now();
  output.textContent = 'Running…';
  worker.onmessage = ({ data }) => {
    clearTimeout(timer);
    cleanup();
    const elapsed = `${(performance.now() - started).toFixed(0)} ms`;
    output.textContent = data.ok
      ? `HTTP ${data.status} · ${elapsed}\n${data.headers.map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n${data.body}`
      : `Error (${elapsed}):\n${data.error}`;
  };
  worker.onerror = (event) => {
    clearTimeout(timer);
    cleanup();
    output.textContent = `Error: ${event.message || 'failed to load module'}`;
  };
  const host = state.workers.find((item) => item.id === currentRoute.worker)?.name || 'preview';
  worker.postMessage({ userUrl, method, url: `https://${host}.lyrcloud.dev${path.startsWith('/') ? path : `/${path}`}` });
}

render();
loadProfile();
