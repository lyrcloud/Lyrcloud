// Lyrcloud dashboard — a dependency-free, hash-routed single-page app.
// Sign-in is real (Cognito, see src/auth.js). Websites, DNS, and settings are not backed by
// a server yet: they live in localStorage, and analytics are generated sample data (clearly
// labeled in the UI). DNS lookups and nameserver checks are real, using public DNS-over-HTTPS.
import { authFetch, redirectToLogin } from './auth.js';
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
  home: '⌂', sites: '◎', workers: '{}', settings: '⚙', overview: '▤', analytics: '📈',
  dns: '☍', ssl: '🔒', security: '🛡', caching: '⚡', add: '+', users: '👥',
};

const ROLE_LABELS = { superadmin: 'Super admin', admin: 'Admin', user: 'User' };
const isStaff = (role) => role === 'admin' || role === 'superadmin';

function sidebar(route) {
  const accountLinks = [
    ['#/', 'Account home', icons.home, route.view === 'home'],
    ['#/add-site', 'Add a site', icons.add, route.view === 'add-site'],
    ['#/workers', 'Edge Functions', icons.workers, route.view.startsWith('worker')],
    ['#/settings', 'Account settings', icons.settings, route.view === 'settings'],
  ];
  if (isStaff(profile?.role)) accountLinks.push(['#/users', 'Users', icons.users, route.view === 'users']);
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
        ${isStaff(profile?.role) ? `<span class="role-pill">${ROLE_LABELS[profile.role]}</span>` : ''}
        <span class="plan-pill">${esc(state.plan)} plan</span>
        <span class="avatar" title="${esc(session.email)}">${esc(session.email[0].toUpperCase())}</span>
      </div>
    </header>`;
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
                    <span class="zone-name"><b>${esc(zone.name)}</b><small>${esc(zone.plan)} plan · ${zone.dns.length} DNS records</small></span>
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
      <div class="grid-3">
        <a class="panel quick" href="#/workers"><span aria-hidden="true">{}</span><h3>Edge Functions</h3><p>${state.workers.length} created · run code in 180+ cities</p></a>
        <a class="panel quick" href="/developers/#quickstart"><span aria-hidden="true">⌘</span><h3>Install the CLI</h3><p>Deploy from your terminal with <code>lyrcloud deploy</code></p></a>
        <a class="panel quick" href="/pricing/"><span aria-hidden="true">↑</span><h3>Upgrade plan</h3><p>Unlock the managed WAF and image optimization</p></a>
      </div>`;
  },

  'add-site'(route) {
    const step = route.params.get('step') || 'domain';
    const domain = route.params.get('domain') || '';
    if (step === 'plan') {
      const plans = [
        ['launch', 'Launch', '$0', 'CDN, TLS, DDoS protection'],
        ['scale', 'Scale', '$29/mo', 'Adds managed WAF & image optimization'],
        ['enterprise', 'Enterprise', 'Custom', 'SLAs, bot management, dedicated support'],
      ];
      return `
        ${pageHead('Select a plan', `for <b>${esc(domain)}</b>`)}
        <form class="panel" data-form="choose-plan">
          <input type="hidden" name="domain" value="${esc(domain)}" />
          <div class="plan-options">
            ${plans
              .map(
                ([id, name, price, text], index) => `
              <label class="plan-option">
                <input type="radio" name="plan" value="${id}"${index === 0 ? ' checked' : ''} />
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
      <section class="panel">
        ${settingRow('Email', 'The address you sign in with.', `<span class="mono">${esc(session.email)}</span>`)}
        ${settingRow('Signed in with', 'Your identity provider.', '<span id="profile-provider" class="muted">Loading…</span>')}
        ${settingRow('Role', 'What you can manage in Lyrcloud.', '<span id="profile-role" class="muted">Loading…</span>')}
        ${settingRow('Member since', 'When your Lyrcloud account was created.', '<span id="profile-created" class="muted">Loading…</span>')}
        ${settingRow('Plan', 'Default plan for new websites.', `
          <select data-action="account-plan">${['launch', 'scale', 'enterprise'].map((plan) => `<option${plan === state.plan ? ' selected' : ''}>${plan}</option>`).join('')}</select>`)}
        ${settingRow('Sign out', 'End your session in this browser.', '<button class="btn" data-action="sign-out">Sign out</button>')}
        ${settingRow('Reset preview data', 'Delete all websites and functions stored in this browser.', '<button class="btn danger" data-action="reset">Reset</button>')}
      </section>`;
  },

  users() {
    if (profile && !isStaff(profile.role)) return views.missing();
    const canChangeRoles = profile?.role === 'superadmin';
    const roleButton = (user) => {
      if (!canChangeRoles || user.role === 'superadmin') return '';
      const next = user.role === 'admin' ? 'user' : 'admin';
      return `<button class="btn small" data-action="set-role" data-id="${esc(user.userId)}" data-role="${next}">${next === 'admin' ? 'Make admin' : 'Remove admin'}</button>`;
    };
    const body = adminUsers.error
      ? `<p class="form-error">${esc(adminUsers.error)}</p>`
      : !adminUsers.list
        ? '<p class="muted">Loading accounts…</p>'
        : `<div class="table-scroll"><table class="table">
            <thead><tr><th>Account</th><th>Signed in with</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead>
            <tbody>${adminUsers.list
              .map(
                (user) => `
              <tr>
                <td><b>${esc(user.name || user.email || user.userId)}</b><br><small class="muted mono">${esc(user.email || '—')}</small></td>
                <td>${esc(user.provider || '—')}</td>
                <td><span class="role-badge role-${esc(user.role)}">${ROLE_LABELS[user.role] || esc(user.role)}</span></td>
                <td>${user.lastLoginAt ? formatDate(user.lastLoginAt) : '—'}</td>
                <td>${roleButton(user)}</td>
              </tr>`,
              )
              .join('')}</tbody>
          </table></div>`;
    return `
      ${pageHead('Users', canChangeRoles ? 'Everyone with a Lyrcloud account. You can grant or remove admin access.' : 'Everyone with a Lyrcloud account. Only the super admin can change roles.')}
      <section class="panel">${body}</section>`;
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
      ${pageHead(esc(zone.name), `${statusBadge(zone.status)} · ${esc(zone.plan)} plan`, `<a class="btn" href="https://${esc(zone.name)}" target="_blank" rel="noopener">Visit site ↗</a>`)}
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
        ${settingRow('Managed WAF rules', zone.plan === 'launch' ? 'Available on Scale and Enterprise plans.' : 'OWASP core ruleset and Lyrcloud managed rules.', zone.plan === 'launch' ? '<a class="btn small" href="/pricing/">Upgrade</a>' : toggle('managed-waf', zone.security.managedWaf, 'Managed WAF rules'))}
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

// ------------------------------------------------------------------ routing

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (parts[0] === 'zones' && parts[1]) return { view: 'zone', zone: parts[1], tab: parts[2] || 'overview', params };
  if (parts[0] === 'workers' && parts[1]) return { view: 'worker', worker: parts[1], params };
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
      <main class="dash-content">${content}</main>
    </div>`;
  app.classList.remove('sidebar-open');
  bindCharts();
  if (currentRoute.view === 'settings') showProfile();
  if (currentRoute.view === 'users' && !adminUsers.list && !adminUsers.loading) loadUsers();
  document.title = `${document.querySelector('.page-head h1')?.textContent || 'Dashboard'} | Lyrcloud`;
}

// Account profile from the Lyrcloud account API (GET /me), loaded once per page load.
// Its role decides whether the admin pages show; the API re-checks it on every admin request.
let profile = null;
let profileFailed = false;
async function loadProfile() {
  try {
    const response = await authFetch('/me');
    if (!response.ok) throw new Error(`me failed: ${response.status}`);
    profile = await response.json();
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
    set('profile-provider', profile.provider || '—');
    set('profile-role', ROLE_LABELS[profile.role] || profile.role || '—');
    set('profile-created', profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—');
  } else if (profileFailed) {
    for (const id of ['profile-provider', 'profile-role', 'profile-created']) set(id, 'Unavailable');
  }
}

// Every account, for admins (GET /admin/users).
const adminUsers = { list: null, error: '', loading: false };
async function loadUsers() {
  adminUsers.loading = true;
  try {
    const response = await authFetch('/admin/users');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Couldn’t load accounts (${response.status})`);
    adminUsers.list = data.users;
    adminUsers.error = '';
  } catch (error) {
    adminUsers.error = error.message;
  }
  adminUsers.loading = false;
  if (currentRoute.view === 'users') render();
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
  'purge-all': () => {
    if (!confirm('Purge every cached file for this site?')) return;
    updateZone((zone) => { zone.caching.lastPurge = new Date().toISOString(); }, 'Purge requested for all files');
  },
  'delete-zone': () => {
    const zone = currentZone();
    if (!confirm(`Remove ${zone.name} from Lyrcloud? DNS records and settings will be deleted.`)) return;
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
    if (!confirm(`Delete ${worker.name}?`)) return;
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
  'set-role': async (target) => {
    const user = adminUsers.list?.find((item) => item.userId === target.dataset.id);
    const role = target.dataset.role;
    const who = user?.email || 'this account';
    if (!confirm(role === 'admin' ? `Give ${who} admin access?` : `Remove admin access from ${who}?`)) return;
    target.disabled = true;
    try {
      const response = await authFetch(`/admin/users/${encodeURIComponent(target.dataset.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      adminUsers.list = adminUsers.list.map((item) => (item.userId === data.user.userId ? data.user : item));
      render();
      toast(role === 'admin' ? `${who} is now an admin` : `${who} is no longer an admin`);
    } catch (error) {
      target.disabled = false;
      toast(error.message);
    }
  },
  'sign-out': () => endSession(),
  reset: () => {
    if (!confirm('Delete all websites and functions stored in this browser?')) return;
    state.zones = [];
    state.workers = [];
    save();
    go('#/');
  },
};

const changeActions = {
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
  'account-plan': (target) => {
    state.plan = target.value;
    save();
    render();
    toast('Plan updated');
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

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.matches('select, input')) return;
  clickActions[target.dataset.action]?.(target);
});

app.addEventListener('change', (event) => {
  const target = event.target.closest('[data-action]');
  if (target) changeActions[target.dataset.action]?.(target);
});

app.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  formActions[form.dataset.form]?.(form, new FormData(form));
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
