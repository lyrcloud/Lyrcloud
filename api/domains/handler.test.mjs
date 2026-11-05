// Domains API end to end, with DynamoDB, Route 53, Secrets Manager, DNA and Stripe replaced by in-memory fakes.
// The DynamoDB fake evaluates the condition expressions the API uses, so holds and claims are tested for real.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { Route53Client } from '@aws-sdk/client-route-53';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readResponse, wireQuery } from './dns-test-helpers.mjs';

process.env.TABLE_NAME = 'domains';
process.env.USERS_TABLE_NAME = 'users';
process.env.STRIPE_SECRET_NAME = 'stripe';
process.env.ALLOW_TEST_REGISTRATIONS = '1';
process.env.SUBDOMAIN_ZONE = 'lyr.cloud';
process.env.SUBDOMAIN_ZONE_ID = 'ZLYR';
process.env.DNA_JSON = JSON.stringify({ apiKey: 'live-key', resellerId: '00000000-0000-4000-8000-000000000001', testApiKey: 'test-key' });
const { handler, resetCaches, tick, TEST_MODE_REASON } = await import('./index.mjs');

const SUPER = { userId: 'sub-super', email: 'lyrclouds@gmail.com', provider: 'GoogleOIDC' };
const ALICE = { userId: 'sub-alice', email: 'alice@example.com', provider: 'GoogleOIDC' };
const BOB = { userId: 'sub-bob', email: 'bob@example.com', provider: 'GitHubBridge' };
const CONTACT = {
  firstName: 'Alice', lastName: 'Liddell', email: 'alice@example.com', phoneCountry: '+1', phone: '6615550100',
  address1: '1 Rabbit Hole', city: 'Oxford', state: 'CA', zip: '94000', country: 'US',
};
const WEBHOOK_SECRET = 'whsec_test';

// ---------------------------------------------------------------- DynamoDB fake

let tables;
const keyOf = (table, key) => (table === 'users' ? key.userId : `${key.pk}|${key.sk}`);

// A small parser for the condition/filter expressions the API writes.
function evaluate(expression, item, names = {}, values = {}) {
  const tokens = expression.match(/\(|\)|,|<=|>=|<>|=|<|>|[#:]?[A-Za-z_][\w]*/g);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const operand = () => {
    const token = next();
    if (token.startsWith(':')) return values[token];
    if (token.startsWith('#')) return item?.[names[token]];
    return item?.[token];
  };
  const term = () => {
    if (peek() === '(') {
      next();
      const value = or();
      next();
      return value;
    }
    if (peek() === 'attribute_not_exists') {
      next(); next();
      const token = next();
      next();
      return item?.[token.startsWith('#') ? names[token] : token] === undefined;
    }
    const left = operand();
    const op = next();
    if (op === 'IN') {
      next();
      const list = [operand()];
      while (peek() === ',') { next(); list.push(operand()); }
      next();
      return list.includes(left);
    }
    const right = operand();
    return { '=': left === right, '<>': left !== right, '<': left < right, '>': left > right, '<=': left <= right, '>=': left >= right }[op];
  };
  const and = () => {
    let value = term();
    while (peek() === 'AND') { next(); value = term() && value; }
    return value;
  };
  const or = () => {
    let value = and();
    while (peek() === 'OR') { next(); value = and() || value; }
    return value;
  };
  return or();
}

const conditionFailed = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const input = command.input;
  const table = tables[input.TableName] ??= new Map();
  const check = (item) => {
    if (input.ConditionExpression && !evaluate(input.ConditionExpression, item, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) throw conditionFailed();
  };
  if (name === 'GetCommand') return { Item: structuredClone(table.get(keyOf(input.TableName, input.Key))) };
  if (name === 'PutCommand') {
    check(table.get(keyOf(input.TableName, input.Item)));
    table.set(keyOf(input.TableName, input.Item), structuredClone(input.Item));
    return {};
  }
  if (name === 'DeleteCommand') {
    check(table.get(keyOf(input.TableName, input.Key)));
    table.delete(keyOf(input.TableName, input.Key));
    return {};
  }
  if (name === 'UpdateCommand') {
    const key = keyOf(input.TableName, input.Key);
    const existing = table.get(key);
    check(existing);
    const item = existing ? structuredClone(existing) : { ...input.Key };
    const [, set = '', remove = ''] = input.UpdateExpression.match(/^(?:SET (.*?))?(?: ?REMOVE (.*))?$/);
    for (const part of set ? set.split(', ') : []) {
      const [field, value] = part.split(' = ');
      item[input.ExpressionAttributeNames[field]] = structuredClone(input.ExpressionAttributeValues[value]);
    }
    for (const field of remove ? remove.split(', ') : []) delete item[input.ExpressionAttributeNames[field]];
    table.set(key, item);
    return { Attributes: structuredClone(item) };
  }
  if (name === 'QueryCommand') {
    const items = [...table.values()].filter((item) => item.ownerId === input.ExpressionAttributeValues[':o'])
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { Items: structuredClone(items) };
  }
  if (name === 'ScanCommand') {
    const items = [...table.values()].filter((item) => !input.FilterExpression || evaluate(input.FilterExpression, item, input.ExpressionAttributeNames, input.ExpressionAttributeValues));
    return { Items: structuredClone(items) };
  }
  throw new Error(`unexpected ${name}`);
};

// ---------------------------------------------------------------- AWS fakes

let secret;
SecretsManagerClient.prototype.send = async function send(command) {
  if (command.constructor.name === 'GetSecretValueCommand') return { SecretString: secret };
  secret = command.input.SecretString;
  return {};
};

// ---------------------------------------------------------------- DNA fake (api. and ote.domainresellerapi.com)

let registrarCalls; // [path, body, query, env] for every DNA call
let registrarState; // taken names, what the registry does next, and the domains it holds
let dnaZone; // the DNA zone of the registered domain: [{ name, type, ttl, records: [{ content }] }]
const DNA_KEYS = { apiKey: 'live-key', resellerId: '00000000-0000-4000-8000-000000000001', testApiKey: 'test-key' };
const catalogueEntry = (name, price, extra = {}) => ({
  name, registrationPeriods: [1, 2, 3, 5], renewalPeriods: [1, 2, 3, 5], isPrivacyAvailable: true, isSupportTransfer: true, isTransferCheckSupported: true, attributes: [],
  prices: [{ priceGroup: 'Reseller', register: [{ period: 1, price, currency: 'USD' }], renew: [{ period: 1, price, currency: 'USD' }], transfer: [{ period: 1, price, currency: 'USD' }] }],
  ...extra,
});
// DNA answers in Turkish time without a zone, like /domains/info does.
const turkeyTime = (iso) => new Date(Date.parse(iso) + 3 * 3600_000).toISOString().replace('Z', '');
const dnaFail = (status, code, message) => ({ status, body: { error: { code, message, details: message } } });

function dnaAnswer(method, path, body, query) {
  const state = registrarState;
  const held = (domain) => state.held[domain];
  switch (`${method} ${path}`) {
    case 'GET deposit/accounts/me':
      return { body: { resellerGroupName: 'Reseller', usdBalance: 500 } };
    case 'GET products/tlds':
      return { body: { totalCount: 5, items: [catalogueEntry('com', 16), catalogueEntry('io', 71), catalogueEntry('net', 17), catalogueEntry('ninja', 30), catalogueEntry('org', 15, { attributes: [{ key: 'X', isRequired: true, type: 'Text' }] })] } };
    case 'POST domains/search':
      return { body: { success: true, info: { domainName: body.domainName, status: state.taken.includes(body.domainName) ? 'NOTAVAILABLE' : 'AVAILABLE', isPremium: state.premium.includes(body.domainName) } } };
    case 'POST domains/bulk-search':
      // Like DNA, silently leave out names it can't answer (here: .io during an outage).
      return { body: { success: true, infos: body.filter(({ domainName }) => !state.dropped.includes(domainName)).map(({ domainName }) => ({ domainName, status: state.taken.includes(domainName) ? 'NOTAVAILABLE' : 'AVAILABLE' })) } };
    case 'POST domains/transfers/check':
      return body.authCode === 'good-code' ? { body: { authCodeIsValid: true, transferAvailabilityStatus: true } } : dnaFail(400, 'Dna.DomainService:Domain:10006', 'Transfer lock is active');
    case 'POST domains/register-with-contacts':
    case 'POST domains/transfer':
    case 'POST domains/renew':
      if (state.refuse === 'balance') return dnaFail(402, 'Dna.DomainService:Deposit:10001', 'Insufficient balance');
      if (state.refuse) return dnaFail(403, 'Dna.DomainService:Epp:10001', 'The registry refused this name.');
      if (state.broke) return dnaFail(500, state.broke, 'Registry created it, but the record could not be written');
      if (path === 'domains/renew') {
        state.held[body.domainName].expirationDate = turkeyTime(state.expiresAt);
        return { body: { success: true, status: 'Active' } };
      }
      state.held[body.domainName] = { status: path === 'domains/transfer' ? 'WaitingForIncomingTransfer' : state.status, expirationDate: turkeyTime(state.expiresAt) };
      return { body: { success: true, domainId: `d-${body.domainName}`, status: state.status, expirationDate: state.expiresAt } };
    case 'POST domains/renew/check':
      return { body: { renewabilityStatus: !state.renewLocked, errorMessageKey: state.renewLocked ? 'Dna.DomainService:Domain:10045' : null, isPremium: false } };
    case 'GET domains/info': {
      const domain = held(query.domainName);
      if (!domain) return dnaFail(404, 'Dna.DomainService:Domain:10007', 'Not found');
      return { body: { domainName: query.domainName, status: domain.status, expirationDate: domain.expirationDate, nameservers: ['tr.domainnameapi.com', 'eu.domainnameapi.com'], contacts: [{ contactType: 'Registrant', handle: 'D-100' }] } };
    }
    case 'POST domains/transfers/query':
      return { body: { domainName: body.domainName, status: state.transferStatus, finalDate: '2026-11-10T12:00:00' } };
    case 'POST domains/privacy':
      return { status: 204 };
    case 'POST domains/zones/apply':
      return { body: { nameServersChanged: false } };
    case 'GET domains/zones':
      return { body: dnaZone };
    case 'POST domains/zones':
    case 'PUT domains/zones': {
      const { zoneStruct } = body;
      const full = (label) => (label === '@' ? `${query.domainName}.` : `${label}.${query.domainName}.`);
      if (method === 'PUT') dnaZone = dnaZone.filter((set) => !(set.name === full(query.recordName) && set.type === zoneStruct.type));
      const set = dnaZone.find((item) => item.name === full(zoneStruct.name) && item.type === zoneStruct.type);
      const records = zoneStruct.contents.map((content) => ({ content: zoneStruct.type === 'TXT' ? `"${content}"` : content, disabled: false }));
      if (set) set.records.push(...records);
      else dnaZone.push({ name: full(zoneStruct.name), type: zoneStruct.type, ttl: zoneStruct.ttl, records });
      return { status: 204 };
    }
    case 'DELETE domains/zones':
      for (const set of dnaZone) if (set.name === `${body.name}.` && set.type === body.recordType) set.records = set.records.filter((record) => record.content !== body.record);
      dnaZone = dnaZone.filter((set) => set.records.length);
      return { status: 204 };
    case 'GET contacts/verification/check':
      return state.verified
        ? dnaFail(403, 'Dna.DomainService:Contact:Verification:10005', 'No verification')
        : { body: { results: [{ fieldType: 'Email', fieldValue: 'alice@example.com', operationStatus: 'VerificationPending', isUserVerified: false, tokenExpireDate: '2026-11-20T10:00:00' }] } };
    case 'POST contacts/verification/request':
      return { status: 204 };
    default:
      throw new Error(`unexpected DNA ${method} ${path}`);
  }
}

async function dnaFetch(url, { method, body, headers }) {
  const env = url.hostname.startsWith('ote.') ? 'test' : 'live';
  const path = url.pathname.replace('/api/v1/', '');
  const query = Object.fromEntries(url.searchParams);
  const parsed = body ? JSON.parse(body) : undefined;
  registrarCalls.push([`${method} ${path}`, parsed, query, env]);
  if (headers['X-API-KEY'] !== (env === 'test' ? DNA_KEYS.testApiKey : DNA_KEYS.apiKey)) {
    return new Response(null, { status: 302, headers: { location: '/Error/Suspend?reseller=&user=' } });
  }
  const { status = 200, body: answer } = dnaAnswer(method, path, parsed, query);
  return new Response(answer === undefined ? null : JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
}

let dnsCalls;
let zone; // the registered domain's hosted zone (Z123)
let subZone; // the lyr.cloud zone (ZLYR)
// Route 53 lists record sets in DNS order: by labels from the right.
const labels = (name) => String(name).replace(/\.$/, '').split('.').reverse();
function dnsCompare(a, b) {
  const [x, y] = [labels(a), labels(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length - y.length;
}
Route53Client.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const input = command.input;
  dnsCalls.push([name, input]);
  const sets = () => (input.HostedZoneId === 'ZLYR' ? subZone : zone);
  if (name === 'ListHostedZonesByNameCommand') return { HostedZones: [{ Id: '/hostedzone/Z123', Name: `${input.DNSName}.`, Config: { PrivateZone: false } }] };
  if (name === 'ListResourceRecordSetsCommand') {
    const sorted = structuredClone(sets()).sort((a, b) => dnsCompare(a.Name, b.Name) || (a.Type < b.Type ? -1 : 1));
    const from = input.StartRecordName ? sorted.filter((set) => dnsCompare(set.Name, input.StartRecordName) >= 0) : sorted;
    return { ResourceRecordSets: from, IsTruncated: false };
  }
  if (name === 'ChangeResourceRecordSetsCommand') {
    let list = sets();
    for (const change of input.ChangeBatch.Changes) {
      const set = { ...change.ResourceRecordSet, Name: change.ResourceRecordSet.Name.replace(/\.?$/, '.') };
      list = list.filter((item) => !(item.Name === set.Name && item.Type === set.Type));
      if (change.Action === 'UPSERT') list.push(set);
    }
    if (input.HostedZoneId === 'ZLYR') subZone = list;
    else zone = list;
    return {};
  }
  throw new Error(`unexpected ${name}`);
};

// ---------------------------------------------------------------- Stripe fake

let stripeCalls;
let stripeState;
let upstreamQueries;
globalThis.fetch = async (url, { method, body, headers } = {}) => {
  const host = new URL(url).hostname;
  if (host.endsWith('domainresellerapi.com')) return dnaFetch(new URL(url), { method, body, headers });
  if (host === 'cloudflare-dns.com') {
    upstreamQueries.push(Buffer.from(body));
    const reply = Buffer.from(body);
    reply[2] |= 0x80; // echo the query back as an empty answer
    return new Response(reply, { status: 200, headers: { 'content-type': 'application/dns-message' } });
  }
  if (host === 'dns.google') return new Response(JSON.stringify({ Answer: [{ name: 'target.example.net.', type: 1, TTL: 30, data: '198.51.100.7' }] }), { status: 200 });
  const path = new URL(url).pathname.replace('/v1', '');
  const params = Object.fromEntries(new URLSearchParams(body || new URL(url).search));
  stripeCalls.push({ method, path, params, key: headers.authorization });
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'GET' && path === '/account') return reply(200, { id: 'acct_1', email: 'owner@lyrcloud.com' });
  if (method === 'POST' && path === '/webhook_endpoints') return reply(200, { id: 'we_1', secret: WEBHOOK_SECRET });
  if (method === 'POST' && path === '/checkout/sessions') {
    const id = `cs_${stripeCalls.length}`;
    return reply(200, { id, url: `https://checkout.stripe.com/c/${id}` });
  }
  if (method === 'GET' && path.startsWith('/payment_intents/')) return reply(200, { id: path.split('/').pop(), payment_method: 'pm_card' });
  if (method === 'POST' && path === '/payment_intents') {
    return stripeState.decline
      ? reply(402, { error: { message: 'Your card was declined.', code: 'card_declined' } })
      : reply(200, { id: 'pi_renew', status: 'succeeded' });
  }
  if (method === 'POST' && path === '/refunds') return reply(200, { id: 're_1' });
  throw new Error(`unexpected Stripe ${method} ${path}`);
};

// ---------------------------------------------------------------- helpers

function call(person, method, path, body, query) {
  return handler({
    requestContext: { http: { method, path }, domainName: 'domains.example', authorizer: person ? { jwt: { claims: { sub: person.userId } } } : undefined },
    headers: { origin: 'https://www.lyrcloud.com' },
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((response) => ({ status: response.statusCode, body: JSON.parse(response.body) }));
}

function webhook(type, object, secretUsed = WEBHOOK_SECRET) {
  const body = JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secretUsed).update(`${t}.${body}`).digest('hex');
  return handler({
    requestContext: { http: { method: 'POST', path: '/public/stripe/webhook' } },
    headers: { 'stripe-signature': `t=${t},v1=${signature}` },
    body,
  }).then((response) => ({ status: response.statusCode, body: JSON.parse(response.body) }));
}

const domainsTable = () => tables.domains;
const domainItem = (domain) => domainsTable().get(`domain#${domain}|domain`);
const ordersOf = () => [...domainsTable().values()].filter((item) => item.kind === 'order');
const called = (name) => registrarCalls.filter(([callName]) => callName === name);
const REGISTER = 'POST domains/register-with-contacts';

// Test-mode Stripe sends orders to DNA's test environment; a live key sends them to live DNA.
async function connectStripe(secretKey = 'sk_test_1234567890abcdef') {
  return call(SUPER, 'PUT', '/admin/stripe', { secretKey });
}

// Buys `domain` for `person` through Checkout and returns the paid session as Stripe would send it.
async function buy(person, domain, extra = {}) {
  const res = await call(person, 'POST', '/domains/checkout', { action: 'register', domain, contact: CONTACT, ...extra });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const order = ordersOf().find((item) => item.orderId === res.body.orderId);
  return { res, order, session: { id: order.sessionId, metadata: { orderId: order.orderId }, payment_status: 'paid', amount_total: order.amountCents, currency: 'usd', payment_intent: 'pi_1', customer: 'cus_1' } };
}

beforeEach(() => {
  resetCaches();
  tables = { users: new Map(), domains: new Map() };
  for (const person of [SUPER, ALICE, BOB]) tables.users.set(person.userId, { ...person });
  secret = '{}';
  registrarCalls = [];
  registrarState = {
    taken: ['taken.com'], premium: ['fancy.com'], dropped: [], refuse: false, broke: null, renewLocked: false, verified: false,
    status: 'Active', expiresAt: '2027-11-04T00:00:00Z', transferStatus: 'pending', held: {},
  };
  dnaZone = [{ name: 'wonder.com.', type: 'SOA', ttl: 3600, records: [{ content: 'tr.domainnameapi.com. hostmaster.wonder.com. 1 86400 7200 1209600 300' }] }];
  dnsCalls = [];
  zone = [{ Name: 'wonder.com.', Type: 'NS', TTL: 172800, ResourceRecords: [{ Value: 'ns-1.awsdns-01.org.' }] }];
  subZone = [
    { Name: 'lyr.cloud.', Type: 'NS', TTL: 172800, ResourceRecords: [{ Value: 'ns-9.awsdns-09.net.' }] },
    { Name: 'lyr.cloud.', Type: 'SOA', TTL: 900, ResourceRecords: [{ Value: 'ns-9.awsdns-09.net. hostmaster 1 7200 900 1209600 86400' }] },
  ];
  stripeCalls = [];
  stripeState = { decline: false };
  upstreamQueries = [];
});

// ---------------------------------------------------------------- tests

test('the public price list is DNA’s price plus a 1% commission, without DNS or .99 rounding', async () => {
  const { status, body } = await call(null, 'GET', '/public/domains/prices');
  assert.equal(status, 200);
  const com = body.tlds.find((item) => item.tld === 'com');
  // $16 * 1.01 = $16.16 for register, renew and transfer alike; DNA hosts the DNS for free.
  assert.deepEqual([com.register, com.renew, com.transfer], [1616, 1616, 1616]);
  assert.equal(body.tlds.some((item) => item.tld === 'ninja'), false, 'TLDs that are not enabled are not sold');
  assert.equal(body.tlds.some((item) => item.tld === 'org'), false, 'TLDs that need extra registry fields are not sold');
  assert.equal(called('GET products/tlds')[0][2].currency, 'USD');
  assert.equal(called('GET products/tlds')[0][3], 'live', 'prices always come from live DNA');
});

test('the Route 53-era settings keep their TLDs and subdomain price but not their commission', async () => {
  tables.domains.set('#pricing|config', { pk: '#pricing', sk: 'config', config: { percent: 0, flatCents: 99, round99: true, dnsCentsPerYear: 0, tlds: ['com', 'net'], subdomainCents: 299 } });
  const { body } = await call(null, 'GET', '/public/domains/prices');
  assert.deepEqual(body.tlds.map((item) => [item.tld, item.register]), [['com', 1616], ['net', 1717]]);
  assert.equal((await call(ALICE, 'GET', '/domains')).body.subdomains.price, 299);
});

test('search answers every TLD in one bulk search and never calls a dropped name available', async () => {
  registrarState.dropped = ['taken.io'];
  const { body } = await call(null, 'GET', '/public/domains/search', undefined, { q: 'Taken.com' });
  assert.equal(body.query, 'taken');
  assert.deepEqual(body.results.map((item) => [item.domain, item.status]), [['taken.com', 'UNAVAILABLE'], ['taken.net', 'AVAILABLE'], ['taken.io', 'DONT_KNOW']]);
  assert.equal(body.results.find((item) => item.domain === 'taken.net').price, 1717);
  assert.equal(body.results.find((item) => item.domain === 'taken.io').available, false);
  assert.equal(called('POST domains/bulk-search').length, 1);
  assert.equal(called('POST domains/search').length, 0);
  const ninja = await call(null, 'GET', '/public/domains/search', undefined, { q: 'wonder.ninja' });
  assert.equal(ninja.body.results[0].status, 'NOT_SOLD');
  assert.equal((await call(null, 'GET', '/public/domains/search', undefined, { q: '!!!' })).status, 400);
});

test('nothing can be bought until the super admin connects Stripe', async () => {
  const res = await call(ALICE, 'POST', '/domains/checkout', { action: 'register', domain: 'wonder.com', contact: CONTACT });
  assert.equal(res.status, 503);
  assert.equal((await call(ALICE, 'PUT', '/admin/stripe', { secretKey: 'sk_test_1234567890abcdef' })).status, 403);
  const connected = await connectStripe();
  assert.equal(connected.body.mode, 'test');
  assert.equal(JSON.parse(secret).webhookSecret, WEBHOOK_SECRET);
  assert.equal(stripeCalls.find((item) => item.path === '/webhook_endpoints').params.url, 'https://domains.example/public/stripe/webhook');
});

test('checkout holds the name, charges the quoted price and blocks other buyers', async () => {
  await connectStripe();
  const { res, order } = await buy(ALICE, 'wonder.com', { years: 2 });
  assert.match(res.body.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(order.amountCents, 3232);
  assert.equal(order.costCents, 3200);
  const session = stripeCalls.find((item) => item.path === '/checkout/sessions').params;
  assert.equal(session['line_items[0][price_data][unit_amount]'], '3232');
  assert.equal(session['payment_intent_data[setup_future_usage]'], 'off_session');
  assert.equal(session.success_url, 'https://www.lyrcloud.com/dash/#/domains/wonder.com?paid=1');
  assert.equal(domainItem('wonder.com').status, 'awaiting_payment');

  const bob = await call(BOB, 'POST', '/domains/checkout', { action: 'register', domain: 'wonder.com', contact: CONTACT });
  assert.equal(bob.status, 409);
  assert.equal((await call(ALICE, 'POST', '/domains/checkout', { action: 'register', domain: 'wonder.com', contact: CONTACT })).status, 200, 'the holder can start again');
  assert.equal((await call(ALICE, 'POST', '/domains/checkout', { action: 'register', domain: 'taken.com', contact: CONTACT })).status, 409);
  assert.match((await call(ALICE, 'POST', '/domains/checkout', { action: 'register', domain: 'fancy.com', contact: CONTACT })).body.error, /premium/);
  assert.match((await call(ALICE, 'POST', '/domains/checkout', { action: 'register', domain: 'other.com', years: 4, contact: CONTACT })).body.error, /1, 2, 3, 5 years/);
  assert.equal((await call(ALICE, 'GET', '/domains')).body.contact.city, 'Oxford', 'the contact is saved for next time');

  // A hold nobody paid for can be taken over.
  domainsTable().get('domain#wonder.com|domain').holdUntil = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call(BOB, 'POST', '/domains/checkout', { action: 'register', domain: 'wonder.com', contact: CONTACT })).status, 200);
});

test('a paid test-mode checkout registers once at DNA’s test registry, and a forged webhook does nothing', async () => {
  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  assert.equal((await webhook('checkout.session.completed', session, 'whsec_wrong')).status, 400);
  assert.equal(called(REGISTER).length, 0);

  assert.equal((await webhook('checkout.session.completed', session)).status, 200);
  await webhook('checkout.session.completed', session); // Stripe retries
  const registrations = called(REGISTER);
  assert.equal(registrations.length, 1);
  const [, input, , env] = registrations[0];
  assert.equal(env, 'test');
  assert.equal(input.domainName, 'wonder.com');
  assert.equal(input.period, 1);
  assert.deepEqual(input.nameServers, ['tr.domainnameapi.com', 'eu.domainnameapi.com']);
  assert.deepEqual(input.contacts.map((c) => [c.contactType, c.eMail, c.phoneCountryCode, c.phone]), [['Registrant', 'alice@example.com', '1', '6615550100']]);
  const item = domainItem('wonder.com');
  assert.equal(item.status, 'active', 'DNA registered it in the call, so it is live straight away');
  assert.deepEqual([item.registrar, item.registrarEnv, item.dnsProvider, item.registrantHandle], ['dna', 'test', 'dna', 'D-100']);
  assert.equal(item.paymentMethodId, 'pm_card');
  assert.equal(called('POST domains/privacy')[0][1].privacyStatus, true);
  assert.equal(called('POST domains/zones/apply').length, 0, 'the test environment has no DNS records API');
  assert.equal(ordersOf()[0].status, 'fulfilled');
  assert.equal((await call(ALICE, 'GET', '/domains')).body.domains[0].testRegistry, true);
});

test('in Stripe test mode without a DNA test key a paid order is refunded instead of buying a real domain', async () => {
  const keys = process.env.DNA_JSON;
  process.env.DNA_JSON = JSON.stringify({ ...JSON.parse(keys), testApiKey: undefined });
  try {
    await connectStripe();
    const { session, order } = await buy(ALICE, 'wonder.com');
    await webhook('checkout.session.completed', session);
    assert.equal(called(REGISTER).length, 0);
    assert.equal(domainsTable().get(`order#${order.orderId}|order`).status, 'refunded');
    assert.equal(domainItem('wonder.com').failureReason, TEST_MODE_REASON);
  } finally {
    process.env.DNA_JSON = keys;
  }
});

test('a tampered amount is never fulfilled', async () => {
  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', { ...session, amount_total: 100 });
  assert.equal(called(REGISTER).length, 0);
});

test('when the registrar refuses, the payment is refunded and the name is free again', async () => {
  await connectStripe();
  registrarState.refuse = true;
  const { session, order } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  assert.equal(stripeCalls.filter((item) => item.path === '/refunds').length, 1);
  assert.equal(domainsTable().get(`order#${order.orderId}|order`).status, 'refunded');
  assert.equal(domainItem('wonder.com').status, 'failed');
  assert.match(domainItem('wonder.com').failureReason, /registry refused/);
  registrarState.refuse = false;
  assert.equal((await call(BOB, 'POST', '/domains/checkout', { action: 'register', domain: 'wonder.com', contact: CONTACT })).status, 200);
});

test('an empty DNA balance refunds the customer without telling them about Lyrcloud’s balance', async () => {
  await connectStripe('sk_live_1234567890abcdef');
  registrarState.refuse = 'balance';
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  assert.equal(called(REGISTER)[0][3], 'live');
  assert.equal(stripeCalls.filter((item) => item.path === '/refunds').length, 1);
  assert.doesNotMatch(domainItem('wonder.com').failureReason, /balance/i);
});

test('an order the registry did but DNA couldn’t record is never retried or refunded, and is picked up later', async () => {
  await connectStripe();
  registrarState.broke = 'Dna.DomainService:Domain:10058';
  const { session, order } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  assert.equal(stripeCalls.filter((item) => item.path === '/refunds').length, 0);
  assert.equal(domainItem('wonder.com').status, 'registering');
  await tick();
  assert.equal(called(REGISTER).length, 1, 'never sent again');
  assert.equal(domainItem('wonder.com').status, 'registering', 'still unknown to /domains/info');
  registrarState.held['wonder.com'] = { status: 'Active', expirationDate: '2027-11-04T03:00:00' };
  await tick();
  assert.equal(domainItem('wonder.com').status, 'active');
  assert.equal(domainsTable().get(`order#${order.orderId}|order`).status, 'fulfilled');
});

test('an abandoned checkout releases the hold', async () => {
  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.expired', session);
  assert.equal(domainItem('wonder.com'), undefined);
});

test('the scheduled run activates a waiting registration on DNA’s DNS, whose records can be edited', async () => {
  await connectStripe('sk_live_1234567890abcdef');
  registrarState.status = 'WaitingForRegistration';
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  assert.equal(domainItem('wonder.com').status, 'registering');
  assert.match(domainItem('wonder.com').operationMessage, /still processing/);
  registrarState.held['wonder.com'].status = 'Active';
  await tick();
  const item = domainItem('wonder.com');
  assert.equal(item.status, 'active');
  assert.equal(item.registrarEnv, 'live');
  assert.equal(item.expiresAt, '2027-11-04T00:00:00.000Z');
  assert.deepEqual(item.nameservers, ['tr.domainnameapi.com', 'eu.domainnameapi.com']);
  assert.equal(called('POST domains/zones/apply').length, 1);
  assert.equal(ordersOf()[0].status, 'fulfilled');

  assert.equal((await call(ALICE, 'PUT', '/domains/wonder.com/records', { type: 'A', name: '@', values: ['203.0.113.10'] })).status, 200);
  assert.equal((await call(ALICE, 'PUT', '/domains/wonder.com/records', { type: 'TXT', name: '@', values: ['v=spf1 -all'] })).status, 200);
  assert.equal((await call(ALICE, 'PUT', '/domains/wonder.com/records', { type: 'CNAME', name: '@', values: ['x.example.net'] })).status, 400);
  assert.equal((await call(ALICE, 'PUT', '/domains/wonder.com/records', { type: 'A', name: '@', values: ['203.0.113.20'] })).status, 200, 'replaces the set');
  assert.equal(called('PUT domains/zones')[0][2].recordName, '@');
  const detail = await call(ALICE, 'GET', '/domains/wonder.com');
  assert.deepEqual(detail.body.records.map((record) => [record.type, record.label, record.values.join()]), [['TXT', '@', 'v=spf1 -all'], ['A', '@', '203.0.113.20']]);
  assert.equal(detail.body.domain.lyrcloudDns, true);
  assert.deepEqual(detail.body.verification, { pending: true, email: 'alice@example.com', deadline: '2026-11-20T07:00:00.000Z', expired: false });
  assert.equal((await call(ALICE, 'DELETE', '/domains/wonder.com/records', undefined, { type: 'A', name: '@' })).status, 200);
  assert.equal(dnaZone.some((set) => set.type === 'A'), false);

  assert.equal((await call(ALICE, 'POST', '/domains/wonder.com/verify-email')).body.sent, true);
  assert.equal(called('POST contacts/verification/request')[0][1].handleCode, 'D-100');
  registrarState.verified = true;
  assert.deepEqual((await call(ALICE, 'GET', '/domains/wonder.com')).body.verification, { pending: false });

  assert.equal((await call(BOB, 'GET', '/domains/wonder.com')).status, 404, 'other people can’t see it');
  assert.equal((await call(BOB, 'PUT', '/domains/wonder.com/records', { type: 'A', name: '@', values: ['203.0.113.66'] })).status, 404);
  assert.equal((await call(BOB, 'POST', '/domains/wonder.com/verify-email')).status, 404);
  assert.equal((await call(SUPER, 'GET', '/domains/wonder.com')).body.owner, ALICE.email, 'staff can');
});

test('a registration the registry deletes after payment is refunded by the scheduled run', async () => {
  await connectStripe();
  registrarState.status = 'WaitingForRegistration';
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  registrarState.held['wonder.com'].status = 'Deleted';
  await tick();
  assert.equal(domainItem('wonder.com').status, 'failed');
  assert.equal(stripeCalls.filter((item) => item.path === '/refunds').length, 1);
});

async function activeDomain(daysLeft) {
  await connectStripe();
  registrarState.expiresAt = new Date(Date.now() + daysLeft * 86_400_000).toISOString();
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  assert.equal(domainItem('wonder.com').status, 'active');
}

test('auto-renew charges the saved card before expiry, then renews at the registrar', async () => {
  await activeDomain(10);
  registrarState.expiresAt = new Date(Date.now() + 375 * 86_400_000).toISOString();
  await tick();
  const charge = stripeCalls.find((item) => item.path === '/payment_intents' && item.method === 'POST');
  assert.equal(charge.params.amount, '1616');
  assert.equal(charge.params.off_session, 'true');
  assert.equal(charge.params.payment_method, 'pm_card');
  assert.equal(called('POST domains/renew/check').length, 1, 'checked first');
  const renewals = called('POST domains/renew');
  assert.equal(renewals.length, 1);
  assert.deepEqual([renewals[0][1].period, renewals[0][3]], [1, 'test']);
  assert.equal(domainItem('wonder.com').renewing, false, 'DNA renews in the call');
  assert.equal(domainItem('wonder.com').expiresAt.slice(0, 10), registrarState.expiresAt.slice(0, 10));
  await tick();
  assert.equal(stripeCalls.filter((item) => item.path === '/payment_intents' && item.method === 'POST').length, 1, 'charged once');
});

test('a renewal the registry blocks is refunded', async () => {
  await activeDomain(10);
  registrarState.renewLocked = true;
  await tick();
  assert.equal(called('POST domains/renew').length, 0);
  assert.equal(stripeCalls.filter((item) => item.path === '/refunds').length, 1);
  assert.match(domainItem('wonder.com').lastRenewalError, /blocked renewals/);
});

test('a declined renewal is reported and never reaches the registrar; auto-renew can be switched off', async () => {
  await activeDomain(10);
  stripeState.decline = true;
  await tick();
  assert.equal(called('POST domains/renew').length, 0);
  assert.match(domainItem('wonder.com').lastRenewalError, /declined/);
  const res = await call(ALICE, 'PUT', '/domains/wonder.com', { autoRenew: false });
  assert.equal(res.body.domain.autoRenew, false);
  assert.equal((await call(BOB, 'PUT', '/domains/wonder.com', { autoRenew: true })).status, 404);
});

test('domains far from expiry are not charged', async () => {
  await activeDomain(200);
  await tick();
  assert.equal(stripeCalls.filter((item) => item.path === '/payment_intents' && item.method === 'POST').length, 0);
});

test('transfers check the EPP code first, wait for approval and keep the current DNS', async () => {
  await connectStripe();
  const bad = await call(ALICE, 'POST', '/domains/checkout', { action: 'transfer', domain: 'taken.com', authCode: 'nope', contact: CONTACT });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /Unlock/);
  const { order, session } = await buy(ALICE, 'taken.com', { action: 'transfer', authCode: 'good-code' });
  assert.equal(order.amountCents, 1616);
  await webhook('checkout.session.completed', session);
  assert.equal(called('POST domains/transfer')[0][1].authCode, 'good-code');
  assert.equal(domainsTable().get(`order#${order.orderId}|order`).authCode, undefined, 'the EPP code is not kept');
  assert.equal(domainItem('taken.com').status, 'transferring');
  await tick();
  assert.match(domainItem('taken.com').operationMessage, /Completes by 2026-11-10/);
  registrarState.transferStatus = 'serverApproved';
  registrarState.held['taken.com'].status = 'Active';
  await tick();
  assert.equal(domainItem('taken.com').status, 'active');
  assert.equal(domainItem('taken.com').dnsProvider, undefined);
  const listed = (await call(ALICE, 'GET', '/domains')).body.domains[0];
  assert.equal(listed.lyrcloudDns, false);
  assert.equal(listed.renewPrice, 1616);
});

test('a transfer the current owner rejects is refunded', async () => {
  await connectStripe();
  const { session } = await buy(ALICE, 'taken.com', { action: 'transfer', authCode: 'good-code' });
  await webhook('checkout.session.completed', session);
  registrarState.transferStatus = 'clientRejected';
  await tick();
  assert.equal(domainItem('taken.com').status, 'failed');
  assert.match(domainItem('taken.com').failureReason, /rejected/);
});

test('manual renewal goes through Checkout and renews after payment', async () => {
  await activeDomain(200);
  assert.equal((await call(ALICE, 'POST', '/domains/checkout', { action: 'renew', domain: 'wonder.com', years: 4 })).status, 400, 'not a renewal term DNA sells');
  const res = await call(ALICE, 'POST', '/domains/checkout', { action: 'renew', domain: 'wonder.com', years: 2 });
  assert.equal(res.status, 200);
  const order = ordersOf().find((item) => item.orderId === res.body.orderId);
  assert.equal(order.amountCents, 3232);
  await webhook('checkout.session.completed', { id: order.sessionId, metadata: { orderId: order.orderId }, payment_status: 'paid', amount_total: 3232, currency: 'usd', payment_intent: 'pi_2', customer: 'cus_1' });
  assert.equal(called('POST domains/renew')[0][1].period, 2);
  assert.equal((await call(BOB, 'POST', '/domains/checkout', { action: 'renew', domain: 'wonder.com' })).status, 404);
});

test('domains bought from Route 53 before the switch keep their DNS but are never charged or renewed automatically', async () => {
  await connectStripe();
  zone.push({ Name: 'old.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '203.0.113.5' }] });
  tables.domains.set('domain#old.com|domain', {
    pk: 'domain#old.com', sk: 'domain', kind: 'domain', domain: 'old.com', tld: 'com', ownerId: ALICE.userId, status: 'active', action: 'register',
    autoRenew: true, hostedZoneId: 'Z123', expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), stripeCustomerId: 'cus_1', paymentMethodId: 'pm_card', createdAt: '2026-11-01T00:00:00Z',
  });
  await tick();
  assert.equal(stripeCalls.filter((item) => item.path === '/payment_intents' && item.method === 'POST').length, 0);
  assert.equal(registrarCalls.length, 0);
  assert.match((await call(ALICE, 'POST', '/domains/checkout', { action: 'renew', domain: 'old.com' })).body.error, /previous registrar/);
  const detail = await call(ALICE, 'GET', '/domains/old.com');
  assert.equal(detail.body.domain.lyrcloudDns, true);
  assert.deepEqual(detail.body.records.map((record) => record.values[0]), ['203.0.113.5']);
});

test('pricing is the super admin’s to change; admins see it and the sales totals', async () => {
  tables.users.get(BOB.userId).role = 'admin';
  assert.equal((await call(BOB, 'PUT', '/admin/domain-pricing', { percent: 50 })).status, 403);
  assert.equal((await call(ALICE, 'GET', '/admin/domain-pricing')).status, 403);
  assert.equal((await call(SUPER, 'PUT', '/admin/domain-pricing', { percent: -5 })).status, 400);
  const saved = await call(SUPER, 'PUT', '/admin/domain-pricing', { percent: 0, flatCents: 200, dnsCentsPerYear: 0, round99: false, tlds: ['com', 'ninja'] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.tlds.map((item) => [item.tld, item.register]), [['com', 1800], ['ninja', 3200]]);
  const view = await call(BOB, 'GET', '/admin/domain-pricing');
  assert.equal(view.body.stripe.connected, false);
  assert.equal(view.body.config.flatCents, 200);

  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  const admin = await call(BOB, 'GET', '/admin/domains');
  assert.equal(admin.body.domains[0].ownerEmail, ALICE.email);
  assert.equal(admin.body.totals.revenue, 1800);
  assert.equal(admin.body.totals.cost, 1600);
});

// ---------------------------------------------------------------- .lyr

function doh(wire, method = 'POST') {
  return handler({
    requestContext: { http: { method, path: '/dns-query' } },
    headers: method === 'POST' ? { 'content-type': 'application/dns-message' } : {},
    queryStringParameters: method === 'GET' ? { dns: wire.toString('base64url') } : undefined,
    body: method === 'POST' ? wire.toString('base64') : undefined,
    isBase64Encoded: method === 'POST',
  });
}
const dohAnswer = async (name, type, method) => {
  const res = await doh(wireQuery(name, type), method);
  assert.equal(res.headers['content-type'], 'application/dns-message');
  return readResponse(Buffer.from(res.body, 'base64'));
};

test('the super admin creates .lyr names; nobody else can', async () => {
  const records = [{ type: 'A', name: '@', values: ['203.0.113.10'] }, { type: 'CNAME', name: 'www', values: ['target.example.net'] }];
  tables.users.get(BOB.userId).role = 'admin';
  assert.equal((await call(BOB, 'PUT', '/admin/lyr/shop', { records })).status, 403);
  assert.equal((await call(ALICE, 'GET', '/admin/lyr')).status, 403);
  assert.equal((await call(SUPER, 'PUT', '/admin/lyr/nic', { records })).status, 400, 'reserved');
  assert.equal((await call(SUPER, 'PUT', '/admin/lyr/a.b', { records })).status, 400);
  assert.equal((await call(SUPER, 'PUT', '/admin/lyr/shop', { records: [{ type: 'A', name: '@', values: ['nope'] }] })).status, 400);
  assert.match((await call(SUPER, 'PUT', '/admin/lyr/shop', { records: [...records, { type: 'TXT', name: 'www', values: ['x'] }] })).body.error, /CNAME/);
  const saved = await call(SUPER, 'PUT', '/admin/lyr/Shop', { records, owner: 'alice@example.com', note: 'First .lyr name' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.name.records.map((r) => r.name), ['shop.lyr', 'www.shop.lyr']);
  const list = await call(BOB, 'GET', '/admin/lyr');
  assert.deepEqual(list.body.names.map((n) => [n.name, n.owner]), [['shop.lyr', 'alice@example.com']]);
  assert.equal((await call(SUPER, 'DELETE', '/admin/lyr/shop')).status, 200);
  assert.equal((await call(BOB, 'GET', '/admin/lyr')).body.names.length, 0);
});

test('the DoH resolver answers .lyr from the registry and forwards everything else', async () => {
  await call(SUPER, 'PUT', '/admin/lyr/shop', { records: [{ type: 'A', name: '@', values: ['203.0.113.10'] }, { type: 'CNAME', name: 'www', values: ['target.example.net'] }] });
  for (const method of ['POST', 'GET']) {
    const a = await dohAnswer('shop.lyr', 'A', method);
    assert.deepEqual([a.rcode, a.aa, a.answers.map((r) => r.value)], [0, true, ['203.0.113.10']]);
  }
  const www = await dohAnswer('www.shop.lyr', 'A');
  assert.deepEqual(www.answers.map((r) => r.value), ['target.example.net', '198.51.100.7']);
  assert.equal((await dohAnswer('nobody.lyr', 'A')).rcode, 3);
  assert.equal(upstreamQueries.length, 0, '.lyr never leaves Lyrcloud');

  const google = await dohAnswer('www.google.com', 'A');
  assert.equal(google.qr, true);
  assert.equal(upstreamQueries.length, 1);
  assert.equal(upstreamQueries[0].toString('hex'), wireQuery('www.google.com', 'A').toString('hex'), 'other names are forwarded unchanged');

  assert.equal((await handler({ requestContext: { http: { method: 'POST', path: '/dns-query' } }, headers: { 'content-type': 'text/plain' }, body: 'hi' })).statusCode, 415);
  assert.equal((await doh(Buffer.from([1, 2, 3]))).statusCode, 400);
});

test('the public lookup explains what a .lyr name resolves to', async () => {
  await call(SUPER, 'PUT', '/admin/lyr/shop', { records: [{ type: 'TXT', name: '@', values: ['hello'] }] });
  const txt = await call(null, 'GET', '/public/lyr/lookup', undefined, { name: 'shop.lyr', type: 'TXT' });
  assert.deepEqual([txt.body.status, txt.body.answers[0].value], ['NOERROR', 'hello']);
  assert.equal((await call(null, 'GET', '/public/lyr/lookup', undefined, { name: 'nobody' })).body.status, 'NXDOMAIN');
  assert.equal((await call(null, 'GET', '/public/lyr/lookup', undefined, { name: 'google.com' })).status, 400);
});

// ---------------------------------------------------------------- name.lyr.cloud

const subItem = (fqdn) => domainsTable().get(`sub#${fqdn}|sub`);
const setPlan = (person, plan) => { tables.users.get(person.userId).plan = plan; };
const paySubdomain = (order) => webhook('checkout.session.completed', { id: order.sessionId, metadata: { orderId: order.orderId }, payment_status: 'paid', amount_total: order.amountCents, currency: 'usd', payment_intent: 'pi_s', customer: 'cus_1' });

test('Scale and Enterprise accounts claim a name.lyr.cloud for free and point it anywhere', async () => {
  setPlan(ALICE, 'scale');
  const claimed = await call(ALICE, 'POST', '/domains/subdomains', { label: 'Shop' });
  assert.equal(claimed.status, 200);
  assert.deepEqual([claimed.body.subdomain.name, claimed.body.subdomain.free, claimed.body.subdomain.status], ['shop.lyr.cloud', true, 'active']);
  assert.equal((await call(BOB, 'POST', '/domains/subdomains', { label: 'shop' })).status, 409, 'taken');
  assert.equal((await call(ALICE, 'POST', '/domains/subdomains', { label: 'www' })).status, 409, 'reserved');
  assert.equal((await call(ALICE, 'POST', '/domains/subdomains', { label: 'no_way' })).status, 400);

  // A subdomain may be a CNAME (unlike a zone's root), and only its own names are listed and edited.
  assert.equal((await call(ALICE, 'PUT', '/domains/subdomains/shop/records', { type: 'CNAME', name: '@', values: ['myapp.lyrcloud.app'] })).status, 200);
  assert.equal((await call(ALICE, 'PUT', '/domains/subdomains/shop/records', { type: 'TXT', name: 'mail', values: ['v=spf1 -all'] })).status, 200);
  setPlan(BOB, 'enterprise');
  await call(BOB, 'POST', '/domains/subdomains', { label: 'shop2' });
  await call(BOB, 'PUT', '/domains/subdomains/shop2/records', { type: 'A', name: '@', values: ['203.0.113.66'] });
  const detail = await call(ALICE, 'GET', '/domains/subdomains/shop');
  assert.deepEqual(detail.body.records.map((r) => [r.type, r.label]), [['CNAME', '@'], ['TXT', 'mail']]);
  assert.equal((await call(BOB, 'GET', '/domains/subdomains/shop')).status, 404);
  assert.equal((await call(BOB, 'PUT', '/domains/subdomains/shop/records', { type: 'A', name: '@', values: ['203.0.113.66'] })).status, 404);

  const mine = await call(ALICE, 'GET', '/domains');
  assert.deepEqual([mine.body.subdomains.enabled, mine.body.subdomains.freeWithPlan, mine.body.subdomains.items.length], [true, true, 1]);

  // Releasing deletes its records (and nothing else in the zone) and frees the name.
  assert.equal((await call(ALICE, 'DELETE', '/domains/subdomains/shop')).status, 200);
  assert.deepEqual(subZone.map((set) => `${set.Name} ${set.Type}`).sort(), ['lyr.cloud. NS', 'lyr.cloud. SOA', 'shop2.lyr.cloud. A']);
  assert.equal((await call(BOB, 'POST', '/domains/subdomains', { label: 'shop' })).status, 200);
});

test('Launch accounts pay yearly through Checkout; renewals charge the saved card', async () => {
  await connectStripe();
  const res = await call(ALICE, 'POST', '/domains/subdomains', { label: 'cafe' });
  assert.equal(res.status, 200);
  assert.match(res.body.url, /checkout\.stripe\.com/);
  const order = ordersOf().find((item) => item.orderId === res.body.orderId);
  assert.deepEqual([order.action, order.amountCents], ['subdomain', 499]);
  assert.equal(subItem('cafe.lyr.cloud').status, 'awaiting_payment');
  assert.equal((await call(BOB, 'POST', '/domains/subdomains', { label: 'cafe' })).status, 409);
  await paySubdomain(order);
  const item = subItem('cafe.lyr.cloud');
  assert.equal(item.status, 'active');
  assert.ok(Math.abs(Date.parse(item.expiresAt) - Date.now() - 365 * 86_400_000) < 60_000);
  assert.equal(item.paymentMethodId, 'pm_card');

  item.expiresAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const before = Date.parse(item.expiresAt);
  await tick();
  const charge = stripeCalls.find((entry) => entry.path === '/payment_intents' && entry.method === 'POST');
  assert.equal(charge.params.amount, '499');
  assert.ok(Math.abs(Date.parse(subItem('cafe.lyr.cloud').expiresAt) - before - 365 * 86_400_000) < 60_000, 'a year is added on top');
  await tick();
  assert.equal(stripeCalls.filter((entry) => entry.path === '/payment_intents' && entry.method === 'POST').length, 1, 'charged once');
});

test('a declined subdomain renewal is reported, and names past their grace period are released', async () => {
  await connectStripe();
  const res = await call(ALICE, 'POST', '/domains/subdomains', { label: 'cafe' });
  await paySubdomain(ordersOf().find((item) => item.orderId === res.body.orderId));
  await call(ALICE, 'PUT', '/domains/subdomains/cafe/records', { type: 'A', name: '@', values: ['203.0.113.5'] });
  subItem('cafe.lyr.cloud').expiresAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
  stripeState.decline = true;
  await tick();
  assert.match(subItem('cafe.lyr.cloud').lastRenewalError, /declined/);
  subItem('cafe.lyr.cloud').expiresAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  await tick();
  assert.equal(subItem('cafe.lyr.cloud'), undefined);
  assert.equal(subZone.some((set) => set.Name === 'cafe.lyr.cloud.'), false);
});

test('an abandoned subdomain checkout frees the name', async () => {
  await connectStripe();
  const res = await call(ALICE, 'POST', '/domains/subdomains', { label: 'cafe' });
  const order = ordersOf().find((item) => item.orderId === res.body.orderId);
  await webhook('checkout.session.expired', { id: order.sessionId, metadata: { orderId: order.orderId } });
  assert.equal(subItem('cafe.lyr.cloud'), undefined);
});

// ---------------------------------------------------------------- .lyr waitlist

test('anyone signed in can reserve up to three .lyr names for free, first come first served', async () => {
  assert.deepEqual((await call(null, 'GET', '/public/lyr/available', undefined, { name: 'wonder' })).body, { name: 'wonder.lyr', available: true, reason: null });
  assert.equal((await call(ALICE, 'POST', '/domains/lyr-waitlist', { name: 'wonder' })).status, 200);
  assert.equal((await call(ALICE, 'POST', '/domains/lyr-waitlist', { name: 'wonder.lyr' })).status, 200, 'asking again is fine');
  assert.equal((await call(BOB, 'POST', '/domains/lyr-waitlist', { name: 'wonder' })).status, 409);
  assert.equal((await call(null, 'GET', '/public/lyr/available', undefined, { name: 'wonder.lyr' })).body.reason, 'waitlisted');
  assert.equal((await call(ALICE, 'POST', '/domains/lyr-waitlist', { name: 'nic' })).status, 409, 'reserved');
  await call(SUPER, 'PUT', '/admin/lyr/hello', { records: [] });
  assert.equal((await call(ALICE, 'POST', '/domains/lyr-waitlist', { name: 'hello' })).status, 409, 'already in the registry');
  for (const name of ['two', 'three']) assert.equal((await call(ALICE, 'POST', '/domains/lyr-waitlist', { name })).status, 200);
  assert.match((await call(ALICE, 'POST', '/domains/lyr-waitlist', { name: 'four' })).body.error, /up to 3/);

  assert.deepEqual((await call(ALICE, 'GET', '/domains')).body.lyrReservations.map((item) => item.name).sort(), ['three.lyr', 'two.lyr', 'wonder.lyr']);
  const admin = await call(SUPER, 'GET', '/admin/lyr');
  assert.deepEqual(admin.body.reservations.map((item) => item.name).sort(), ['three.lyr', 'two.lyr', 'wonder.lyr']);
  assert.equal(admin.body.reservations[0].ownerEmail, ALICE.email);
  assert.equal((await call(BOB, 'DELETE', '/domains/lyr-waitlist/wonder')).status, 404);
  assert.equal((await call(ALICE, 'DELETE', '/domains/lyr-waitlist/wonder')).status, 200);
  assert.equal((await call(BOB, 'POST', '/domains/lyr-waitlist', { name: 'wonder' })).status, 200);
});
