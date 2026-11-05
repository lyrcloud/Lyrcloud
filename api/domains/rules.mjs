// Pure rules for Lyrcloud Domains: names, prices with Lyrcloud's commission, registrant contacts,
// DNS records and Stripe webhook signatures. Everything here is synchronous and side-effect free.
import { createHmac, timingSafeEqual } from 'node:crypto';

// TLDs sold out of the box. None of them need TLD-specific registry fields at DNA (the registrar);
// the super admin can change the list in the admin console.
export const DEFAULT_TLDS = ['com', 'net', 'org', 'io', 'co', 'dev', 'app', 'xyz', 'online', 'site', 'store', 'tech', 'me', 'info', 'biz', 'cloud'];

// Lyrcloud's commission on top of what the registrar charges: 1%, so domains sell at close to DNA's
// cost. `dnsCentsPerYear` is what DNS hosting costs Lyrcloud per domain and is added to registrations and
// renewals that use Lyrcloud DNS; DNA hosts the zones of the domains it registers for free, so it's 0.
// `round99` rounds the final price up to .99.
export const DEFAULT_PRICING = {
  percent: 1,
  flatCents: 0,
  dnsCentsPerYear: 0,
  round99: false,
  tlds: DEFAULT_TLDS,
  overrides: {},
  // name.<subdomain zone> (lyr.cloud): the yearly price, and the plans that include one for free.
  subdomainCents: 499,
  subdomainFreePlans: ['scale', 'enterprise'],
};

export const MAX_YEARS = 5;
// Stripe's card fee in the US, shown in the admin console so the commission can cover it.
export const STRIPE_PERCENT = 2.9;
export const STRIPE_FIXED_CENTS = 30;
// How long a domain is held for someone while they pay. Stripe Checkout sessions last at least 30 min.
export const HOLD_MINUTES = 35;
// Auto-renew charges the saved card this many days before the domain expires.
export const RENEW_DAYS_BEFORE = 30;

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// Lowercases and trims a typed domain ("https://www.Example.com/x" -> "example.com"). Returns null if
// it isn't a registrable second-level name (exactly one label before the TLD).
export function cleanDomain(input) {
  const domain = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  const labels = domain.split('.');
  if (labels.length !== 2 || !labels.every((label) => LABEL_RE.test(label)) || !/^[a-z]{2,63}$/.test(labels[1])) return null;
  if (labels[0].slice(2, 4) === '--' && !labels[0].startsWith('xn--')) return null;
  return domain;
}

export const tldOf = (domain) => domain.slice(domain.indexOf('.') + 1);

// "my shop" -> "myshop", "Example.COM" -> "example"; the bare name a search is about.
export function searchName(input) {
  const text = String(input || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  const [first] = text.split('.');
  const name = first.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 63);
  return name || null;
}

// Merges stored pricing settings over the defaults.
export function pricingConfig(stored) {
  const config = { ...DEFAULT_PRICING, ...(stored || {}) };
  config.tlds = Array.isArray(config.tlds) && config.tlds.length ? config.tlds : DEFAULT_TLDS;
  config.overrides = config.overrides && typeof config.overrides === 'object' ? config.overrides : {};
  return config;
}

// Returns [status, message] if `body` isn't a valid pricing update, else null.
export function pricingError(body) {
  if (!body || typeof body !== 'object') return [400, 'Send the pricing settings as JSON.'];
  const num = (value, max) => Number.isFinite(value) && value >= 0 && value <= max;
  if ('percent' in body && !num(body.percent, 500)) return [400, 'Commission percent must be between 0 and 500.'];
  if ('flatCents' in body && !(Number.isInteger(body.flatCents) && num(body.flatCents, 100_000))) return [400, 'Flat commission must be 0 to 100000 cents.'];
  if ('dnsCentsPerYear' in body && !(Number.isInteger(body.dnsCentsPerYear) && num(body.dnsCentsPerYear, 10_000))) return [400, 'DNS cost must be 0 to 10000 cents.'];
  if ('round99' in body && typeof body.round99 !== 'boolean') return [400, '"round99" must be true or false.'];
  if ('subdomainCents' in body && !(Number.isInteger(body.subdomainCents) && body.subdomainCents >= 50 && body.subdomainCents <= 100_000)) return [400, 'Subdomain price must be 50 to 100000 cents.'];
  if ('subdomainFreePlans' in body && !(Array.isArray(body.subdomainFreePlans) && body.subdomainFreePlans.every((plan) => ['launch', 'scale', 'enterprise'].includes(plan)))) return [400, 'Free plans must be launch, scale or enterprise.'];
  if ('tlds' in body) {
    if (!Array.isArray(body.tlds) || !body.tlds.length || body.tlds.length > 100) return [400, 'List between 1 and 100 TLDs.'];
    if (!body.tlds.every((tld) => typeof tld === 'string' && /^[a-z]{2,63}$/.test(tld))) return [400, 'TLDs are lowercase letters only, without the dot.'];
  }
  if ('overrides' in body) {
    if (!body.overrides || typeof body.overrides !== 'object' || Array.isArray(body.overrides)) return [400, 'Overrides must be an object keyed by TLD.'];
    for (const [tld, override] of Object.entries(body.overrides)) {
      if (!/^[a-z]{2,63}$/.test(tld) || !override || typeof override !== 'object') return [400, `Bad override for "${tld}".`];
      if ('percent' in override && !num(override.percent, 500)) return [400, `Commission percent for .${tld} must be 0 to 500.`];
      if ('flatCents' in override && !(Number.isInteger(override.flatCents) && num(override.flatCents, 100_000))) return [400, `Flat commission for .${tld} must be 0 to 100000 cents.`];
    }
  }
  return null;
}

const toCents = (usd) => Math.round(Number(usd) * 100);

// What Lyrcloud pays per year for `tld` and `action` ("register" | "renew" | "transfer"), DNS included
// when the domain uses Lyrcloud DNS. `prices` is { [tld]: { register, renew, transfer } } in USD.
export function costCents(prices, tld, action, config, withDns) {
  const usd = prices?.[tld]?.[action];
  if (!Number.isFinite(usd)) return null;
  return toCents(usd) + (withDns ? config.dnsCentsPerYear : 0);
}

// The customer's price for one year: cost plus commission, optionally rounded up to .99, never below cost.
export function retailCents(cost, tld, config) {
  if (!Number.isFinite(cost)) return null;
  const rules = { ...config, ...(config.overrides?.[tld] || {}) };
  let cents = Math.ceil(cost * (1 + rules.percent / 100) + rules.flatCents);
  if (config.round99) cents = Math.ceil((cents + 1) / 100) * 100 - 1;
  return Math.max(cents, cost);
}

// Register and renewal include DNS hosting (every registration gets Lyrcloud DNS); transfers keep the
// customer's current DNS, so they don't.
export function quote(prices, tld, config) {
  const cost = {
    register: costCents(prices, tld, 'register', config, true),
    renew: costCents(prices, tld, 'renew', config, true),
    renewNoDns: costCents(prices, tld, 'renew', config, false),
    transfer: costCents(prices, tld, 'transfer', config, false),
  };
  return {
    tld,
    register: retailCents(cost.register, tld, config),
    renew: retailCents(cost.renew, tld, config),
    renewNoDns: retailCents(cost.renewNoDns, tld, config),
    transfer: retailCents(cost.transfer, tld, config),
    cost,
  };
}

export const stripeFeeCents = (amount) => Math.round((amount * STRIPE_PERCENT) / 100) + STRIPE_FIXED_CENTS;

// ------------------------------------------------------------------ registrant contact

const COUNTRY_RE = /^[A-Z]{2}$/;
const CONTACT_FIELDS = {
  firstName: 255, lastName: 255, organization: 255, email: 254, phoneCountry: 4, phone: 20,
  address1: 255, address2: 255, city: 255, state: 255, zip: 255, country: 2,
};

// Returns [status, message] if `contact` can't be used to register a domain, else null.
export function contactError(contact) {
  if (!contact || typeof contact !== 'object') return [400, 'Add the registrant’s contact details.'];
  for (const [key, max] of Object.entries(CONTACT_FIELDS)) {
    if (key in contact && (typeof contact[key] !== 'string' || contact[key].length > max)) return [400, `"${key}" is too long or not text.`];
  }
  const required = { firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', address1: 'Address', city: 'City', zip: 'Postal code', country: 'Country' };
  for (const [key, label] of Object.entries(required)) {
    if (!String(contact[key] || '').trim()) return [400, `${label} is required.`];
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())) return [400, 'Enter a valid email address.'];
  if (!COUNTRY_RE.test(contact.country)) return [400, 'Pick a country.'];
  if (!/^\+?\d{1,3}$/.test(String(contact.phoneCountry || '').trim())) return [400, 'Enter the phone country code, like +1.'];
  if (!/^\d{4,15}$/.test(String(contact.phone).replace(/[\s().-]/g, ''))) return [400, 'Enter the phone number using digits only.'];
  return null;
}

// Keeps only known contact fields, trimmed.
export const cleanContact = (contact) =>
  Object.fromEntries(Object.keys(CONTACT_FIELDS).filter((key) => contact?.[key]).map((key) => [key, String(contact[key]).trim()]));

// ------------------------------------------------------------------ orders

export const ACTIONS = ['register', 'transfer', 'renew'];

// Returns [status, message] if a checkout request is malformed, else null. Availability and prices are
// checked by the caller against the registrar.
export function checkoutError(body) {
  if (!body || typeof body !== 'object') return [400, 'Invalid JSON body.'];
  if (!ACTIONS.includes(body.action)) return [400, 'Action must be register, transfer or renew.'];
  if (!cleanDomain(body.domain)) return [400, 'Enter a domain like example.com.'];
  const years = body.years ?? 1;
  if (!Number.isInteger(years) || years < 1 || years > MAX_YEARS) return [400, `Years must be 1 to ${MAX_YEARS}.`];
  if (body.action === 'transfer') {
    if (years !== 1) return [400, 'Transfers add exactly one year.'];
    if (typeof body.authCode !== 'string' || !body.authCode.trim() || body.authCode.length > 1024) return [400, 'Enter the transfer (EPP) code from your current registrar.'];
  }
  if (body.action !== 'renew') return contactError(body.contact);
  return null;
}

// The amount charged for an order: the first year at the action's price, extra years at the renewal price.
export function orderAmount(q, action, years) {
  const first = action === 'register' ? q.register : action === 'transfer' ? q.transfer : null;
  if (action === 'renew') return Number.isFinite(q.renew) ? q.renew * years : null;
  if (!Number.isFinite(first) || !Number.isFinite(q.renew)) return null;
  return first + q.renew * (years - 1);
}

// ------------------------------------------------------------------ DNS records

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i;

// The record's full name in `domain`: "@" or "" is the domain itself, "www" is www.domain.
export function recordName(name, domain) {
  const raw = String(name ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || raw === '@' || raw === domain) return domain;
  const host = raw.endsWith(`.${domain}`) ? raw : `${raw}.${domain}`;
  return HOST_RE.test(host) || /^\*\./.test(host) ? host : null;
}

// Route 53 wants TXT values quoted, in 255-character strings.
export function txtValue(text) {
  const raw = String(text);
  const unwrapped = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  const chunks = unwrapped.match(/[\s\S]{1,255}/g) || [''];
  return chunks.map((chunk) => `"${chunk.replace(/["\\]/g, '\\$&')}"`).join(' ');
}

// Returns [status, message] or null for a record set { type, name, values[], ttl }. A zone's root can't
// be a CNAME, but a subdomain someone holds inside our zone (shop.lyr.cloud) can: pass apexCname.
export function recordError(record, domain, { apexCname = false } = {}) {
  if (!record || !RECORD_TYPES.includes(record.type)) return [400, `Type must be one of ${RECORD_TYPES.join(', ')}.`];
  const name = recordName(record.name, domain);
  if (!name) return [400, 'Enter a valid record name, or @ for the domain itself.'];
  const values = Array.isArray(record.values) ? record.values.map((v) => String(v).trim()).filter(Boolean) : [];
  if (!values.length || values.length > 20) return [400, 'Add between 1 and 20 values.'];
  const ttl = record.ttl ?? 300;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) return [400, 'TTL must be 60 to 86400 seconds.'];
  const check = {
    A: [(v) => IPV4_RE.test(v), 'Enter IPv4 addresses like 203.0.113.10.'],
    AAAA: [(v) => /^[0-9a-f:]{2,39}$/i.test(v) && v.includes(':'), 'Enter IPv6 addresses like 2001:db8::1.'],
    CNAME: [(v) => HOST_RE.test(v), 'Enter a hostname like target.example.net.'],
    MX: [(v) => /^\d{1,5}\s+\S+$/.test(v) && HOST_RE.test(v.split(/\s+/)[1]), 'Use "priority host", like "10 mail.example.com".'],
    TXT: [(v) => v.length <= 4000, 'TXT values are at most 4000 characters.'],
  }[record.type];
  if (!values.every(check[0])) return [400, check[1]];
  if (record.type === 'CNAME' && name === domain && !apexCname) return [400, 'The domain itself can’t be a CNAME. Use an A record.'];
  if (record.type === 'CNAME' && values.length > 1) return [400, 'A CNAME has exactly one target.'];
  return null;
}

// Our record -> a Route 53 ResourceRecordSet.
export function route53RecordSet(record, domain) {
  const values = record.values.map((v) => String(v).trim()).filter(Boolean);
  return {
    Name: recordName(record.name, domain),
    Type: record.type,
    TTL: record.ttl ?? 300,
    ResourceRecords: values.map((value) => ({ Value: record.type === 'TXT' ? txtValue(value) : value })),
  };
}

// A Route 53 ResourceRecordSet -> our record, or null for ones customers don't edit (NS/SOA at the apex, aliases).
export function fromRecordSet(set, domain) {
  const name = String(set.Name).replace(/\.$/, '').replace(/\\052/g, '*');
  if (!RECORD_TYPES.includes(set.Type) || set.AliasTarget) return null;
  const values = (set.ResourceRecords || []).map(({ Value }) =>
    set.Type === 'TXT' ? Value.match(/"((?:[^"\\]|\\.)*)"/g)?.map((part) => part.slice(1, -1).replace(/\\(.)/g, '$1')).join('') ?? Value : Value.replace(/\.$/, ''),
  );
  return { type: set.Type, name, label: name === domain ? '@' : name.slice(0, -(domain.length + 1)), values, ttl: set.TTL ?? null };
}

// ------------------------------------------------------------------ Stripe

// Verifies a Stripe-Signature header ("t=…,v1=…,v1=…") for the raw request body.
export function validStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300) {
  if (!header || !secret) return false;
  const parts = String(header).split(',').map((part) => part.split('='));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isFinite(timestamp) || !signatures.length || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'));
  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// Nested params -> Stripe's form encoding: { a: { b: 1 }, c: [{ d: 2 }] } -> a[b]=1&c[0][d]=2.
export function stripeForm(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') stripeForm(Array.isArray(value) ? Object.fromEntries(value.map((v, i) => [i, v])) : value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export const stripeMode = (secretKey) => (String(secretKey).startsWith('sk_live_') || String(secretKey).startsWith('rk_live_') ? 'live' : 'test');

// When an auto-renewing domain should be charged: RENEW_DAYS_BEFORE days before it expires.
export const renewalDue = (expiresAt, now = Date.now()) => Boolean(expiresAt) && new Date(expiresAt).getTime() - now <= RENEW_DAYS_BEFORE * 86_400_000;

// ------------------------------------------------------------------ name.lyr.cloud subdomains

// Labels kept for Lyrcloud in the subdomain zone.
export const RESERVED_SUBDOMAINS = ['www', 'mail', 'email', 'smtp', 'imap', 'pop', 'mx', 'api', 'app', 'admin', 'dash', 'dashboard', 'dns', 'ns', 'ns1', 'ns2', 'ns3', 'ns4',
  'lyr', 'lyrcloud', 'support', 'help', 'status', 'blog', 'docs', 'cdn', 'static', 'assets', 'billing', 'account', 'login', 'auth', 'secure', 'root', 'test', 'dev', 'staging'];
export const MAX_SUBDOMAINS = 5;
export const MAX_LYR_RESERVATIONS = 3;

// "My-Shop" -> "my-shop"; null if it can't be a label (letters, digits, hyphens, 1-63 characters).
export function cleanLabel(input) {
  const label = String(input || '').trim().toLowerCase();
  if (!LABEL_RE.test(label) || (label.slice(2, 4) === '--' && !label.startsWith('xn--'))) return null;
  return label;
}
