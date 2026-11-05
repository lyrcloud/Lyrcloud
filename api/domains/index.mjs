// Lyrcloud Domains API: search, buy, transfer in and renew domains, resold through Route 53 Domains
// with Lyrcloud's commission on top (rules.mjs) and paid with Stripe Checkout.
//
//   GET    /public/domains/search?q=name     availability and prices for a name across TLDs
//   GET    /public/domains/prices            the price list for every TLD Lyrcloud sells
//   POST   /public/stripe/webhook            Stripe events: payment done -> register/transfer/renew
//   GET    /domains                          your domains, your saved registrant contact, payments status
//   POST   /domains/checkout                 { action, domain, years?, autoRenew?, contact?, authCode? } -> Stripe URL
//   GET    /domains/{name}                   one domain, its registrar details and DNS records
//   PUT    /domains/{name}                   { autoRenew }
//   PUT    /domains/{name}/records           { type, name, values[], ttl? } create or replace a record set
//   DELETE /domains/{name}/records?type=&name=   delete a record set
//   GET    /admin/domains                    every domain and recent order (staff)
//   GET    /admin/domain-pricing             commission settings, cost and price per TLD, Stripe status (staff)
//   PUT    /admin/domain-pricing             { percent?, flatCents?, dnsCentsPerYear?, round99?, tlds?, overrides? } (super admin)
//   PUT    /admin/stripe                     { secretKey } connect Stripe and register the webhook (super admin)
//   DELETE /admin/stripe                     disconnect Stripe (super admin)
//
// Money only moves one way: the customer pays Lyrcloud first, and only then does Lyrcloud buy the domain
// from Route 53. If the registrar refuses, the payment is refunded. Route 53 auto-renew stays off; a
// scheduled run (every 15 minutes) follows registrar operations and charges the saved card for renewals
// RENEW_DAYS_BEFORE days ahead, renewing at Route 53 only once that charge succeeds.
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  CheckDomainAvailabilityCommand,
  CheckDomainTransferabilityCommand,
  GetDomainDetailCommand,
  GetDomainSuggestionsCommand,
  GetOperationDetailCommand,
  ListPricesCommand,
  RegisterDomainCommand,
  RenewDomainCommand,
  Route53DomainsClient,
  TransferDomainCommand,
} from '@aws-sdk/client-route-53-domains';
import { ChangeResourceRecordSetsCommand, ListHostedZonesByNameCommand, ListResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { isStaff, roleFor } from '../account/roles.mjs';
import {
  checkoutError,
  cleanContact,
  cleanDomain,
  HOLD_MINUTES,
  orderAmount,
  pricingConfig,
  pricingError,
  priceTable,
  quote,
  recordError,
  recordName,
  renewalDue,
  route53Contact,
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
const SUPER_ADMIN_EMAIL = env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com';
const SITE_URL = env.SITE_URL || 'https://www.lyrcloud.com';
const ALLOWED_ORIGINS = String(env.ALLOWED_ORIGINS || SITE_URL).split(',').map((origin) => origin.trim());

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const secrets = new SecretsManagerClient({});
// Route 53 Domains only has an endpoint in us-east-1, and throttles checks to a few a second per account.
export const registrar = new Route53DomainsClient({ region: 'us-east-1', maxAttempts: 6, retryMode: 'adaptive' });
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
const PRICING_KEY = { pk: '#pricing', sk: 'config' };
const PRICES_KEY = { pk: '#prices', sk: 'route53' };

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

let pricingCache = { value: null, at: 0 };
async function getPricing() {
  if (!pricingCache.value || Date.now() - pricingCache.at > 30_000) {
    pricingCache = { value: pricingConfig((await getItem(PRICING_KEY))?.config), at: Date.now() };
  }
  return pricingCache.value;
}

// What Route 53 charges, per TLD, refreshed twice a day.
let pricesCache = { value: null, at: 0 };
async function wholesale() {
  if (pricesCache.value && Date.now() - pricesCache.at < PRICES_MAX_AGE_MS) return pricesCache.value;
  const stored = await getItem(PRICES_KEY);
  if (stored && Date.now() - Date.parse(stored.fetchedAt) < PRICES_MAX_AGE_MS) {
    pricesCache = { value: stored.table, at: Date.parse(stored.fetchedAt) };
    return stored.table;
  }
  const list = [];
  let Marker;
  do {
    const page = await registrar.send(new ListPricesCommand({ MaxItems: 1000, Marker }));
    list.push(...(page.Prices || []));
    Marker = page.NextPageMarker;
  } while (Marker);
  const table = priceTable(list);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...PRICES_KEY, table, fetchedAt: now() } }));
  pricesCache = { value: table, at: Date.now() };
  return table;
}

const sellable = (prices, config, tld) => config.tlds.includes(tld) && Number.isFinite(prices[tld]?.register) && Number.isFinite(prices[tld]?.renew);

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
  return { userId, profile, role: roleFor(profile, SUPER_ADMIN_EMAIL), email: profile.email || null };
}

// ---------------------------------------------------------------- availability

// Route 53 answers AVAILABLE, UNAVAILABLE, RESERVED, DONT_KNOW, ... Cached briefly so searches stay cheap.
async function availability(domain, { fresh = false } = {}) {
  const key = { pk: `avail#${domain}`, sk: 'avail' };
  if (!fresh) {
    const cached = await getItem(key);
    if (cached && cached.expiresAt > Date.now() / 1000) return cached.availability;
  }
  const { Availability } = await registrar.send(new CheckDomainAvailabilityCommand({ DomainName: domain }));
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...key, availability: Availability, expiresAt: Math.floor(Date.now() / 1000) + AVAILABILITY_CACHE_SECONDS } }));
  return Availability;
}

const offer = (domain, status, q) => ({ domain, tld: tldOf(domain), available: status === 'AVAILABLE', status, price: q.register, renew: q.renew });

async function search(event) {
  const q = String(event.queryStringParameters?.q || '').slice(0, 253);
  const name = searchName(q);
  if (!name) return error(400, 'Type a name to search for, like mybrand or mybrand.com.');
  const [config, prices] = await Promise.all([getPricing(), wholesale()]);
  const typed = q.includes('.') ? cleanDomain(q) : null;
  const candidates = [];
  if (typed && sellable(prices, config, tldOf(typed))) candidates.push(typed);
  for (const tld of config.tlds) {
    if (candidates.length >= 3) break;
    const domain = cleanDomain(`${name}.${tld}`);
    if (domain && !candidates.includes(domain) && sellable(prices, config, tld)) candidates.push(domain);
  }
  const results = await pool(candidates, 1, async (domain) => {
    try {
      return offer(domain, await availability(domain), quote(prices, tldOf(domain), config));
    } catch (err) {
      console.error('availability failed', domain, err.name);
      return { ...offer(domain, 'DONT_KNOW', quote(prices, tldOf(domain), config)), available: false };
    }
  });
  if (typed && !sellable(prices, config, tldOf(typed))) {
    results.unshift({ domain: typed, tld: tldOf(typed), available: false, status: 'NOT_SOLD', price: null, renew: null });
  }
  let suggestions = [];
  try {
    const { SuggestionsList } = await registrar.send(new GetDomainSuggestionsCommand({ DomainName: typed || `${name}.com`, SuggestionCount: 25, OnlyAvailable: true }));
    suggestions = (SuggestionsList || [])
      .map((item) => cleanDomain(item.DomainName))
      .filter((domain) => domain && !candidates.includes(domain) && sellable(prices, config, tldOf(domain)))
      .slice(0, 10)
      .map((domain) => offer(domain, 'AVAILABLE', quote(prices, tldOf(domain), config)));
  } catch (err) {
    console.error('suggestions failed', err.name);
  }
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
    lyrcloudDns: Boolean(item.hostedZoneId),
    createdAt: item.createdAt,
    activatedAt: item.activatedAt || null,
    holdUntil: item.status === 'awaiting_payment' ? item.holdUntil : null,
    checkoutUrl: item.status === 'awaiting_payment' ? item.checkoutUrl || null : null,
    operationStatus: item.operationStatus || null,
    operationMessage: item.operationMessage || null,
    failureReason: item.failureReason || null,
    renewing: item.renewing === true,
    lastRenewalError: item.lastRenewalError || null,
    renewPrice: q ? (item.hostedZoneId ? q.renew : q.renewNoDns) : null,
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
  return json(200, { domains, orders, contact: billing?.contact || null, paymentsReady: Boolean(stripeConfig.secretKey), currency: 'usd' });
}

// Why a transfer can't start, in words, for Route 53's Transferability answer.
const TRANSFER_REFUSALS = {
  UNTRANSFERABLE: 'This domain can’t be transferred right now. Unlock it at your current registrar, and note that domains can’t move within 60 days of being registered or transferred.',
  DOMAIN_IN_OWN_ACCOUNT: 'This domain is already with Lyrcloud’s registrar.',
  DOMAIN_IN_ANOTHER_ACCOUNT: 'This domain is with Route 53 in another account. Ask its owner to transfer it to Lyrcloud.',
  PREMIUM_DOMAIN: 'Premium domains can’t be transferred to Lyrcloud yet.',
  DONT_KNOW: 'The registry didn’t say whether this domain can move. Try again in a few minutes.',
};

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
  if (action === 'renew') {
    if (!existing || existing.ownerId !== who.userId) return error(404, 'That domain isn’t in your account.');
    if (existing.status !== 'active') return error(409, 'Only active domains can be renewed.');
    if (existing.renewing) return error(409, 'A renewal for this domain is already in progress.');
    const withDns = Boolean(existing.hostedZoneId);
    amount = (withDns ? q.renew : q.renewNoDns) * years;
    costCents = (withDns ? q.cost.renew : q.cost.renewNoDns) * years;
  } else {
    if (existing && existing.ownerId === who.userId && LIVE_STATUSES.includes(existing.status)) return error(409, `${domain} is already in your account.`);
    const free = !existing || ['failed', 'cancelled'].includes(existing.status) || staleHold(existing) || (existing.status === 'awaiting_payment' && existing.ownerId === who.userId);
    if (!free) return error(409, `${domain} is being bought by someone else. Try again in half an hour, or pick another name.`);
    if (action === 'register') {
      const status = await availability(domain, { fresh: true });
      if (status !== 'AVAILABLE') return error(409, `${domain} isn’t available to register. If it’s yours, transfer it in instead.`);
    } else {
      const { Transferability } = await registrar.send(new CheckDomainTransferabilityCommand({ DomainName: domain, AuthCode: body.authCode.trim() }));
      const answer = Transferability?.Transferable;
      if (answer !== 'TRANSFERABLE') return error(409, TRANSFER_REFUSALS[answer] || 'This domain can’t be transferred right now.');
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

  const billing = await getItem(billingKey(who.userId));
  const mode = stripeMode(stripeConfig.secretKey);
  const customer = billing?.stripeCustomers?.[mode];
  const origin = siteOrigin(event);
  const label = { register: 'Domain registration', transfer: 'Domain transfer (adds 1 year)', renew: 'Domain renewal' }[action];
  let session;
  try {
    session = await stripe('POST', '/checkout/sessions', {
      mode: 'payment',
      payment_method_types: ['card'],
      ...(customer ? { customer } : { customer_creation: 'always', customer_email: contact?.email || who.email || undefined }),
      client_reference_id: orderId,
      line_items: [{
        quantity: 1,
        price_data: { currency: 'usd', unit_amount: amount, product_data: { name: `${label}: ${domain}`, description: `${years} year${years === 1 ? '' : 's'}` } },
      }],
      payment_intent_data: { setup_future_usage: 'off_session', description: `${label}: ${domain}`, metadata: { orderId, domain, action } },
      metadata: { orderId, domain, action },
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: `${origin}/dash/#/domains/${domain}?paid=1`,
      cancel_url: `${origin}/dash/#/domains/buy?domain=${domain}&action=${action}&cancelled=1`,
    }, { idempotencyKey: `checkout-${orderId}` });
  } catch (err) {
    await update(orderKey(orderId), { status: 'expired', failureReason: err.message });
    if (action !== 'renew') await releaseHold(domain, orderId);
    if (err instanceof StripeError) return error(502, `Payment page couldn’t be created: ${err.message}`);
    throw err;
  }
  await update(orderKey(orderId), { sessionId: session.id });
  if (action !== 'renew') await update(domainKey(domain), { checkoutUrl: session.url });
  if (contact) await update(billingKey(who.userId), { kind: 'billing', contact, updatedAt: now() });
  return json(200, { url: session.url, orderId });
}

async function releaseHold(domain, orderId) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: domainKey(domain),
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

async function domainDetail(item, who) {
  const [config, prices] = await Promise.all([getPricing(), wholesale()]);
  const orders = (await itemsOf(item.ownerId)).filter((row) => row.kind === 'order' && row.domain === item.domain && row.status !== 'open' && row.status !== 'expired').map(publicOrder);
  let records = null;
  if (item.hostedZoneId && item.status === 'active') {
    records = (await zoneRecords(item.hostedZoneId)).map((set) => fromRecordSet(set, item.domain)).filter(Boolean);
  }
  return json(200, { domain: publicDomain(item, config, prices), records, orders, owner: isStaff(who.role) ? item.ownerEmail : undefined });
}

async function changeRecord(event, item, method) {
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
  const match = path.match(/^\/domains\/([^/]+)(\/records)?$/);
  if (!match) return error(404, 'not_found');
  const item = await ownedDomain(decodeURIComponent(match[1]), who);
  if (!item) return error(404, 'That domain isn’t in your account.');
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

async function startOperation(order) {
  if (order.action === 'renew') {
    const detail = await registrar.send(new GetDomainDetailCommand({ DomainName: order.domain }));
    const { OperationId } = await registrar.send(new RenewDomainCommand({
      DomainName: order.domain, DurationInYears: order.years, CurrentExpiryYear: new Date(detail.ExpirationDate).getUTCFullYear(),
    }));
    return OperationId;
  }
  const contact = route53Contact(order.contact);
  const contacts = {
    AdminContact: contact, RegistrantContact: contact, TechContact: contact,
    PrivacyProtectAdminContact: true, PrivacyProtectRegistrantContact: true, PrivacyProtectTechContact: true,
    AutoRenew: false,
  };
  if (order.action === 'transfer') {
    const { OperationId } = await registrar.send(new TransferDomainCommand({ DomainName: order.domain, DurationInYears: 1, AuthCode: order.authCode, ...contacts }));
    return OperationId;
  }
  const { OperationId } = await registrar.send(new RegisterDomainCommand({ DomainName: order.domain, DurationInYears: order.years, ...contacts }));
  return OperationId;
}

// Gives the money back when the registrar won't do what was paid for.
async function refund(order, reason) {
  console.error('refunding order', order.orderId, reason);
  if (order.paymentIntentId) {
    await stripe('POST', '/refunds', { payment_intent: order.paymentIntentId, metadata: { orderId: order.orderId } }, { idempotencyKey: `refund-${order.orderId}` });
  }
  await update(orderKey(order.orderId), { status: 'refunded', failureReason: reason, refundedAt: now() }, ['authCode']);
  if (order.action === 'renew') {
    await update(domainKey(order.domain), { renewing: false, lastRenewalError: `Renewal failed and was refunded: ${reason}` }, ['renewOrderId', 'renewOperationId']);
  } else {
    await update(domainKey(order.domain), { status: 'failed', failureReason: reason, failedAt: now() }, ['operationId', 'holdUntil', 'checkoutUrl']);
  }
}

export const TEST_MODE_REASON = 'Stripe is in test mode, so no real domain was bought. Connect a live Stripe key to sell domains.';

// After the money is in: start the registrar operation, or refund if it can't start.
// Test-mode payments are fake but registrar orders cost real money, so they never reach the registrar
// (unless ALLOW_TEST_REGISTRATIONS is set, as the tests do).
async function fulfil(order) {
  if (stripeMode((await getStripe()).secretKey) === 'test' && env.ALLOW_TEST_REGISTRATIONS !== '1') {
    await refund(order, TEST_MODE_REASON);
    return;
  }
  let operationId;
  try {
    operationId = await startOperation(order);
  } catch (err) {
    await refund(order, err.message || err.name);
    return;
  }
  await update(orderKey(order.orderId), { status: 'processing', operationId }, ['authCode']);
  if (order.action === 'renew') {
    await update(domainKey(order.domain), { renewing: true, renewOrderId: order.orderId, renewOperationId: operationId, lastRenewalError: null });
  } else {
    await update(domainKey(order.domain), {
      status: order.action === 'register' ? 'registering' : 'transferring',
      operationId, orderId: order.orderId, paidAt: now(), contact: order.contact,
      stripeCustomerId: order.stripeCustomerId, paymentMethodId: order.paymentMethodId,
    }, ['holdUntil', 'checkoutUrl']);
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
  if (order.action !== 'renew') await releaseHold(order.domain, orderId);
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

async function hostedZoneFor(domain) {
  const { HostedZones } = await dns.send(new ListHostedZonesByNameCommand({ DNSName: domain, MaxItems: 1 }));
  const zone = HostedZones?.find((item) => item.Name === `${domain}.` && !item.Config?.PrivateZone);
  return zone ? zone.Id.split('/').pop() : null;
}

async function followOperation(item) {
  const renewal = item.renewing && item.renewOperationId;
  const OperationId = renewal ? item.renewOperationId : item.operationId;
  const orderId = renewal ? item.renewOrderId : item.orderId;
  const op = await registrar.send(new GetOperationDetailCommand({ OperationId }));
  if (op.Status === 'SUCCESSFUL') {
    const detail = await registrar.send(new GetDomainDetailCommand({ DomainName: item.domain }));
    const facts = { expiresAt: new Date(detail.ExpirationDate).toISOString(), nameservers: (detail.Nameservers || []).map((ns) => ns.Name) };
    if (renewal) {
      await update(domainKey(item.domain), { ...facts, renewing: false, lastRenewedAt: now(), lastRenewalError: null }, ['renewOperationId', 'renewOrderId']);
    } else {
      const hostedZoneId = item.action === 'register' ? await hostedZoneFor(item.domain) : null;
      await update(domainKey(item.domain), { ...facts, status: 'active', activatedAt: now(), hostedZoneId: hostedZoneId || undefined, operationStatus: op.Status }, ['operationMessage']);
    }
    if (orderId) await update(orderKey(orderId), { status: 'fulfilled', fulfilledAt: now() });
  } else if (op.Status === 'FAILED' || op.Status === 'ERROR') {
    const order = orderId && (await getItem(orderKey(orderId)));
    if (order && order.status !== 'refunded') await refund(order, op.Message || `The registrar reported ${op.Status}.`);
  } else {
    await update(domainKey(item.domain), { operationStatus: op.Status, operationMessage: op.StatusFlag ? `${op.StatusFlag}: ${op.Message || ''}`.trim() : op.Message || null, checkedAt: now() });
  }
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
  const withDns = Boolean(item.hostedZoneId);
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
  const items = await collect(ScanCommand, { FilterExpression: '#k = :d', ExpressionAttributeNames: { '#k': 'kind' }, ExpressionAttributeValues: { ':d': 'domain' } });
  const day = 86_400_000;
  await pool(items, 2, async (item) => {
    try {
      if ((['registering', 'transferring'].includes(item.status) && item.operationId) || (item.renewing && item.renewOperationId)) {
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
  return { checked: items.length };
}

// ---------------------------------------------------------------- admin

async function adminRoutes(event, method, path, who) {
  if (!isStaff(who.role)) return error(403, 'Admins only.');
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
      const allowed = ['percent', 'flatCents', 'dnsCentsPerYear', 'round99', 'tlds', 'overrides'];
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
}

export const handler = async (event) => {
  if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') return tick();

  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  try {
    if (path === '/public/stripe/webhook' && method === 'POST') return await stripeWebhook(event);
    if (path === '/public/domains/search' && method === 'GET') return await search(event);
    if (path === '/public/domains/prices' && method === 'GET') return await priceList();

    const who = await caller(event);
    if (!who) return error(401, 'unauthorized');
    if (who.profile.disabled === true && who.role !== 'superadmin') return error(403, 'This account has been disabled.');
    if (path.startsWith('/admin/')) return await adminRoutes(event, method, path, who);
    if (path === '/domains' || path.startsWith('/domains/')) return await domainRoutes(event, method, path, who);
    return error(404, 'not_found');
  } catch (err) {
    console.error('Domains API failed', err);
    if (err instanceof StripeError) return error(502, `Stripe said: ${err.message}`);
    if (err.name === 'ThrottlingException' || err.name === 'TooManyRequestsException') return error(429, 'The registrar is busy. Try again in a moment.');
    if (err.name === 'UnsupportedTLD') return error(400, 'That domain ending isn’t supported.');
    if (err.name === 'InvalidInput') return error(400, err.message);
    return error(500, 'Something went wrong. Please try again.');
  }
};
