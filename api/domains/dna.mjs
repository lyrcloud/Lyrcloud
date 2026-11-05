// DNA Rest API (Domain Name API, https://www.domainnameapi.com/docs/llms.txt): the registrar Lyrcloud
// resells domains from. JSON over HTTPS with two headers, X-API-KEY and __reseller. This file has the
// HTTP client and the pure translations between DNA's shapes and ours; index.mjs decides when to call.
import { randomUUID } from 'node:crypto';
import { cleanContact, RECORD_TYPES, recordName } from './rules.mjs';

export const DNA_LIVE = 'https://api.domainresellerapi.com';
// The test environment: same paths and reseller ID, a separate API key, simulated registry, never charged.
// Its DNS records endpoints answer 500, so zones are only touched for live domains.
export const DNA_TEST = 'https://ote.domainresellerapi.com';
// DNA's own name servers. Registering with them makes the DNS records API serve the domain for free.
export const DNA_NAMESERVERS = ['tr.domainnameapi.com', 'eu.domainnameapi.com'];

export class DnaError extends Error {
  constructor(message, { status = 502, code = null, details = null, data = null } = {}) {
    super(message);
    this.name = 'DnaError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.data = data;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One DNA call. Branches on DNA's error code, never the HTTP status alone (docs: "Error format").
// Redirects are not followed: a wrong key or unknown reseller is answered with a 302 to /Error/Suspend
// (seen on the test environment, undocumented), which is an authentication failure, not a page to read.
export async function dnaCall({ base, apiKey, resellerId }, method, path, { query, body, timeoutMs = 25_000 } = {}) {
  const url = new URL(`/api/v1/${path}`, base);
  for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        'X-API-KEY': apiKey,
        __reseller: resellerId,
        'X-Correlation-ID': `lyrcloud-${randomUUID()}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Over the quota DNA slows answers by up to 5 s rather than refusing them.
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Over 5 requests a second (2 for searches): wait as told, once.
    if (res.status === 429 && attempt === 0) {
      await sleep(Math.min(Number(res.headers.get('retry-after')) || 1, 3) * 1000);
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      throw new DnaError('The registrar refused Lyrcloud’s API key.', { status: 401, code: 'Lyrcloud:RegistrarAuth', details: res.headers.get('location') });
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;
    if (res.status === 401) throw new DnaError('The registrar refused Lyrcloud’s API key.', { status: 401, code: 'Lyrcloud:RegistrarAuth', details: text.slice(0, 200) });
    if (res.status === 429) throw new DnaError('The registrar is busy. Try again in a moment.', { status: 429, code: 'Lyrcloud:RateLimited' });
    const err = data?.error || {};
    const validation = (err.validationErrors || []).map((item) => item.message).filter(Boolean).join(' ');
    throw new DnaError(validation || err.message || `The registrar answered ${res.status}.`, { status: res.status, code: err.code || null, details: err.details || null, data: err.data || null });
  }
}

// The codes DNA says must never be retried: the registry already did the work and only DNA's own record
// failed. Treat the operation as started and reconcile, or the customer is charged twice.
// 10058 also means "name mixes alphabets" (input rejected, nothing happened); the message tells them apart.
export function alreadyDone(err) {
  if (!(err instanceof DnaError)) return false;
  if (err.code === 'Dna.DomainService:Domain:10059' || err.code === 'Dna.DomainService:Domain:10060') return true;
  return err.code === 'Dna.DomainService:Domain:10058' && !/script|alphabet/i.test(`${err.message} ${err.details || ''}`);
}

// DNA runs on Turkish time. Some answers carry the offset ("2027-11-05T05:23:33.6275008+03:00" from
// /register), others leave it off for the same moment ("2027-11-05T05:23:33.627" from /domains/info), so a
// date without a zone is +03:00 (Turkey has had no daylight saving time since 2016). Fractions are cut to ms.
export function dnaDate(value) {
  if (!value || String(value).startsWith('0001-')) return null;
  const text = String(value).replace(/(\.\d{3})\d+/, '$1');
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}+03:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ------------------------------------------------------------------ prices

const yearPrice = (list) => {
  const entry = (list || []).find((item) => item?.period === 1);
  return entry && Number.isFinite(entry.price) && (!entry.currency || entry.currency === 'USD') ? entry.price : null;
};

// The TLD catalogue (GET /products/tlds?currency=USD) -> { [tld]: { register, renew, transfer, ... } } in USD a year,
// read from the price group the account belongs to. Extensions that need extra registry fields, documents
// or a trustee are marked `plain: false`; the checkout doesn't collect those, so they aren't sold.
export function dnaPriceTable(items, group) {
  const table = {};
  for (const item of items || []) {
    if (!item?.name) continue;
    const prices = item.prices || [];
    const set = prices.find((entry) => entry.priceGroup === group) || prices[0];
    if (!set) continue;
    const register = yearPrice(set.register);
    if (!Number.isFinite(register)) continue;
    table[item.name] = {
      register,
      renew: yearPrice(set.renew),
      transfer: yearPrice(set.transfer),
      registerYears: item.registrationPeriods || [],
      renewYears: item.renewalPeriods || [],
      privacy: item.isPrivacyAvailable === true,
      transferable: item.isSupportTransfer !== false,
      transferCheck: item.isTransferCheckSupported !== false,
      plain: !item.isTrusteeRequired && !item.isRequireDocument && !(item.attributes || []).some((attribute) => attribute.isRequired && attribute.type !== 'Label'),
    };
  }
  return table;
}

// ------------------------------------------------------------------ availability

// A search answer (POST /domains/search `info`, or one of bulk-search's `infos`) -> our status words.
// Premium names have their own one-year registry price and names that need documents wait on the
// registry; the checkout handles neither, so neither is offered.
export function dnaAvailability(info) {
  if (!info) return 'DONT_KNOW';
  if (info.status === 'AVAILABLE') return info.isPremium ? 'PREMIUM' : info.isDocumentRequired ? 'DOCUMENTS' : 'AVAILABLE';
  return { NOTAVAILABLE: 'UNAVAILABLE', UNSUPPORTEDTLD: 'NOT_SOLD', INVALIDDOMAINNAME: 'INVALID' }[info.status] || 'DONT_KNOW';
}

// Why a transfer can't start, in words, for /transfers/check and /transfer error codes.
export const TRANSFER_REFUSALS = {
  'Dna.DomainService:Domain:10008': 'The registry didn’t accept that transfer (EPP) code. Get a fresh one from your current registrar.',
  'Dna.DomainService:Domain:10047': 'The registry didn’t accept that transfer (EPP) code. Get a fresh one from your current registrar.',
  'Dna.DomainService:Domain:10035': 'That transfer (EPP) code is the wrong length for this domain ending.',
  'Dna.DomainService:Domain:10006': 'This domain is locked. Unlock it at your current registrar, then try again.',
  'Dna.DomainService:Domain:10029': 'A transfer for this domain is already in progress. Wait for it to finish.',
  'Dna.DomainService:Domain:10028': 'A transfer for this domain is already in progress. Wait for it to finish.',
  'Dna.DomainService:Domain:10031': 'Domains can’t move within 60 days of being registered or transferred.',
  'Dna.DomainService:Domain:10057': 'Domains can’t move within 60 days of being registered or transferred.',
  'Dna.DomainService:Domain:10024': 'The registry doesn’t allow this domain to be transferred.',
  'Dna.DomainService:Domain:10039': 'This domain isn’t registered yet. Register it instead.',
  'Dna.DomainService:Epp:2303': 'This domain isn’t registered yet. Register it instead.',
  'Dna.DomainService:Domain:1024': 'This domain is already with Lyrcloud’s registrar.',
};

// What a refused renewal check means, for /renew/check's errorMessageKey.
export const RENEW_REFUSALS = {
  'Dna.DomainService:Domain:10045': 'The registry has blocked renewals for this domain.',
  'Dna.DomainService:Domain:1016': 'That would renew the domain past the longest term its registry allows.',
  'Dna.DomainService:Domain:1028': 'That would renew the domain past the longest term its registry allows.',
  'Dna.DomainService:Domain:10071': 'Premium domains renew one year at a time.',
  'Dna.DomainService:Domain:10021': 'This domain can’t be renewed this early. Try again within 60 days of its expiry.',
  'Dna.DomainService:Domain:10018': 'This domain can’t be renewed in its current state.',
};

// ------------------------------------------------------------------ contacts

// Our contact shape -> a DNA contact. DNA strips characters it doesn't accept from names and addresses,
// wants the street on one line, a state even where there are none, and phone parts as digits only.
export function dnaContact(contact) {
  const c = cleanContact(contact);
  const digits = (value) => String(value || '').replace(/\D/g, '');
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    ...(c.organization ? { companyName: c.organization } : {}),
    eMail: c.email,
    address: [c.address1, c.address2].filter(Boolean).join(', '),
    city: c.city,
    state: c.state || c.city,
    postalCode: c.zip,
    country: c.country,
    phoneCountryCode: digits(c.phoneCountry),
    phone: digits(c.phone),
  };
}

// ------------------------------------------------------------------ DNS records

const unquoteTxt = (value) => {
  const parts = String(value).match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((part) => part.slice(1, -1).replace(/\\(.)/g, '$1')).join('') : String(value);
};

// GET /domains/zones -> our records, leaving out the ones customers don't edit (SOA, NS, ALIAS, ...).
export function fromDnaZone(sets, domain) {
  const records = [];
  for (const set of sets || []) {
    if (!RECORD_TYPES.includes(set?.type)) continue;
    const name = String(set.name || '').toLowerCase().replace(/\.$/, '');
    const values = (set.records || []).filter((record) => !record.disabled)
      .map((record) => (set.type === 'TXT' ? unquoteTxt(record.content) : String(record.content).replace(/\.$/, '')));
    if (!values.length) continue;
    records.push({ type: set.type, name, label: name === domain ? '@' : name.slice(0, -(domain.length + 1)), values, ttl: set.ttl ?? null });
  }
  return records;
}

// The label DNA wants for a record: "@" for the domain itself, "www" for www.domain.
export function dnaLabel(name, domain) {
  const full = recordName(name, domain);
  return full === domain ? '@' : full.slice(0, -(domain.length + 1));
}

// Our record -> DNA's zoneStruct. TXT goes unquoted; DNA adds the quotes.
export function zoneStruct(record, domain) {
  const values = record.values.map((value) => String(value).trim()).filter(Boolean)
    .map((value) => (record.type === 'TXT' && value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value));
  return { name: dnaLabel(record.name, domain), type: record.type, ttl: record.ttl ?? 300, contents: values };
}
