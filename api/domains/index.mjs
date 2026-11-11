// Lyrcloud Domains API: search, buy, transfer in and renew domains, resold from DNA (Domain Name API,
// dna.mjs) with Lyrcloud's commission on top (rules.mjs) and paid with Stripe Checkout.
//
//   GET    /public/domains/search?q=name     availability and prices for a name across TLDs
//   GET    /public/domains/prices            the price list for every TLD Lyrcloud sells
//   POST   /public/stripe/webhook            Stripe events: payment done -> register/transfer/renew
//   POST   /public/lyrpay/callback           Lyrpay: paid from a Lyrpay balance -> register/transfer/renew (lyrpay.mjs)
//   GET    /domains                          your domains, your saved registrant contact, payments status
//   POST   /domains/checkout                 { action, domain, years?, autoRenew?, contact?, authCode?, payWith? } -> Stripe
//                                            URL, or the Lyrpay page with payWith: 'lyrpay'
//   GET    /domains/{name}                   one domain, its registrar details, DNS records and e-mail verification
//   PUT    /domains/{name}                   { autoRenew }
//   POST   /domains/{name}/verify-email      send the registrant's verification e-mail again
//   PUT    /domains/{name}/records           { type, name, values[], ttl? } create or replace a record set
//   DELETE /domains/{name}/records?type=&name=   delete a record set
//   POST   /domains/subdomains               { label, autoRenew? } claim label.<SUBDOMAIN_ZONE>: free on some plans, else Stripe
//   GET|PUT|DELETE /domains/subdomains/{label}   one subdomain; { autoRenew }; release it
//   PUT|DELETE /domains/subdomains/{label}/records   its DNS records, as for domains
//   POST   /domains/lyr-waitlist             { name } reserve a .lyr name for free, for when .lyr becomes official
//   DELETE /domains/lyr-waitlist/{name}      give the reservation up
//   GET    /admin/domains                    every domain and recent order (staff)
//   GET    /admin/domain-pricing             commission settings, cost and price per TLD, Stripe status (staff)
//   PUT    /admin/domain-pricing             { percent?, flatCents?, dnsCentsPerYear?, round99?, tlds?, overrides? } (super admin)
//   PUT    /admin/stripe                     { secretKey } connect Stripe and register the webhook (super admin)
//   DELETE /admin/stripe                     disconnect Stripe (super admin)
//
// The .lyr namespace (preview, lyrdns.mjs; not an ICANN TLD and not for sale yet):
//   GET|POST /dns-query                      Lyrcloud's DNS-over-HTTPS resolver: answers .lyr, forwards the rest
//   GET    /public/lyr/lookup?name=&type=    a .lyr name's answer as JSON (for the /lyr/ page)
//   GET    /public/lyr/available?name=       whether a .lyr name can be reserved
//   GET    /admin/lyr                        every .lyr name (staff)
//   PUT    /admin/lyr/{name}                 { owner?, note?, records[] } create or update a name (super admin)
//   DELETE /admin/lyr/{name}                 release a name (super admin)
//
// Money only moves one way: the customer pays Lyrcloud first, and only then does Lyrcloud buy the domain
// from DNA, out of Lyrcloud's prepaid DNA balance. If the registrar refuses, the payment is refunded. A
// scheduled run (every 15 minutes) follows registrations and transfers until they're live, and charges the
// saved card for renewals RENEW_DAYS_BEFORE days ahead, renewing at DNA only once that charge succeeds.
// Stripe test-mode orders go to DNA's test environment, which simulates the registry and charges nothing.
//
// Domains registered here get DNA's name servers and are edited through DNA's free DNS records API.
// Domains from before the switch to DNA were bought from Route 53 Domains (no `registrar` field); their
// Route 53 hosted zones can still be edited, but nothing renews or follows them automatically any more.
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import {
  alreadyDone,
  dnaAvailability,
  dnaCall,
  dnaContact,
  dnaDate,
  DnaError,
  DNA_LIVE,
  DNA_NAMESERVERS,
  dnaPriceTable,
  DNA_TEST,
  fromDnaZone,
  dnaLabel,
  RENEW_REFUSALS,
  TRANSFER_REFUSALS,
  zoneStruct,
} from './dna.mjs';
import { isStaff, planFor, roleFor } from '../account/roles.mjs';
import * as lyrpay from './lyrpay.mjs';
import {
  answerLyr,
  buildResponse,
  cleanLyrName,
  DnsFormatError,
  fromJsonAnswers,
  isLyrQuestion,
  isReservedLyr,
  lyrRecordsError,
  parseQuery,
  RCODE,
  registeredLyrName,
  TYPES,
} from './lyrdns.mjs';
import {
  checkoutError,
  cleanContact,
  cleanLabel,
  cleanDomain,
  HOLD_MINUTES,
  MAX_LYR_RESERVATIONS,
  MAX_SUBDOMAINS,
  orderAmount,
  pricingConfig,
  pricingError,
  quote,
  recordError,
  recordName,
  renewalDue,
  RESERVED_SUBDOMAINS,
  route53RecordSet,
  fromRecordSet,
  searchName,
  stripeFeeCents,
  stripeForm,
  stripeMode,
  tldOf,
  validStripeSignature,
} from './rules.mjs';

const env = process.env;
const TABLE = env.TABLE_NAME;
const USERS_TABLE = env.USERS_TABLE_NAME;
const STRIPE_SECRET_NAME = env.STRIPE_SECRET_NAME;
// DNA credentials: { apiKey, resellerId, testApiKey }, written by deploy-domains.sh.
const DNA_SECRET_NAME = env.DNA_SECRET_NAME;
const SUPER_ADMIN_EMAIL = env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com';
// name.<zone> subdomains (lyr.cloud): off until the zone is registered and both are set (deploy-domains.sh finds them).
const SUB_ZONE = env.SUBDOMAIN_ZONE || '';
const SUB_ZONE_ID = env.SUBDOMAIN_ZONE_ID || '';
const SITE_URL = env.SITE_URL || 'https://www.lyrcloud.com';
const ALLOWED_ORIGINS = String(env.ALLOWED_ORIGINS || SITE_URL).split(',').map((origin) => origin.trim());

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const secrets = new SecretsManagerClient({});
// Route 53 still hosts the name.lyr.cloud zone and the zones of domains bought before the switch to DNA.
export const dns = new Route53Client({ region: 'us-east-1' });

const STRIPE_EVENTS = ['checkout.session.completed', 'checkout.session.expired'];
const LIVE_STATUSES = ['registering', 'transferring', 'active'];
const PRICES_MAX_AGE_MS = 12 * 3600_000;
const AVAILABILITY_CACHE_SECONDS = 300;

// ---------------------------------------------------------------- helpers

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const error = (statusCode, message) => json(statusCode, { error: message });
const now = () => new Date().toISOString();
const rawBody = (event) => (event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '');
function parseJson(event) {
  try {
    return JSON.parse(rawBody(event) || '{}');
  } catch {
    return null;
  }
}

const domainKey = (domain) => ({ pk: `domain#${domain}`, sk: 'domain' });
const orderKey = (orderId) => ({ pk: `order#${orderId}`, sk: 'order' });
const billingKey = (userId) => ({ pk: `user#${userId}`, sk: 'billing' });
// Pricing moved to a new key with the switch to DNA, so the commission starts at DNA's defaults (1%)
// instead of the margin set for Route 53's higher prices. The old settings seed it (see getPricing).
const PRICING_KEY = { pk: '#pricing', sk: 'dna' };
const LEGACY_PRICING_KEY = { pk: '#pricing', sk: 'config' };
const PRICES_KEY = { pk: '#prices', sk: 'dna' };

const getItem = async (key) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: key }))).Item;
const isConditionFailure = (err) => err?.name === 'ConditionalCheckFailedException';

// SET/REMOVE fields on an item; `condition` is [expression, names, values].
async function update(key, set, remove = [], condition) {
  const names = { ...(condition?.[1] || {}) };
  const values = { ...(condition?.[2] || {}) };
  const parts = Object.entries(set).filter(([, value]) => value !== undefined).map(([field, value], i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = value;
    return `#f${i} = :v${i}`;
  });
  const removes = remove.map((field, i) => {
    names[`#r${i}`] = field;
    return `#r${i}`;
  });
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: key,
    UpdateExpression: [parts.length ? `SET ${parts.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' '),
    ...(condition ? { ConditionExpression: condition[0] } : {}),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
    ReturnValues: 'ALL_NEW',
  }));
  return Attributes;
}

async function collect(Command, input) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new Command({ TableName: TABLE, ...input, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const itemsOf = (ownerId) => collect(QueryCommand, {
  IndexName: 'byOwner',
  KeyConditionExpression: 'ownerId = :o',
  ExpressionAttributeValues: { ':o': ownerId },
  ScanIndexForward: false,
});

// Runs `work` over `items`, `limit` at a time.
async function pool(items, limit, work) {
  const queue = [...items];
  const results = new Map();
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.set(item, await work(item));
    }
  }));
  return items.map((item) => results.get(item));
}

function siteOrigin(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  return ALLOWED_ORIGINS.includes(origin) ? origin : SITE_URL;
}

// ---------------------------------------------------------------- settings, prices and Stripe

// The commission settings. Until the super admin saves them under PRICING_KEY, they're the defaults with
// the old Route 53-era settings' TLD list and subdomain prices kept (their commission is not carried over).
const DNA_PRICING_DEFAULTS = { percent: 1, flatCents: 0, dnsCentsPerYear: 0, round99: false, overrides: {} };
let pricingCache = { value: null, at: 0 };
async function getPricing() {
  if (!pricingCache.value || Date.now() - pricingCache.at > 30_000) {
    const stored = (await getItem(PRICING_KEY))?.config;
    const legacy = stored ? null : (await getItem(LEGACY_PRICING_KEY))?.config;
    pricingCache = { value: pricingConfig(stored || (legacy ? { ...legacy, ...DNA_PRICING_DEFAULTS } : undefined)), at: Date.now() };
  }
  return pricingCache.value;
}

// DNA credentials. `test` picks the test environment (its own key, same reseller ID).
let dnaCache = { value: null, at: 0 };
async function getDnaConfig() {
  if (env.DNA_JSON) return JSON.parse(env.DNA_JSON);
  if (!DNA_SECRET_NAME) return {};
  if (!dnaCache.value || Date.now() - dnaCache.at > 300_000) {
    const raw = (await secrets.send(new GetSecretValueCommand({ SecretId: DNA_SECRET_NAME }))).SecretString;
    dnaCache = { value: JSON.parse(raw || '{}'), at: Date.now() };
  }
  return dnaCache.value;
}

// One DNA call, live unless `registrarEnv` is 'test'.
async function dna(method, path, options, registrarEnv = 'live') {
  const config = await getDnaConfig();
  const test = registrarEnv === 'test';
  const apiKey = test ? config.testApiKey : config.apiKey;
  if (!apiKey || !config.resellerId) throw new DnaError('The registrar isn’t connected yet.', { status: 503, code: 'Lyrcloud:RegistrarNotConnected' });
  return dnaCall({ base: test ? DNA_TEST : DNA_LIVE, apiKey, resellerId: config.resellerId }, method, path, options);
}

// What DNA charges, per TLD, refreshed twice a day: the live catalogue, read for the account's price group.
let pricesCache = { value: null, at: 0 };
async function wholesale() {
  if (pricesCache.value && Date.now() - pricesCache.at < PRICES_MAX_AGE_MS) return pricesCache.value;
  const stored = await getItem(PRICES_KEY);
  if (stored && Date.now() - Date.parse(stored.fetchedAt) < PRICES_MAX_AGE_MS) {
    pricesCache = { value: stored.table, at: Date.parse(stored.fetchedAt) };
    return stored.table;
  }
  let table;
  try {
    const account = await dna('GET', 'deposit/accounts/me');
    const items = [];
    for (let skip = 0; ; skip += 1000) {
      const page = await dna('GET', 'products/tlds', { query: { maxResultCount: 1000, skipCount: skip, currency: 'USD' } });
      items.push(...(page?.items || []));
      if (!page?.items?.length || items.length >= (page.totalCount ?? 0)) break;
    }
    table = dnaPriceTable(items, account?.resellerGroupName);
  } catch (err) {
    // Keep selling at the last known prices if DNA is briefly unreachable; nothing is sold without any.
    console.error('DNA price list failed', err.code || err.name, err.message);
    if (stored?.table) return stored.table;
    if (err instanceof DnaError && err.status === 503) return {};
    throw err;
  }
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...PRICES_KEY, table, fetchedAt: now() } }));
  pricesCache = { value: table, at: Date.now() };
  return table;
}

const sellable = (prices, config, tld) => config.tlds.includes(tld) && prices[tld]?.plain !== false
  && Number.isFinite(prices[tld]?.register) && Number.isFinite(prices[tld]?.renew);
// Whether the domain's DNS is hosted by Lyrcloud: DNA's zones for domains registered here, a Route 53
// hosted zone for ones bought before the switch.
const lyrcloudDns = (item) => item.dnsProvider === 'dna' || Boolean(item.hostedZoneId);

// Stripe credentials ({} until the super admin connects Stripe). Re-read every minute.
let stripeCache = { value: null, at: 0 };
async function getStripe() {
  if (env.STRIPE_JSON) return JSON.parse(env.STRIPE_JSON);
  if (!stripeCache.value || Date.now() - stripeCache.at > 60_000) {
    const raw = (await secrets.send(new GetSecretValueCommand({ SecretId: STRIPE_SECRET_NAME }))).SecretString;
    stripeCache = { value: JSON.parse(raw || '{}'), at: Date.now() };
  }
  return stripeCache.value;
}
async function saveStripe(value) {
  await secrets.send(new PutSecretValueCommand({ SecretId: STRIPE_SECRET_NAME, SecretString: JSON.stringify(value) }));
  stripeCache = { value, at: Date.now() };
}

// Pay with Lyrpay keys ({} until the lyrcloud/lyrpay secret exists). Re-read every minute.
let lyrpayCache = { value: null, at: 0 };
async function getLyrpay() {
  if (env.LYRPAY_JSON) return JSON.parse(env.LYRPAY_JSON);
  if (!env.LYRPAY_SECRET_NAME) return {};
  if (!lyrpayCache.value || Date.now() - lyrpayCache.at > 60_000) {
    let value = {};
    try {
      value = JSON.parse((await secrets.send(new GetSecretValueCommand({ SecretId: env.LYRPAY_SECRET_NAME }))).SecretString || '{}');
    } catch (err) {
      if (err.name !== 'ResourceNotFoundException') console.error('Lyrpay keys unreadable', err.name);
    }
    lyrpayCache = { value, at: Date.now() };
  }
  return lyrpayCache.value;
}

export class StripeError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function stripe(method, path, params, { idempotencyKey, secretKey } = {}) {
  const key = secretKey || (await getStripe()).secretKey;
  if (!key) throw new StripeError('Payments aren’t set up yet.', 503);
  const form = stripeForm(params).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && form ? `?${form}` : ''}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(method !== 'GET' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: method === 'GET' ? undefined : form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(data.error?.message || `Stripe returned ${res.status}`, res.status, data.error?.code);
  return data;
}

// ---------------------------------------------------------------- callers

async function caller(event) {
  const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!userId) return null;
  const profile = (await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }))).Item || { userId };
  return { userId, profile, role: roleFor(profile, SUPER_ADMIN_EMAIL), plan: planFor(profile), email: profile.email || null };
}

// ---------------------------------------------------------------- availability

// Our words for DNA's answers: AVAILABLE, UNAVAILABLE, PREMIUM, DOCUMENTS, NOT_SOLD, INVALID or DONT_KNOW
// (dnaAvailability). Cached briefly so searches stay cheap; DNA allows 2 searches a second.
const availKey = (domain) => ({ pk: `avail#${domain}`, sk: 'avail' });
async function cacheAvailability(domain, status) {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...availKey(domain), availability: status, expiresAt: Math.floor(Date.now() / 1000) + AVAILABILITY_CACHE_SECONDS } }));
}

async function availability(domain, { fresh = false } = {}) {
  if (!fresh) {
    const cached = await getItem(availKey(domain));
    if (cached && cached.expiresAt > Date.now() / 1000) return cached.availability;
  }
  const answer = await dna('POST', 'domains/search', { body: { domainName: domain } });
  const status = dnaAvailability(answer?.info);
  await cacheAvailability(domain, status);
  return status;
}

// Several names at once with bulk-search (30 a call). DNA silently drops names it can't answer, so
// results are matched by name, and a missing one is "don't know", never "available".
async function availabilityMany(domains) {
  const statuses = new Map();
  const unknown = [];
  await pool(domains, 4, async (domain) => {
    const cached = await getItem(availKey(domain));
    if (cached && cached.expiresAt > Date.now() / 1000) statuses.set(domain, cached.availability);
    else unknown.push(domain);
  });
  for (let i = 0; i < unknown.length; i += 30) {
    const batch = unknown.slice(i, i + 30);
    try {
      const answer = await dna('POST', 'domains/bulk-search', { body: batch.map((domainName) => ({ domainName })) });
      const byName = new Map((answer?.infos || []).map((info) => [String(info.domainName).toLowerCase(), info]));
      await pool(batch, 4, async (domain) => {
        const status = dnaAvailability(byName.get(domain));
        statuses.set(domain, status);
        if (status !== 'DONT_KNOW') await cacheAvailability(domain, status);
      });
    } catch (err) {
      console.error('bulk search failed', err.code || err.name, err.message);
      for (const domain of batch) statuses.set(domain, 'DONT_KNOW');
    }
  }
  return statuses;
}

const offer = (domain, status, q) => ({ domain, tld: tldOf(domain), available: status === 'AVAILABLE', status, price: q.register, renew: q.renew });

async function search(event) {
  const q = String(event.queryStringParameters?.q || '').slice(0, 253);
  const name = searchName(q);
  if (!name) return error(400, 'Type a name to search for, like mybrand or mybrand.com.');
  const [config, prices] = await Promise.all([getPricing(), wholesale()]);
  const typed = q.includes('.') ? cleanDomain(q) : null;
  // The typed domain and the first two other TLDs are the results; the rest of the sold TLDs, when
  // available, are the suggestions. One bulk-search answers all of them.
  const candidates = [];
  if (typed && sellable(prices, config, tldOf(typed))) candidates.push(typed);
  for (const tld of config.tlds) {
    const domain = cleanDomain(`${name}.${tld}`);
    if (domain && !candidates.includes(domain) && sellable(prices, config, tld) && candidates.length < 30) candidates.push(domain);
  }
  const statuses = await availabilityMany(candidates);
  const offers = candidates.map((domain) => offer(domain, statuses.get(domain) || 'DONT_KNOW', quote(prices, tldOf(domain), config)));
  const results = offers.slice(0, 3);
  if (typed && !sellable(prices, config, tldOf(typed))) {
    results.unshift({ domain: typed, tld: tldOf(typed), available: false, status: 'NOT_SOLD', price: null, renew: null });
  }
  const suggestions = offers.slice(3).filter((item) => item.available).slice(0, 10);
  return json(200, { query: name, currency: 'usd', results, suggestions });
}

async function priceList() {
  const [config, prices] = await Promise.all([getPricing(), wholesale()]);
  const tlds = config.tlds.filter((tld) => sellable(prices, config, tld)).map((tld) => {
    const q = quote(prices, tld, config);
    return { tld, register: q.register, renew: q.renew, transfer: q.transfer };
  });
  return json(200, { currency: 'usd', tlds });
}

// ---------------------------------------------------------------- domains

// The domain as the browser sees it.
function publicDomain(item, config, prices) {
  const q = prices && config ? quote(prices, item.tld, config) : null;
  return {
    domain: item.domain,
    tld: item.tld,
    status: item.status,
    action: item.action,
    autoRenew: item.autoRenew === true,
    expiresAt: item.expiresAt || null,
    nameservers: item.nameservers || [],
    lyrcloudDns: lyrcloudDns(item),
    testRegistry: item.registrarEnv === 'test',
    createdAt: item.createdAt,
    activatedAt: item.activatedAt || null,
    holdUntil: item.status === 'awaiting_payment' ? item.holdUntil : null,
    checkoutUrl: item.status === 'awaiting_payment' ? item.checkoutUrl || null : null,
    operationStatus: item.operationStatus || null,
    operationMessage: item.operationMessage || null,
    failureReason: item.failureReason || null,
    renewing: item.renewing === true,
    lastRenewalError: item.lastRenewalError || null,
    renewPrice: q ? (lyrcloudDns(item) ? q.renew : q.renewNoDns) : null,
    hasCard: Boolean(item.paymentMethodId),
  };
}

const publicOrder = (order) => ({
  orderId: order.orderId,
  domain: order.domain,
  action: order.action,
  years: order.years,
  amount: order.amountCents,
  status: order.status,
  auto: order.auto === true,
  createdAt: order.createdAt,
  failureReason: order.failureReason || null,
});

// A hold that nobody paid for: it can be taken over.
const staleHold = (item) => item.status === 'awaiting_payment' && Date.parse(item.holdUntil) < Date.now();

async function myDomains(who) {
  const [items, billing, config, prices, stripeConfig] = await Promise.all([itemsOf(who.userId), getItem(billingKey(who.userId)), getPricing(), wholesale(), getStripe()]);
  const domains = items.filter((item) => item.kind === 'domain' && !staleHold(item)).map((item) => publicDomain(item, config, prices));
  const orders = items.filter((item) => item.kind === 'order' && item.status !== 'open' && item.status !== 'expired').slice(0, 20).map(publicOrder);
  const subdomains = {
    enabled: subdomainsOn(),
    zone: SUB_ZONE || null,
    price: config.subdomainCents,
    freeWithPlan: config.subdomainFreePlans.includes(who.plan),
    freePlans: config.subdomainFreePlans,
    items: items.filter((item) => item.kind === 'subdomain' && !staleHold(item) && item.status !== 'expired').map((item) => publicSubdomain(item, config)),
  };
  const lyrReservations = items.filter((item) => item.kind === 'lyrwait').map((item) => ({ name: item.name, createdAt: item.createdAt }));
  return json(200, { domains, orders, subdomains, lyrReservations, contact: billing?.contact || null, paymentsReady: Boolean(stripeConfig.secretKey), lyrpayReady: Boolean(stripeConfig.secretKey) && lyrpay.usable(await getLyrpay()), currency: 'usd' });
}

const UNTRANSFERABLE = 'This domain can’t be transferred right now. Unlock it at your current registrar, and note that domains can’t move within 60 days of being registered or transferred.';

// Asks DNA whether `domain` can move to Lyrcloud with `authCode`. Returns a refusal message, or null.
// DNA answers a refusal with an error code rather than a false field (docs: "Transfer a domain in").
async function transferRefusal(domain, authCode, prices) {
  const facts = prices[tldOf(domain)];
  if (facts?.transferable === false) return `.${tldOf(domain)} domains can’t be transferred to Lyrcloud.`;
  if (facts?.transferCheck === false) return null; // the registry has no pre-transfer check; /transfer decides
  try {
    const check = await dna('POST', 'domains/transfers/check', { body: { domainName: domain, authCode } });
    if (check?.isPremium) return 'Premium domains can’t be transferred to Lyrcloud yet.';
    if (check?.transferLock) return TRANSFER_REFUSALS['Dna.DomainService:Domain:10006'];
    if (check && check.authCodeIsValid === false) return TRANSFER_REFUSALS['Dna.DomainService:Domain:10008'];
    if (check && check.transferAvailabilityStatus === false) return check.message || UNTRANSFERABLE;
    return null;
  } catch (err) {
    if (!(err instanceof DnaError) || err.status >= 500 || err.status === 429) throw err;
    if (err.code === 'Dna.DomainService:Domain:10025') return null;
    return TRANSFER_REFUSALS[err.code] || err.message || UNTRANSFERABLE;
  }
}

async function checkout(event, who) {
  const body = parseJson(event);
  const refused = checkoutError(body);
  if (refused) return error(...refused);
  const stripeConfig = await getStripe();
  if (!stripeConfig.secretKey) return error(503, 'Domain payments aren’t switched on yet. Please check back soon.');

  const domain = cleanDomain(body.domain);
  const tld = tldOf(domain);
  const { action } = body;
  const years = body.years ?? 1;
  const [config, prices] = await Promise.all([getPricing(), wholesale()]);
  if (!sellable(prices, config, tld)) return error(400, `Lyrcloud doesn’t sell .${tld} domains yet.`);
  const q = quote(prices, tld, config);
  const existing = await getItem(domainKey(domain));

  let amount;
  let costCents;
  const terms = action === 'renew' ? prices[tld]?.renewYears : action === 'register' ? prices[tld]?.registerYears : null;
  if (terms?.length && !terms.includes(years)) return error(400, `.${tld} domains can be ${action === 'renew' ? 'renewed' : 'registered'} for ${[...terms].sort((a, b) => a - b).join(', ')} years.`);
  if (action === 'renew') {
    if (!existing || existing.ownerId !== who.userId) return error(404, 'That domain isn’t in your account.');
    if (existing.registrar !== 'dna') return error(409, 'This domain was bought through Lyrcloud’s previous registrar. Contact support to renew it.');
    if (existing.status !== 'active') return error(409, 'Only active domains can be renewed.');
    if (existing.renewing) return error(409, 'A renewal for this domain is already in progress.');
    const withDns = lyrcloudDns(existing);
    amount = (withDns ? q.renew : q.renewNoDns) * years;
    costCents = (withDns ? q.cost.renew : q.cost.renewNoDns) * years;
  } else {
    if (existing && existing.ownerId === who.userId && LIVE_STATUSES.includes(existing.status)) return error(409, `${domain} is already in your account.`);
    const free = !existing || ['failed', 'cancelled'].includes(existing.status) || staleHold(existing) || (existing.status === 'awaiting_payment' && existing.ownerId === who.userId);
    if (!free) return error(409, `${domain} is being bought by someone else. Try again in half an hour, or pick another name.`);
    if (action === 'register') {
      const status = await availability(domain, { fresh: true });
      if (status === 'PREMIUM') return error(409, `${domain} is a premium name with its own registry price. Lyrcloud doesn’t sell premium names yet.`);
      if (status === 'DOCUMENTS') return error(409, `The registry wants documents before ${domain} can be registered. Lyrcloud can’t take those yet.`);
      if (status !== 'AVAILABLE') return error(409, `${domain} isn’t available to register. If it’s yours, transfer it in instead.`);
    } else {
      const refusal = await transferRefusal(domain, body.authCode.trim(), prices);
      if (refusal) return error(409, refusal);
    }
    amount = orderAmount(q, action, years);
    costCents = action === 'register' ? q.cost.register + q.cost.renew * (years - 1) : q.cost.transfer;
  }
  if (!Number.isFinite(amount) || amount < 50) return error(400, 'There’s no price for this domain right now.');

  const orderId = randomUUID();
  const createdAt = now();
  const holdUntil = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString();
  const contact = action === 'renew' ? undefined : cleanContact(body.contact);

  // Hold the name for this buyer while they pay, unless someone else holds it or owns it.
  if (action !== 'renew') {
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          ...domainKey(domain), kind: 'domain', domain, tld, action, ownerId: who.userId, ownerEmail: who.email,
          status: 'awaiting_payment', orderId, holdUntil, createdAt, autoRenew: body.autoRenew !== false, years,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR #s IN (:failed, :cancelled) OR (#s = :awaiting AND (holdUntil < :now OR ownerId = :me))',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':failed': 'failed', ':cancelled': 'cancelled', ':awaiting': 'awaiting_payment', ':now': createdAt, ':me': who.userId },
      }));
    } catch (err) {
      if (isConditionFailure(err)) return error(409, `${domain} was just taken by someone else.`);
      throw err;
    }
  }

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...orderKey(orderId), kind: 'order', orderId, domain, tld, ownerId: who.userId, action, years, amountCents: amount, costCents,
      status: 'open', createdAt, ...(contact ? { contact } : {}), ...(action === 'transfer' ? { authCode: body.authCode.trim() } : {}),
    },
  }));

  const label = { register: 'Domain registration', transfer: 'Domain transfer (adds 1 year)', renew: 'Domain renewal' }[action];
  let session;
  const successPath = `/dash/#/domains/${domain}?paid=1`;
  const cancelPath = action === 'renew' ? `/dash/#/domains/${domain}` : `/dash/#/domains/buy?domain=${domain}&action=${action}&cancelled=1`;
  try {
    session = body.payWith === 'lyrpay'
      ? await lyrpay.openPayment(await getLyrpay(), {
        orderId, amountCents: amount, title: `${label}: ${domain}, ${years} year${years === 1 ? '' : 's'}`,
        returnUrl: `${siteOrigin(event)}${successPath}`, cancelUrl: `${siteOrigin(event)}${cancelPath}`,
        metadata: { orderId, domain, action },
      })
      : await openCheckout(event, who, {
        orderId, amount, domain, action, email: contact?.email,
        title: `${label}: ${domain}`, description: `${years} year${years === 1 ? '' : 's'}`, successPath, cancelPath,
      });
  } catch (err) {
    await update(orderKey(orderId), { status: 'expired', failureReason: err.message });
    if (action !== 'renew') await releaseHold(domain, orderId);
    if (err instanceof StripeError || err instanceof lyrpay.LyrpayError) return error(err.status === 503 ? 503 : 502, `Payment page couldn’t be created: ${err.message}`);
    throw err;
  }
  await update(orderKey(orderId), { sessionId: session.id });
  if (action !== 'renew') await update(domainKey(domain), { checkoutUrl: session.url });
  if (contact) await update(billingKey(who.userId), { kind: 'billing', contact, updatedAt: now() });
  return json(200, { url: session.url, orderId });
}

// A Stripe Checkout page for one order. The card is saved for renewals (setup_future_usage).
async function openCheckout(event, who, { orderId, amount, domain, action, email, title, description, successPath, cancelPath }) {
  const stripeConfig = await getStripe();
  const billing = await getItem(billingKey(who.userId));
  const customer = billing?.stripeCustomers?.[stripeMode(stripeConfig.secretKey)];
  const origin = siteOrigin(event);
  return stripe('POST', '/checkout/sessions', {
    mode: 'payment',
    payment_method_types: ['card'],
    ...(customer ? { customer } : { customer_creation: 'always', customer_email: email || who.email || undefined }),
    client_reference_id: orderId,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amount, product_data: { name: title, description } } }],
    payment_intent_data: { setup_future_usage: 'off_session', description: title, metadata: { orderId, domain, action } },
    metadata: { orderId, domain, action },
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    success_url: `${origin}${successPath}`,
    cancel_url: `${origin}${cancelPath}`,
  }, { idempotencyKey: `checkout-${orderId}` });
}

async function releaseHold(domain, orderId, key = domainKey(domain)) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: key,
      ConditionExpression: '#s = :awaiting AND orderId = :o',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':awaiting': 'awaiting_payment', ':o': orderId },
    }));
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
}

// Fetches the domain's record and checks it belongs to the caller (staff may look at any).
async function ownedDomain(name, who) {
  const domain = cleanDomain(name);
  const item = domain && (await getItem(domainKey(domain)));
  if (!item || (item.ownerId !== who.userId && !isStaff(who.role)) || staleHold(item)) return null;
  return item;
}

async function zoneRecords(zoneId) {
  const records = [];
  let start = {};
  for (;;) {
    const page = await dns.send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, MaxItems: 300, ...start }));
    records.push(...(page.ResourceRecordSets || []));
    if (!page.IsTruncated) break;
    start = { StartRecordName: page.NextRecordName, StartRecordType: page.NextRecordType, ...(page.NextRecordIdentifier ? { StartRecordIdentifier: page.NextRecordIdentifier } : {}) };
  }
  return records;
}

// DNA zones answer only for live domains; the test environment returns 500 for every zone call.
const dnaZones = (item) => item.dnsProvider === 'dna' && item.registrarEnv !== 'test';

// The registrant's e-mail verification. For most TLDs the registry suspends a domain whose registrant
// hasn't clicked DNA's verification link within 15 days, so the dashboard shows it until it's done.
async function verificationFor(item) {
  if (item.registrar !== 'dna' || item.status !== 'active' || !item.registrantHandle) return null;
  try {
    const answer = await dna('GET', 'contacts/verification/check', { query: { handleCode: item.registrantHandle } }, item.registrarEnv);
    const open = (answer?.results || []).find((result) => result.fieldType === 'Email' && !result.isUserVerified
      && ['None', 'VerificationPending', 'TokenExpired', 'MailChanged', 0, 1, 3, 6].includes(result.operationStatus));
    return open ? { pending: true, email: open.fieldValue || null, deadline: dnaDate(open.tokenExpireDate), expired: [3, 'TokenExpired'].includes(open.operationStatus) } : { pending: false };
  } catch (err) {
    if (err.code === 'Dna.DomainService:Contact:Verification:10005') return { pending: false }; // nothing to verify
    console.error('verification check failed', item.domain, err.code || err.name);
    return null;
  }
}

async function domainDetail(item, who) {
  const [config, prices] = await Promise.all([getPricing(), wholesale()]);
  const orders = (await itemsOf(item.ownerId)).filter((row) => row.kind === 'order' && row.domain === item.domain && row.status !== 'open' && row.status !== 'expired').map(publicOrder);
  let records = null;
  if (item.status === 'active' && dnaZones(item)) {
    records = fromDnaZone(await dna('GET', 'domains/zones', { query: { domainName: item.domain } }), item.domain);
  } else if (item.hostedZoneId && item.status === 'active') {
    records = (await zoneRecords(item.hostedZoneId)).map((set) => fromRecordSet(set, item.domain)).filter(Boolean);
  }
  const verification = await verificationFor(item);
  return json(200, { domain: publicDomain(item, config, prices), records, orders, verification, owner: isStaff(who.role) ? item.ownerEmail : undefined });
}

// Sends DNA's verification e-mail to the registrant again (a fresh 15-day link if the old one lapsed).
async function resendVerification(item, who) {
  if (item.ownerId !== who.userId && !isStaff(who.role)) return error(403, 'Only the owner can do that.');
  if (item.registrar !== 'dna' || !item.registrantHandle) return error(409, 'This domain has no e-mail verification to send.');
  try {
    await dna('POST', 'contacts/verification/request', { body: { handleCode: item.registrantHandle } }, item.registrarEnv);
  } catch (err) {
    if (err.code === 'Dna.DomainService:Contact:Verification:10003') return json(200, { sent: false, verified: true });
    if (err.code === 'Dna.DomainService:Contact:Verification:10002') return error(429, 'The e-mail was sent less than a minute ago. Wait a moment and try again.');
    if (err instanceof DnaError && err.status < 500) return error(409, err.message);
    throw err;
  }
  return json(200, { sent: true });
}

// Our record set -> DNA: replace the set if it exists, else add it. DNA locates a set by name and type.
async function changeDnaRecord(event, item, method) {
  const domainName = item.domain;
  const current = fromDnaZone(await dna('GET', 'domains/zones', { query: { domainName } }), domainName);
  if (method === 'PUT') {
    const record = parseJson(event);
    const refused = recordError(record, domainName);
    if (refused) return error(...refused);
    const name = recordName(record.name, domainName);
    const exists = current.some((set) => set.type === record.type && set.name === name);
    const conflict = current.find((set) => set.name === name && (set.type === 'CNAME') !== (record.type === 'CNAME'));
    if (conflict) return error(400, `${name} already has a ${conflict.type} record. A CNAME can’t share its name with other records.`);
    try {
      await dna(exists ? 'PUT' : 'POST', 'domains/zones', {
        query: exists ? { domainName, recordName: dnaLabel(record.name, domainName) } : { domainName },
        body: { zoneStruct: zoneStruct(record, domainName) },
      });
    } catch (err) {
      if (err instanceof DnaError && err.status < 500) return error(400, err.message);
      throw err;
    }
    return json(200, { saved: true });
  }
  const type = event.queryStringParameters?.type;
  const name = recordName(event.queryStringParameters?.name, domainName);
  const existing = current.find((set) => set.type === type && set.name === name);
  if (!existing) return error(404, 'No such record.');
  // DNA deletes one value at a time; the set goes when its last value does.
  for (const value of existing.values) {
    await dna('DELETE', 'domains/zones', { query: { domainName }, body: { name, recordType: type, record: value } });
  }
  return json(200, { deleted: true });
}

async function changeRecord(event, item, method) {
  if (item.status === 'active' && dnaZones(item)) return changeDnaRecord(event, item, method);
  if (item.status !== 'active' || !item.hostedZoneId) return error(409, 'DNS records can be edited once the domain is active on Lyrcloud DNS.');
  if (method === 'PUT') {
    const record = parseJson(event);
    const refused = recordError(record, item.domain);
    if (refused) return error(...refused);
    try {
      await dns.send(new ChangeResourceRecordSetsCommand({
        HostedZoneId: item.hostedZoneId,
        ChangeBatch: { Comment: 'Lyrcloud dashboard', Changes: [{ Action: 'UPSERT', ResourceRecordSet: route53RecordSet(record, item.domain) }] },
      }));
    } catch (err) {
      if (err.name === 'InvalidChangeBatch' || err.name === 'InvalidInput') return error(400, err.message);
      throw err;
    }
    return json(200, { saved: true });
  }
  const type = event.queryStringParameters?.type;
  const name = recordName(event.queryStringParameters?.name, item.domain);
  const existing = (await zoneRecords(item.hostedZoneId))
    .find((set) => set.Type === type && String(set.Name).replace(/\.$/, '').replace(/\\052/g, '*') === name && !set.AliasTarget);
  if (!existing || !['A', 'AAAA', 'CNAME', 'MX', 'TXT'].includes(type)) return error(404, 'No such record.');
  await dns.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: item.hostedZoneId, ChangeBatch: { Changes: [{ Action: 'DELETE', ResourceRecordSet: existing }] } }));
  return json(200, { deleted: true });
}

async function domainRoutes(event, method, path, who) {
  if (path === '/domains' && method === 'GET') return myDomains(who);
  if (path === '/domains/checkout' && method === 'POST') return checkout(event, who);
  if (path === '/domains/subdomains' || path.startsWith('/domains/subdomains/')) return subdomainRoutes(event, method, path, who);
  if (path === '/domains/lyr-waitlist' || path.startsWith('/domains/lyr-waitlist/')) return waitlistRoutes(event, method, path, who);
  const match = path.match(/^\/domains\/([^/]+)(\/records|\/verify-email)?$/);
  if (!match) return error(404, 'not_found');
  const item = await ownedDomain(decodeURIComponent(match[1]), who);
  if (!item) return error(404, 'That domain isn’t in your account.');
  if (match[2] === '/verify-email') return method === 'POST' ? resendVerification(item, who) : error(404, 'not_found');
  if (match[2]) {
    if (method === 'PUT' || method === 'DELETE') return changeRecord(event, item, method);
    return error(404, 'not_found');
  }
  if (method === 'GET') return domainDetail(item, who);
  if (method === 'PUT') {
    const body = parseJson(event);
    if (!body || typeof body.autoRenew !== 'boolean') return error(400, 'Send { "autoRenew": true | false }.');
    if (item.ownerId !== who.userId) return error(403, 'Only the owner can change auto-renew.');
    const saved = await update(domainKey(item.domain), { autoRenew: body.autoRenew, ...(body.autoRenew ? {} : { lastRenewalError: null }) });
    return json(200, { domain: publicDomain(saved, await getPricing(), await wholesale()) });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- payments -> registrar

// A refusal the customer may read; DNA's wording for most, but never Lyrcloud's own account problems.
function refusalReason(err) {
  if (err instanceof DnaError && ['Dna.DomainService:Deposit:10001', 'Dna.DomainService:Reseller:10001', 'Lyrcloud:RegistrarAuth', 'Lyrcloud:RegistrarNotConnected'].includes(err.code)) {
    console.error('REGISTRAR ACCOUNT PROBLEM: top up or reconnect DNA', err.code, err.message, JSON.stringify(err.data || {}));
    return 'Lyrcloud couldn’t complete this purchase with the registry right now';
  }
  return err.message || err.name;
}

// Starts the paid operation at DNA. Registrations and renewals usually finish in the call; transfers wait
// days for approval. followOperation (now, and from the scheduled run) reads the outcome.
async function startOperation(order, registrarEnv) {
  const domainName = order.domain;
  if (order.action === 'renew') {
    const check = await dna('POST', 'domains/renew/check', { body: { domainName, period: order.years } }, registrarEnv);
    if (check && check.renewabilityStatus === false) {
      throw new DnaError(RENEW_REFUSALS[check.errorMessageKey] || 'The registry won’t renew this domain right now.', { status: 409, code: check.errorMessageKey });
    }
    if (check?.isPremium) throw new DnaError('This is a premium domain with its own renewal price. Contact support to renew it.', { status: 409, code: 'Lyrcloud:Premium' });
    try {
      await dna('POST', 'domains/renew', { body: { domainName, period: order.years } }, registrarEnv);
    } catch (err) {
      // The registry already auto-renewed it after expiry; the new expiry is read from /domains/info.
      if (err.code !== 'Dna.DomainService:Domain:10020') throw err;
    }
    return 'dna-renew';
  }
  if (order.action === 'transfer') {
    const started = await dna('POST', 'domains/transfer', { body: { domainName, authCode: order.authCode, period: 1 } }, registrarEnv);
    return `dna-transfer:${started?.domainId || ''}`;
  }
  const registered = await dna('POST', 'domains/register-with-contacts', {
    body: {
      domainName,
      period: order.years,
      nameServers: DNA_NAMESERVERS,
      // One contact fills all four roles (DNA copies it to Admin, Tech and Billing).
      contacts: [{ contactType: 'Registrant', ...dnaContact(order.contact) }],
    },
  }, registrarEnv);
  return `dna-register:${registered?.domainId || ''}`;
}

// After a registration goes live: WHOIS privacy where the registry offers it, and DNA's DNS. Neither may
// undo the registration, so failures are only logged.
async function afterRegistration(item) {
  const prices = await wholesale().catch(() => ({}));
  if (prices[item.tld]?.privacy !== false) {
    await dna('POST', 'domains/privacy', { body: { domainName: item.domain, privacyStatus: true } }, item.registrarEnv)
      .catch((err) => console.error('privacy failed', item.domain, err.code || err.name, err.message));
  }
  if (item.registrarEnv !== 'test') {
    // Delegates to DNA's name servers if the registry didn't take them at registration; safe to repeat.
    await dna('POST', 'domains/zones/apply', { query: { domainName: item.domain } })
      .catch((err) => console.error('zones/apply failed', item.domain, err.code || err.name, err.message));
  }
}

// Gives the money back when the registrar won't do what was paid for.
async function refund(order, reason) {
  console.error('refunding order', order.orderId, reason);
  if (lyrpay.isLyrpay(order.paymentIntentId)) {
    await lyrpay.refundPayment(await getLyrpay(), order.paymentIntentId);
  } else if (order.paymentIntentId) {
    await stripe('POST', '/refunds', { payment_intent: order.paymentIntentId, metadata: { orderId: order.orderId } }, { idempotencyKey: `refund-${order.orderId}` });
  }
  await update(orderKey(order.orderId), { status: 'refunded', failureReason: reason, refundedAt: now() }, ['authCode']);
  if (order.action === 'subdomain' || order.action === 'subdomain-renew') {
    const item = await getItem(subKey(order.domain));
    if (item?.ownerId !== order.ownerId) return;
    if (order.action === 'subdomain-renew') await update(subKey(order.domain), { lastRenewalError: `Renewal failed and was refunded: ${reason}` });
    else if (item.status === 'awaiting_payment') await update(subKey(order.domain), { status: 'failed', failureReason: reason }, ['holdUntil', 'checkoutUrl']);
    return;
  }
  if (order.action === 'renew') {
    await update(domainKey(order.domain), { renewing: false, lastRenewalError: `Renewal failed and was refunded: ${reason}` }, ['renewOrderId', 'renewOperationId']);
  } else {
    await update(domainKey(order.domain), { status: 'failed', failureReason: reason, failedAt: now() }, ['operationId', 'holdUntil', 'checkoutUrl']);
  }
}

export const TEST_MODE_REASON = 'Stripe is in test mode, so no real domain was bought. Connect a live Stripe key to sell domains.';

// After the money is in: start the registrar operation, or refund if it can't start.
// Test-mode payments are fake, so they go to DNA's test environment, which simulates the registry and
// charges nothing; without a DNA test key they're refunded. A renewal goes wherever the domain lives.
// Subdomain test orders are refunded unless ALLOW_TEST_REGISTRATIONS is set, as the tests do.
async function fulfil(order) {
  const testMode = stripeMode((await getStripe()).secretKey) === 'test';
  if (order.action === 'subdomain' || order.action === 'subdomain-renew') {
    if (testMode && env.ALLOW_TEST_REGISTRATIONS !== '1') await refund(order, TEST_MODE_REASON);
    else await activateSubdomain(order);
    return;
  }
  const domainItem = order.action === 'renew' ? await getItem(domainKey(order.domain)) : null;
  const registrarEnv = domainItem?.registrarEnv || (testMode ? 'test' : 'live');
  if (registrarEnv === 'test' && !(await getDnaConfig()).testApiKey) {
    await refund(order, TEST_MODE_REASON);
    return;
  }
  let operationId;
  let reconcile = false;
  try {
    operationId = await startOperation(order, registrarEnv);
  } catch (err) {
    if (!alreadyDone(err)) {
      await refund(order, refusalReason(err));
      return;
    }
    // The registry did it but DNA couldn't record it: never retry, never refund. DNA reconciles it, and
    // the scheduled run picks the domain up once /domains/info knows it.
    console.error('REGISTRAR RECONCILING (do not retry)', order.orderId, order.domain, err.code, err.message);
    operationId = `dna-reconcile:${err.code}`;
    reconcile = true;
  }
  await update(orderKey(order.orderId), { status: 'processing', operationId, registrarEnv }, ['authCode']);
  if (order.action === 'renew') {
    await update(domainKey(order.domain), { renewing: true, renewOrderId: order.orderId, renewOperationId: operationId, lastRenewalError: null });
  } else {
    await update(domainKey(order.domain), {
      status: order.action === 'register' ? 'registering' : 'transferring',
      registrar: 'dna', registrarEnv, ...(order.action === 'register' ? { dnsProvider: 'dna' } : {}),
      operationId, orderId: order.orderId, paidAt: now(), contact: order.contact,
      stripeCustomerId: order.stripeCustomerId, paymentMethodId: order.paymentMethodId,
      ...(reconcile ? { operationMessage: 'The registry is confirming this order.' } : {}),
    }, ['holdUntil', 'checkoutUrl']);
  }
  // Most registrations and every renewal are already done: show them as such without waiting for the run.
  if (!reconcile && order.action !== 'transfer') {
    try {
      await followOperation(await getItem(domainKey(order.domain)));
    } catch (err) {
      console.error('immediate follow-up failed', order.domain, err.code || err.name, err.message);
    }
  }
}

async function onCheckoutCompleted(session) {
  const orderId = session.metadata?.orderId || session.client_reference_id;
  const order = orderId && (await getItem(orderKey(orderId)));
  if (!order || order.sessionId !== session.id || session.payment_status !== 'paid') return;
  if (session.amount_total !== order.amountCents || session.currency !== 'usd') {
    console.error('amount mismatch', orderId, session.amount_total, order.amountCents);
    return;
  }
  const intent = await stripe('GET', `/payment_intents/${session.payment_intent}`);
  let claimed;
  try {
    claimed = await update(orderKey(orderId), {
      status: 'paid', paidAt: now(), paymentIntentId: intent.id, stripeCustomerId: session.customer, paymentMethodId: intent.payment_method,
    }, [], ['#st = :open', { '#st': 'status' }, { ':open': 'open' }]);
  } catch (err) {
    if (isConditionFailure(err)) return; // Stripe retried an event we already handled
    throw err;
  }
  // Test and live mode have separate customers; remember this buyer's for their next checkout.
  const mode = stripeMode((await getStripe()).secretKey);
  const billing = await getItem(billingKey(order.ownerId));
  await update(billingKey(order.ownerId), { kind: 'billing', stripeCustomers: { ...(billing?.stripeCustomers || {}), [mode]: session.customer }, updatedAt: now() });
  if (order.action === 'renew') {
    await update(domainKey(order.domain), { stripeCustomerId: session.customer, paymentMethodId: intent.payment_method });
  }
  await fulfil(claimed);
}

async function onCheckoutExpired(session) {
  const orderId = session.metadata?.orderId || session.client_reference_id;
  const order = orderId && (await getItem(orderKey(orderId)));
  if (!order || order.status !== 'open') return;
  await update(orderKey(orderId), { status: 'expired' }, ['authCode']);
  if (order.action === 'subdomain') await releaseHold(order.domain, orderId, subKey(order.domain));
  else if (order.action !== 'renew') await releaseHold(order.domain, orderId);
}

// A Lyrpay payment for an order was paid: claim the order once, then buy the domain (as onCheckoutCompleted does).
async function onLyrpayPaid(payment) {
  const order = payment.reference && (await getItem(orderKey(payment.reference)));
  if (!order || order.sessionId !== payment.id || payment.status !== 'paid') return;
  if (lyrpay.paidCents(payment) !== order.amountCents || payment.currency !== 'USD') {
    console.error('amount mismatch', order.orderId, payment.amount, payment.currency, order.amountCents);
    return;
  }
  let claimed;
  try {
    claimed = await update(orderKey(order.orderId), { status: 'paid', paidAt: now(), paymentIntentId: payment.id, paidWith: 'lyrpay' },
      [], ['#st = :open', { '#st': 'status' }, { ':open': 'open' }]);
  } catch (err) {
    if (isConditionFailure(err)) return; // already handled (callback and scheduled run both saw it)
    throw err;
  }
  await fulfil(claimed);
}

async function lyrpayCallback(event) {
  const message = lyrpay.verify(await getLyrpay(), rawBody(event), event.headers?.['lyrpay-signature']);
  if (!message) return error(400, 'Bad signature.');
  if (message.type === 'payment.paid') await onLyrpayPaid(message.payment || {});
  return json(200, { received: true });
}

// Lyrpay orders still open after their payment's 30 minutes: paid ones go ahead (a callback was missed),
// expired or cancelled ones give the name back.
async function sweepLyrpayOrders() {
  const keys = await getLyrpay();
  if (!lyrpay.usable(keys)) return 0;
  const cutoff = new Date(Date.now() - 35 * 60_000).toISOString();
  const open = (await collect(ScanCommand, {
    FilterExpression: '#k = :order AND #s = :open',
    ExpressionAttributeNames: { '#k': 'kind', '#s': 'status' },
    ExpressionAttributeValues: { ':order': 'order', ':open': 'open' },
  })).filter((order) => lyrpay.isLyrpay(order.sessionId) && order.createdAt < cutoff);
  for (const order of open) {
    try {
      const payment = await lyrpay.getPayment(keys, order.sessionId);
      if (payment.status === 'paid') await onLyrpayPaid(payment);
      else if (['expired', 'cancelled'].includes(payment.status)) await onCheckoutExpired({ metadata: { orderId: order.orderId } });
    } catch (err) {
      console.error('Lyrpay order check failed', order.orderId, err.message);
    }
  }
  return open.length;
}

async function stripeWebhook(event) {
  const body = rawBody(event);
  const stripeConfig = await getStripe();
  if (!validStripeSignature(body, event.headers?.['stripe-signature'], stripeConfig.webhookSecret)) return error(400, 'Bad signature.');
  const payload = JSON.parse(body);
  if (payload.type === 'checkout.session.completed') await onCheckoutCompleted(payload.data.object);
  if (payload.type === 'checkout.session.expired') await onCheckoutExpired(payload.data.object);
  return json(200, { received: true });
}

// ---------------------------------------------------------------- scheduled work

// DNA domain statuses that mean the registration or transfer is over and didn't work.
const DEAD_STATUSES = ['TransferredOut', 'TransferRejected', 'Deleted', 'PendingDelete'];
const TRANSFER_FAILED = { clientRejected: 'The current owner rejected the transfer.', clientCancelled: 'The transfer was cancelled at the current registrar.', serverCancelled: 'The registry cancelled the transfer.' };
const WAITING_WORDS = {
  WaitingForRegistration: 'The registry is still processing the registration.',
  WaitingForDocument: 'The registry is waiting for documents. Contact support.',
  WaitingForIncomingTransfer: 'Waiting for the current registrar to release the domain.',
  ConfirmationEmailSend: 'Waiting for the domain owner to approve the transfer by e-mail.',
};

// Reads where a paid operation stands at DNA and moves the domain on: live, still waiting, or refunded.
async function followOperation(item) {
  if (item.registrar !== 'dna') return; // bought from Route 53 before the switch; nothing to follow here
  const renewal = item.renewing && item.renewOperationId;
  const orderId = renewal ? item.renewOrderId : item.orderId;
  const env = item.registrarEnv;
  const finish = async () => { if (orderId) await update(orderKey(orderId), { status: 'fulfilled', fulfilledAt: now() }); };
  const failed = async (reason) => {
    const order = orderId && (await getItem(orderKey(orderId)));
    if (order && order.status !== 'refunded') await refund(order, reason);
  };

  if (!renewal && item.status === 'transferring') {
    let transfer = null;
    try {
      transfer = await dna('POST', 'domains/transfers/query', { body: { domainName: item.domain } }, env);
    } catch (err) {
      // "Not in a transfer state" once it has finished; anything else is asked again next run.
      if (err.code !== 'Dna.DomainService:Domain:10025' && err.code !== 'Dna.DomainService:Domain:10027') throw err;
    }
    if (TRANSFER_FAILED[transfer?.status]) return failed(TRANSFER_FAILED[transfer.status]);
    if (transfer?.status === 'pending') {
      const by = dnaDate(transfer.finalDate);
      await update(domainKey(item.domain), { operationStatus: 'pending', operationMessage: by ? `Completes by ${by.slice(0, 10)} unless the current owner approves it sooner.` : null, checkedAt: now() });
      return;
    }
  }

  let info;
  try {
    info = await dna('GET', 'domains/info', { query: { domainName: item.domain } }, env);
  } catch (err) {
    // Not in the account yet: a transfer not finished, or a never-retry order DNA is still reconciling.
    if (err.code === 'Dna.DomainService:Domain:10007') {
      await update(domainKey(item.domain), { checkedAt: now() });
      return;
    }
    throw err;
  }
  const facts = { expiresAt: dnaDate(info.expirationDate) || undefined, nameservers: info.nameservers?.length ? info.nameservers : undefined, checkedAt: now() };
  if (renewal) {
    await update(domainKey(item.domain), { ...facts, renewing: false, lastRenewedAt: now(), lastRenewalError: null }, ['renewOperationId', 'renewOrderId']);
    return finish();
  }
  if (info.status === 'Active') {
    const registrant = (info.contacts || []).find((contact) => contact.contactType === 'Registrant');
    const live = await update(domainKey(item.domain), {
      ...facts, status: 'active', activatedAt: now(), operationStatus: 'Active', registrantHandle: registrant?.handle || undefined,
    }, ['operationMessage']);
    if (item.action === 'register') await afterRegistration(live);
    return finish();
  }
  if (DEAD_STATUSES.includes(info.status)) return failed(`The registry reported ${info.status}.`);
  await update(domainKey(item.domain), { ...facts, operationStatus: info.status, operationMessage: WAITING_WORDS[info.status] || info.statusReason || null });
}

// Charges the saved card for an auto-renewing domain, then renews it at the registrar.
async function chargeRenewal(item) {
  const attemptAt = now();
  if (!item.stripeCustomerId || !item.paymentMethodId) {
    await update(domainKey(item.domain), { lastRenewAttemptAt: attemptAt, lastRenewalError: 'No saved card. Renew it from the dashboard.' });
    return;
  }
  const [config, prices] = await Promise.all([getPricing(), wholesale()]);
  const q = quote(prices, item.tld, config);
  const withDns = lyrcloudDns(item);
  const amount = withDns ? q.renew : q.renewNoDns;
  if (!Number.isFinite(amount)) return;
  const orderId = randomUUID();
  const order = {
    ...orderKey(orderId), kind: 'order', orderId, domain: item.domain, tld: item.tld, ownerId: item.ownerId, action: 'renew', years: 1, auto: true,
    amountCents: amount, costCents: withDns ? q.cost.renew : q.cost.renewNoDns, status: 'open', createdAt: attemptAt,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: order }));
  await update(domainKey(item.domain), { lastRenewAttemptAt: attemptAt });
  let intent;
  try {
    intent = await stripe('POST', '/payment_intents', {
      amount, currency: 'usd', customer: item.stripeCustomerId, payment_method: item.paymentMethodId, off_session: true, confirm: true,
      description: `Domain renewal: ${item.domain}`, metadata: { orderId, domain: item.domain, action: 'renew' },
    }, { idempotencyKey: `renew-${orderId}` });
  } catch (err) {
    await update(orderKey(orderId), { status: 'failed', failureReason: err.message });
    await update(domainKey(item.domain), { lastRenewalError: `Auto-renew charge failed: ${err.message}` });
    return;
  }
  if (intent.status !== 'succeeded') {
    await update(orderKey(orderId), { status: 'failed', failureReason: `Payment ${intent.status}` });
    await update(domainKey(item.domain), { lastRenewalError: 'Your bank asked for confirmation. Renew it from the dashboard.' });
    return;
  }
  const paid = await update(orderKey(orderId), { status: 'paid', paidAt: now(), paymentIntentId: intent.id });
  await fulfil(paid);
}

export async function tick() {
  const items = await collect(ScanCommand, { FilterExpression: '#k IN (:d, :s)', ExpressionAttributeNames: { '#k': 'kind' }, ExpressionAttributeValues: { ':d': 'domain', ':s': 'subdomain' } });
  const day = 86_400_000;
  await pool(items, 2, async (item) => {
    try {
      if (item.kind === 'subdomain') {
        await subdomainTick(item);
      } else if (item.registrar !== 'dna' && item.status !== 'awaiting_payment') {
        // Bought from Route 53 before the switch to DNA: no automatic follow-up or renewal charges.
      } else if ((['registering', 'transferring'].includes(item.status) && item.operationId) || (item.renewing && item.renewOperationId)) {
        await followOperation(item);
      } else if (item.status === 'active' && item.autoRenew && !item.renewing && renewalDue(item.expiresAt)
        && Date.parse(item.expiresAt) > Date.now() && (!item.lastRenewAttemptAt || Date.now() - Date.parse(item.lastRenewAttemptAt) > day)) {
        await chargeRenewal(item);
      } else if (item.status === 'active' && item.expiresAt && Date.parse(item.expiresAt) < Date.now()) {
        await update(domainKey(item.domain), { status: 'expired' });
      } else if (item.status === 'awaiting_payment' && Date.parse(item.holdUntil) < Date.now() - 3600_000) {
        await releaseHold(item.domain, item.orderId);
      }
    } catch (err) {
      console.error('scheduled work failed for', item.domain, err);
    }
  });
  const lyrpayOrders = await sweepLyrpayOrders().catch((err) => { console.error('Lyrpay sweep failed', err); return 0; });
  return { checked: items.length, lyrpayOrders };
}


// ---------------------------------------------------------------- name.lyr.cloud subdomains

const subKey = (fqdn) => ({ pk: `sub#${fqdn}`, sk: 'sub' });
const subdomainsOn = () => Boolean(SUB_ZONE && SUB_ZONE_ID);
const SUB_GRACE_MS = 7 * 86_400_000;
const YEAR_MS = 365 * 86_400_000;

function publicSubdomain(item, config) {
  const awaiting = item.status === 'awaiting_payment';
  return {
    name: item.fqdn, label: item.label, status: item.status, free: item.free === true, autoRenew: item.autoRenew === true,
    expiresAt: item.free ? null : item.expiresAt || null, createdAt: item.createdAt,
    holdUntil: awaiting ? item.holdUntil : null, checkoutUrl: awaiting ? item.checkoutUrl || null : null,
    lastRenewalError: item.lastRenewalError || null, failureReason: item.failureReason || null,
    renewPrice: item.free ? 0 : config.subdomainCents,
  };
}

// The item can be (re)claimed by `who` unless someone else holds or owns it.
const CLAIMABLE = {
  ConditionExpression: 'attribute_not_exists(pk) OR #s IN (:expired, :failed) OR (#s = :awaiting AND (holdUntil < :now OR ownerId = :me))',
  names: { '#s': 'status' },
  values: (who) => ({ ':expired': 'expired', ':failed': 'failed', ':awaiting': 'awaiting_payment', ':now': now(), ':me': who.userId }),
};

async function claimSubdomain(event, who) {
  if (!subdomainsOn()) return error(503, `name.${SUB_ZONE || 'lyr.cloud'} addresses are coming soon.`);
  const body = parseJson(event);
  const label = cleanLabel(body?.label);
  if (!label) return error(400, 'Use letters, digits and hyphens, like my-shop.');
  const fqdn = `${label}.${SUB_ZONE}`;
  if (RESERVED_SUBDOMAINS.includes(label)) return error(409, `${fqdn} is reserved.`);
  const config = await getPricing();
  const held = (await itemsOf(who.userId)).filter((item) => item.kind === 'subdomain' && item.status === 'active');
  if (held.some((item) => item.fqdn === fqdn)) return error(409, `${fqdn} is already yours.`);
  if (held.length >= MAX_SUBDOMAINS) return error(409, `You can hold up to ${MAX_SUBDOMAINS} ${SUB_ZONE} names.`);
  const existing = await getItem(subKey(fqdn));
  const claimable = !existing || ['expired', 'failed'].includes(existing.status) || staleHold(existing) || (existing.status === 'awaiting_payment' && existing.ownerId === who.userId);
  if (!claimable) return error(409, `${fqdn} is taken.`);
  const free = config.subdomainFreePlans.includes(who.plan);
  const createdAt = now();
  const base = { ...subKey(fqdn), kind: 'subdomain', fqdn, label, ownerId: who.userId, ownerEmail: who.email, createdAt, autoRenew: body.autoRenew !== false };
  const put = async (item) => {
    try {
      await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: CLAIMABLE.ConditionExpression, ExpressionAttributeNames: CLAIMABLE.names, ExpressionAttributeValues: CLAIMABLE.values(who) }));
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  };
  if (free) {
    const item = { ...base, status: 'active', free: true, plan: who.plan, activatedAt: createdAt };
    if (!(await put(item))) return error(409, `${fqdn} is taken.`);
    return json(200, { subdomain: publicSubdomain(item, config) });
  }
  if (!(await getStripe()).secretKey) return error(503, 'Payments aren’t switched on yet. Please check back soon.');
  const orderId = randomUUID();
  const holdUntil = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString();
  if (!(await put({ ...base, status: 'awaiting_payment', free: false, orderId, holdUntil }))) return error(409, `${fqdn} is taken.`);
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { ...orderKey(orderId), kind: 'order', orderId, domain: fqdn, ownerId: who.userId, action: 'subdomain', years: 1, amountCents: config.subdomainCents, costCents: 0, status: 'open', createdAt },
  }));
  let session;
  try {
    session = await openCheckout(event, who, {
      orderId, amount: config.subdomainCents, domain: fqdn, action: 'subdomain', title: `${fqdn} for one year`, description: 'Renews yearly; cancel any time',
      successPath: `/dash/#/domains/sub/${label}?paid=1`, cancelPath: `/dash/#/domains?cancelled=${label}`,
    });
  } catch (err) {
    await update(orderKey(orderId), { status: 'expired', failureReason: err.message });
    await releaseHold(fqdn, orderId, subKey(fqdn));
    if (err instanceof StripeError) return error(502, `Payment page couldn’t be created: ${err.message}`);
    throw err;
  }
  await update(orderKey(orderId), { sessionId: session.id });
  await update(subKey(fqdn), { checkoutUrl: session.url });
  return json(200, { url: session.url, orderId });
}

// Paid: start (or extend) a year. The hold may have run out and gone to someone else: then refund.
async function activateSubdomain(order) {
  const item = await getItem(subKey(order.domain));
  if (!item || item.ownerId !== order.ownerId || (order.action === 'subdomain' && item.status !== 'active' && item.orderId !== order.orderId)) {
    await refund(order, 'The hold on this name ran out before the payment arrived.');
    return;
  }
  const from = item.status === 'active' && item.expiresAt && Date.parse(item.expiresAt) > Date.now() ? Date.parse(item.expiresAt) : Date.now();
  await update(subKey(order.domain), {
    status: 'active', free: false, expiresAt: new Date(from + YEAR_MS).toISOString(), paidAt: now(), activatedAt: item.activatedAt || now(),
    stripeCustomerId: order.stripeCustomerId || item.stripeCustomerId, paymentMethodId: order.paymentMethodId || item.paymentMethodId, lastRenewalError: null,
  }, ['holdUntil', 'checkoutUrl', 'failureReason']);
  await update(orderKey(order.orderId), { status: 'fulfilled', fulfilledAt: now() });
}

// Record sets at or below `fqdn` in the subdomain zone. Route 53 lists names in DNS order, so they sit
// together from `fqdn` on.
async function subRecordSets(fqdn) {
  const sets = [];
  let start = { StartRecordName: fqdn };
  for (;;) {
    const page = await dns.send(new ListResourceRecordSetsCommand({ HostedZoneId: SUB_ZONE_ID, MaxItems: 300, ...start }));
    for (const set of page.ResourceRecordSets || []) {
      const name = String(set.Name).replace(/\.$/, '').replace(/\\052/g, '*');
      if (name !== fqdn && !name.endsWith(`.${fqdn}`)) return sets;
      sets.push(set);
    }
    if (!page.IsTruncated) return sets;
    start = { StartRecordName: page.NextRecordName, StartRecordType: page.NextRecordType };
  }
}

const recordSetName = (set) => String(set.Name).replace(/\.$/, '').replace(/\\052/g, '*');

async function subdomainRoutes(event, method, path, who) {
  if (path === '/domains/subdomains') return method === 'POST' ? claimSubdomain(event, who) : error(404, 'not_found');
  const match = path.match(/^\/domains\/subdomains\/([^/]+)(\/records)?$/);
  const label = match && cleanLabel(decodeURIComponent(match[1]));
  if (!label || !subdomainsOn()) return error(404, 'not_found');
  const fqdn = `${label}.${SUB_ZONE}`;
  const item = await getItem(subKey(fqdn));
  if (!item || (item.ownerId !== who.userId && !isStaff(who.role)) || staleHold(item) || item.status === 'expired') return error(404, 'That name isn’t in your account.');
  const config = await getPricing();
  if (match[2]) {
    if (item.status !== 'active') return error(409, 'Records can be added once the name is active.');
    if (method === 'PUT') {
      const record = parseJson(event);
      const refused = recordError(record, fqdn, { apexCname: true });
      if (refused) return error(...refused);
      try {
        await dns.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: SUB_ZONE_ID, ChangeBatch: { Comment: `Lyrcloud: ${fqdn}`, Changes: [{ Action: 'UPSERT', ResourceRecordSet: route53RecordSet(record, fqdn) }] } }));
      } catch (err) {
        if (err.name === 'InvalidChangeBatch' || err.name === 'InvalidInput') return error(400, err.message);
        throw err;
      }
      return json(200, { saved: true });
    }
    if (method === 'DELETE') {
      const type = event.queryStringParameters?.type;
      const name = recordName(event.queryStringParameters?.name, fqdn);
      const existing = (await subRecordSets(fqdn)).find((set) => set.Type === type && recordSetName(set) === name && !set.AliasTarget);
      if (!existing || !['A', 'AAAA', 'CNAME', 'MX', 'TXT'].includes(type)) return error(404, 'No such record.');
      await dns.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: SUB_ZONE_ID, ChangeBatch: { Changes: [{ Action: 'DELETE', ResourceRecordSet: existing }] } }));
      return json(200, { deleted: true });
    }
    return error(404, 'not_found');
  }
  if (method === 'GET') {
    const records = item.status === 'active' ? (await subRecordSets(fqdn)).map((set) => fromRecordSet(set, fqdn)).filter(Boolean) : [];
    return json(200, { subdomain: publicSubdomain(item, config), records, owner: isStaff(who.role) ? item.ownerEmail : undefined });
  }
  if (item.ownerId !== who.userId) return error(403, 'Only the owner can change this name.');
  if (method === 'PUT') {
    const body = parseJson(event);
    if (!body || typeof body.autoRenew !== 'boolean') return error(400, 'Send { "autoRenew": true | false }.');
    return json(200, { subdomain: publicSubdomain(await update(subKey(fqdn), { autoRenew: body.autoRenew }), config) });
  }
  if (method === 'DELETE') {
    await releaseSubdomain(item);
    return json(200, { released: fqdn });
  }
  return error(404, 'not_found');
}

// Deletes the name's records and frees it.
async function releaseSubdomain(item) {
  // Only the record types customers can create; never anything structural.
  const sets = (await subRecordSets(item.fqdn)).filter((set) => ['A', 'AAAA', 'CNAME', 'MX', 'TXT'].includes(set.Type));
  for (let i = 0; i < sets.length; i += 100) {
    await dns.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: SUB_ZONE_ID, ChangeBatch: { Changes: sets.slice(i, i + 100).map((set) => ({ Action: 'DELETE', ResourceRecordSet: set })) } }));
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: subKey(item.fqdn) }));
}

// Charges the saved card for a paid subdomain's next year.
async function chargeSubRenewal(item) {
  const attemptAt = now();
  await update(subKey(item.fqdn), { lastRenewAttemptAt: attemptAt });
  if (!item.stripeCustomerId || !item.paymentMethodId) {
    await update(subKey(item.fqdn), { lastRenewalError: 'No saved card. Turn auto-renew off and on again after paying, or contact support.' });
    return;
  }
  const amount = (await getPricing()).subdomainCents;
  const orderId = randomUUID();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { ...orderKey(orderId), kind: 'order', orderId, domain: item.fqdn, ownerId: item.ownerId, action: 'subdomain-renew', years: 1, auto: true, amountCents: amount, costCents: 0, status: 'open', createdAt: attemptAt },
  }));
  let intent;
  try {
    intent = await stripe('POST', '/payment_intents', {
      amount, currency: 'usd', customer: item.stripeCustomerId, payment_method: item.paymentMethodId, off_session: true, confirm: true,
      description: `Renewal: ${item.fqdn}`, metadata: { orderId, domain: item.fqdn, action: 'subdomain-renew' },
    }, { idempotencyKey: `renew-${orderId}` });
  } catch (err) {
    await update(orderKey(orderId), { status: 'failed', failureReason: err.message });
    await update(subKey(item.fqdn), { lastRenewalError: `Auto-renew charge failed: ${err.message}` });
    return;
  }
  if (intent.status !== 'succeeded') {
    await update(orderKey(orderId), { status: 'failed', failureReason: `Payment ${intent.status}` });
    await update(subKey(item.fqdn), { lastRenewalError: 'Your bank asked for confirmation. Contact support to renew.' });
    return;
  }
  await fulfil(await update(orderKey(orderId), { status: 'paid', paidAt: now(), paymentIntentId: intent.id, stripeCustomerId: item.stripeCustomerId, paymentMethodId: item.paymentMethodId }));
}

async function subdomainTick(item) {
  const day = 86_400_000;
  if (item.status === 'awaiting_payment' && Date.parse(item.holdUntil) < Date.now() - 3600_000) {
    await releaseHold(item.fqdn, item.orderId, subKey(item.fqdn));
  } else if (item.status === 'active' && !item.free && item.expiresAt) {
    const expires = Date.parse(item.expiresAt);
    if (expires + SUB_GRACE_MS < Date.now()) {
      if (subdomainsOn()) await releaseSubdomain(item);
    } else if (item.autoRenew && renewalDue(item.expiresAt) && (!item.lastRenewAttemptAt || Date.now() - Date.parse(item.lastRenewAttemptAt) > day)) {
      await chargeSubRenewal(item);
    }
  }
}

// ---------------------------------------------------------------- .lyr waitlist

const waitKey = (name) => ({ pk: `lyrwait#${name}`, sk: 'lyrwait' });

// Whether `name` (already cleaned) can be reserved, and if not, why.
async function lyrNameState(name, who) {
  if (isReservedLyr(name)) return { available: false, reason: 'reserved' };
  if (await getItem(lyrKey(name))) return { available: false, reason: 'taken' };
  const waiting = await getItem(waitKey(name));
  if (waiting) return { available: false, reason: waiting.ownerId === who?.userId ? 'yours' : 'waitlisted' };
  return { available: true, reason: null };
}

async function lyrAvailable(event) {
  const name = cleanLyrName(event.queryStringParameters?.name);
  if (!name) return error(400, 'Use a name like shop.lyr: letters, digits and hyphens.');
  return json(200, { name, ...(await lyrNameState(name, null)) });
}

async function waitlistRoutes(event, method, path, who) {
  if (path === '/domains/lyr-waitlist' && method === 'POST') {
    const name = cleanLyrName(parseJson(event)?.name);
    if (!name) return error(400, 'Use a name like shop.lyr: letters, digits and hyphens.');
    const state = await lyrNameState(name, who);
    if (state.reason === 'yours') return json(200, { reservation: { name } });
    if (!state.available) return error(409, { reserved: `${name} is reserved.`, taken: `${name} is already in use.`, waitlisted: `Someone has already reserved ${name}.` }[state.reason]);
    const mine = (await itemsOf(who.userId)).filter((item) => item.kind === 'lyrwait');
    if (mine.length >= MAX_LYR_RESERVATIONS) return error(409, `You can reserve up to ${MAX_LYR_RESERVATIONS} .lyr names.`);
    const createdAt = now();
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { ...waitKey(name), kind: 'lyrwait', name, ownerId: who.userId, ownerEmail: who.email, createdAt },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
    } catch (err) {
      if (isConditionFailure(err)) return error(409, `Someone has just reserved ${name}.`);
      throw err;
    }
    return json(200, { reservation: { name, createdAt } });
  }
  const match = path.match(/^\/domains\/lyr-waitlist\/([^/]+)$/);
  const name = match && cleanLyrName(decodeURIComponent(match[1]));
  if (!name || method !== 'DELETE') return error(404, 'not_found');
  try {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: waitKey(name), ConditionExpression: 'ownerId = :me', ExpressionAttributeValues: { ':me': who.userId } }));
  } catch (err) {
    if (isConditionFailure(err)) return error(404, 'That reservation isn’t yours.');
    throw err;
  }
  return json(200, { released: name });
}

// ---------------------------------------------------------------- .lyr resolver and registry

const lyrKey = (name) => ({ pk: `lyr#${name}`, sk: 'lyr' });
const UPSTREAM_DOH = env.UPSTREAM_DOH || 'https://cloudflare-dns.com/dns-query';
const lookupLyr = async (name) => (name ? getItem(lyrKey(name)) : null);

// Resolves a CNAME target outside .lyr through a public resolver's JSON API.
async function chase(target, type) {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(target)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
    return res.ok ? fromJsonAnswers((await res.json()).Answer) : [];
  } catch {
    return [];
  }
}

const dnsMessage = (wire, maxAge) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/dns-message', 'cache-control': `max-age=${maxAge}` },
  body: wire.toString('base64'),
  isBase64Encoded: true,
});

// RFC 8484: GET ?dns=<base64url message> or POST with an application/dns-message body.
// Queries aren't logged: this resolver sees every name its users look up.
async function dnsQuery(event, method) {
  let wire;
  if (method === 'GET') {
    const encoded = event.queryStringParameters?.dns;
    if (!encoded || encoded.length > 1024) return error(400, 'Send the query as ?dns=<base64url>.');
    wire = Buffer.from(encoded, 'base64url');
  } else {
    const type = String(event.headers?.['content-type'] || '').split(';')[0].trim();
    if (type !== 'application/dns-message') return error(415, 'Use Content-Type: application/dns-message.');
    wire = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'latin1');
    if (wire.length > 4096) return error(413, 'Query too large.');
  }
  let query;
  try {
    query = parseQuery(wire);
  } catch (err) {
    if (err instanceof DnsFormatError) return error(400, 'Not a DNS query.');
    throw err;
  }
  if (isLyrQuestion(query.qname)) {
    if (query.opcode !== 0) return dnsMessage(buildResponse(query, { rcode: RCODE.NOTIMP }), 0);
    const answer = await answerLyr(query, await lookupLyr(registeredLyrName(query.qname)), chase, lookupLyr);
    return dnsMessage(buildResponse(query, answer), 60);
  }
  try {
    const res = await fetch(UPSTREAM_DOH, { method: 'POST', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, body: wire });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return dnsMessage(Buffer.from(await res.arrayBuffer()), 0);
  } catch {
    return dnsMessage(buildResponse(query, { rcode: RCODE.SERVFAIL }), 0);
  }
}

const RCODE_NAMES = Object.fromEntries(Object.entries(RCODE).map(([name, code]) => [code, name]));

async function lyrLookup(event) {
  const raw = String(event.queryStringParameters?.name || '').trim().toLowerCase().replace(/\.$/, '');
  const qname = raw.endsWith('.lyr') ? raw : `${raw}.lyr`;
  if (raw.includes('.') && !raw.endsWith('.lyr')) return error(400, 'This only looks up .lyr names.');
  const type = String(event.queryStringParameters?.type || 'A').toUpperCase();
  if (!TYPES[type] || !/^(?:[a-z0-9_*](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+lyr$/.test(qname)) return error(400, 'Ask about a name like shop.lyr.');
  const query = { qname, qtype: TYPES[type] };
  const answer = await answerLyr(query, await lookupLyr(registeredLyrName(qname)), chase, lookupLyr);
  return json(200, { name: qname, type, status: RCODE_NAMES[answer.rcode], answers: answer.answers || [] });
}

const publicLyr = (item) => ({ name: item.name, owner: item.owner || null, note: item.note || null, records: item.records || [], createdAt: item.createdAt, updatedAt: item.updatedAt || null });

// Stored records: full names, trimmed values; one set per name and type, and a CNAME stands alone.
function normalizeLyrRecords(records, name) {
  const sets = records.map((record) => ({
    type: record.type,
    name: recordName(record.name, name),
    values: record.values.map((value) => String(value).trim()).filter(Boolean),
    ttl: record.ttl ?? 300,
  }));
  const seen = new Set();
  for (const set of sets) {
    const key = `${set.name}|${set.type}`;
    if (seen.has(key)) return [null, `There are two ${set.type} sets for ${set.name}. Put all values in one.`];
    seen.add(key);
  }
  const clash = sets.find((set) => set.type === 'CNAME' && sets.some((other) => other !== set && other.name === set.name));
  if (clash) return [null, `${clash.name} has a CNAME, so it can’t have other records.`];
  return [sets, null];
}

async function lyrAdminRoutes(event, method, path, who) {
  if (path === '/admin/lyr' && method === 'GET') {
    const items = await collect(ScanCommand, { FilterExpression: '#k IN (:l, :w)', ExpressionAttributeNames: { '#k': 'kind' }, ExpressionAttributeValues: { ':l': 'lyr', ':w': 'lyrwait' } });
    const reservations = items.filter((item) => item.kind === 'lyrwait')
      .map((item) => ({ name: item.name, ownerEmail: item.ownerEmail || null, createdAt: item.createdAt }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return json(200, { names: items.filter((item) => item.kind === 'lyr').map(publicLyr).sort((a, b) => a.name.localeCompare(b.name)), reservations });
  }
  const match = path.match(/^\/admin\/lyr\/([^/]+)$/);
  if (!match) return error(404, 'not_found');
  if (who.role !== 'superadmin') return error(403, 'Only the super admin can manage .lyr names.');
  const name = cleanLyrName(decodeURIComponent(match[1]));
  if (!name) return error(400, 'Use a name like shop.lyr: letters, digits and hyphens.');
  if (method === 'DELETE') {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: lyrKey(name) }));
    return json(200, { deleted: name });
  }
  if (method !== 'PUT') return error(404, 'not_found');
  if (isReservedLyr(name)) return error(400, `${name} is reserved.`);
  const body = parseJson(event);
  if (!body) return error(400, 'Invalid JSON body.');
  const records = body.records ?? [];
  const refused = lyrRecordsError(records, name, recordError);
  if (refused) return error(...refused);
  const [sets, problem] = normalizeLyrRecords(records, name);
  if (problem) return error(400, problem);
  if ('owner' in body && body.owner !== null && (typeof body.owner !== 'string' || body.owner.length > 254)) return error(400, 'Owner must be an email address.');
  if ('note' in body && body.note !== null && (typeof body.note !== 'string' || body.note.length > 300)) return error(400, 'Notes are at most 300 characters.');
  const existing = await getItem(lyrKey(name));
  const item = {
    ...lyrKey(name), kind: 'lyr', name, records: sets,
    owner: 'owner' in body ? body.owner?.trim() || null : existing?.owner || null,
    note: 'note' in body ? body.note?.trim() || null : existing?.note || null,
    createdAt: existing?.createdAt || now(), updatedAt: now(), updatedBy: who.userId,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return json(200, { name: publicLyr(item) });
}

// ---------------------------------------------------------------- admin

async function adminRoutes(event, method, path, who) {
  if (!isStaff(who.role)) return error(403, 'Admins only.');
  if (path === '/admin/lyr' || path.startsWith('/admin/lyr/')) return lyrAdminRoutes(event, method, path, who);
  const isSuper = who.role === 'superadmin';

  if (path === '/admin/domains' && method === 'GET') {
    const items = await collect(ScanCommand, { FilterExpression: '#k IN (:d, :o)', ExpressionAttributeNames: { '#k': 'kind' }, ExpressionAttributeValues: { ':d': 'domain', ':o': 'order' } });
    const [config, prices] = await Promise.all([getPricing(), wholesale()]);
    const domains = items.filter((item) => item.kind === 'domain' && !staleHold(item))
      .map((item) => ({ ...publicDomain(item, config, prices), ownerEmail: item.ownerEmail || null }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const orders = items.filter((item) => item.kind === 'order' && item.status !== 'open' && item.status !== 'expired')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const kept = orders.filter((order) => ['processing', 'fulfilled', 'paid'].includes(order.status));
    const revenue = kept.reduce((total, order) => total + order.amountCents, 0);
    const cost = kept.reduce((total, order) => total + (order.costCents || 0), 0);
    const fees = kept.reduce((total, order) => total + stripeFeeCents(order.amountCents), 0);
    return json(200, {
      domains,
      orders: orders.slice(0, 100).map((order) => ({ ...publicOrder(order), cost: order.costCents ?? null })),
      totals: { revenue, cost, fees, profit: revenue - cost - fees, orders: kept.length },
    });
  }

  if (path === '/admin/domain-pricing') {
    if (method === 'PUT') {
      if (!isSuper) return error(403, 'Only the super admin can change domain prices.');
      const body = parseJson(event);
      const refused = pricingError(body);
      if (refused) return error(...refused);
      const current = await getPricing();
      const allowed = ['percent', 'flatCents', 'dnsCentsPerYear', 'round99', 'tlds', 'overrides', 'subdomainCents', 'subdomainFreePlans'];
      const config = pricingConfig({ ...current, ...Object.fromEntries(allowed.filter((key) => key in body).map((key) => [key, body[key]])) });
      await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...PRICING_KEY, config, updatedAt: now(), updatedBy: who.userId } }));
      pricingCache = { value: config, at: Date.now() };
    } else if (method !== 'GET') return error(404, 'not_found');
    const [config, prices, stripeConfig] = await Promise.all([getPricing(), wholesale(), getStripe()]);
    const tlds = config.tlds.map((tld) => {
      const q = quote(prices, tld, config);
      return { tld, sold: sellable(prices, config, tld), wholesale: prices[tld] || null, ...q, fee: Number.isFinite(q.register) ? stripeFeeCents(q.register) : null };
    });
    return json(200, {
      config,
      tlds,
      available: Object.keys(prices).sort(),
      subdomains: { enabled: subdomainsOn(), zone: SUB_ZONE || null },
      stripe: {
        connected: Boolean(stripeConfig.secretKey),
        mode: stripeConfig.secretKey ? stripeMode(stripeConfig.secretKey) : null,
        connectedAt: stripeConfig.connectedAt || null,
        account: stripeConfig.account || null,
      },
    });
  }

  if (path === '/admin/stripe') {
    if (!isSuper) return error(403, 'Only the super admin can connect payments.');
    const current = await getStripe();
    if (method === 'DELETE') {
      if (current.webhookId) await stripe('DELETE', `/webhook_endpoints/${current.webhookId}`).catch((err) => console.error('webhook delete failed', err.message));
      await saveStripe({});
      return json(200, { connected: false });
    }
    if (method !== 'PUT') return error(404, 'not_found');
    const body = parseJson(event);
    const secretKey = String(body?.secretKey || '').trim();
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(secretKey)) return error(400, 'Paste a Stripe secret key that starts with sk_live_ or sk_test_.');
    let account;
    try {
      account = await stripe('GET', '/account', null, { secretKey });
    } catch (err) {
      return error(400, `Stripe didn’t accept that key: ${err.message}`);
    }
    if (current.webhookId && current.secretKey) {
      await stripe('DELETE', `/webhook_endpoints/${current.webhookId}`, null, { secretKey: current.secretKey }).catch(() => {});
    }
    const endpoint = await stripe('POST', '/webhook_endpoints', {
      url: `https://${event.requestContext.domainName}/public/stripe/webhook`,
      enabled_events: STRIPE_EVENTS,
      description: 'Lyrcloud Domains',
    }, { secretKey });
    const value = {
      secretKey, webhookSecret: endpoint.secret, webhookId: endpoint.id, connectedAt: now(),
      account: account.settings?.dashboard?.display_name || account.business_profile?.name || account.email || account.id,
    };
    await saveStripe(value);
    return json(200, { connected: true, mode: stripeMode(secretKey), account: value.account, connectedAt: value.connectedAt });
  }

  return error(404, 'not_found');
}

// ---------------------------------------------------------------- entry

// For tests: forget cached settings, prices and Stripe credentials.
export function resetCaches() {
  pricingCache = { value: null, at: 0 };
  pricesCache = { value: null, at: 0 };
  stripeCache = { value: null, at: 0 };
  lyrpayCache = { value: null, at: 0 };
  dnaCache = { value: null, at: 0 };
}

export const handler = async (event) => {
  if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') return tick();

  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  try {
    if (path === '/public/stripe/webhook' && method === 'POST') return await stripeWebhook(event);
    if (path === '/public/lyrpay/callback' && method === 'POST') return await lyrpayCallback(event);
    if (path === '/public/domains/search' && method === 'GET') return await search(event);
    if (path === '/public/domains/prices' && method === 'GET') return await priceList();
    if (path === '/dns-query' && (method === 'GET' || method === 'POST')) return await dnsQuery(event, method);
    if (path === '/public/lyr/lookup' && method === 'GET') return await lyrLookup(event);
    if (path === '/public/lyr/available' && method === 'GET') return await lyrAvailable(event);

    const who = await caller(event);
    if (!who) return error(401, 'unauthorized');
    if (who.profile.disabled === true && who.role !== 'superadmin') return error(403, 'This account has been disabled.');
    if (path.startsWith('/admin/')) return await adminRoutes(event, method, path, who);
    if (path === '/domains' || path.startsWith('/domains/')) return await domainRoutes(event, method, path, who);
    return error(404, 'not_found');
  } catch (err) {
    console.error('Domains API failed', err);
    if (err instanceof StripeError) return error(502, `Stripe said: ${err.message}`);
    if (err instanceof DnaError) {
      if (err.status === 429) return error(429, 'The registrar is busy. Try again in a moment.');
      if (err.status === 503 || err.code === 'Lyrcloud:RegistrarAuth') return error(503, 'Domain sales are paused for a moment. Please try again soon.');
      if (err.status === 400 || err.status === 422) return error(400, err.message);
      return error(502, 'The registrar didn’t answer. Please try again.');
    }
    if (err.name === 'TimeoutError') return error(504, 'The registrar took too long to answer. Please try again.');
    return error(500, 'Something went wrong. Please try again.');
  }
};
