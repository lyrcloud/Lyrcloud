// Domains API end to end, with DynamoDB, Route 53, Secrets Manager and Stripe replaced by in-memory fakes.
// The DynamoDB fake evaluates the condition expressions the API uses, so holds and claims are tested for real.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { Route53DomainsClient } from '@aws-sdk/client-route-53-domains';
import { Route53Client } from '@aws-sdk/client-route-53';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readResponse, wireQuery } from './dns-test-helpers.mjs';

process.env.TABLE_NAME = 'domains';
process.env.USERS_TABLE_NAME = 'users';
process.env.STRIPE_SECRET_NAME = 'stripe';
process.env.ALLOW_TEST_REGISTRATIONS = '1';
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

let registrarCalls;
let registrarState;
Route53DomainsClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const input = command.input;
  registrarCalls.push([name, input]);
  switch (name) {
    case 'ListPricesCommand':
      return {
        Prices: [
          { Name: 'com', RegistrationPrice: { Price: 16 }, RenewalPrice: { Price: 16 }, TransferPrice: { Price: 16 } },
          { Name: 'io', RegistrationPrice: { Price: 71 }, RenewalPrice: { Price: 71 }, TransferPrice: { Price: 71 } },
          { Name: 'net', RegistrationPrice: { Price: 17 }, RenewalPrice: { Price: 17 }, TransferPrice: { Price: 17 } },
          { Name: 'ninja', RegistrationPrice: { Price: 30 }, RenewalPrice: { Price: 30 }, TransferPrice: { Price: 30 } },
        ],
      };
    case 'CheckDomainAvailabilityCommand':
      return { Availability: registrarState.taken.includes(input.DomainName) ? 'UNAVAILABLE' : 'AVAILABLE' };
    case 'GetDomainSuggestionsCommand':
      return { SuggestionsList: [{ DomainName: 'getwonder.com', Availability: 'AVAILABLE' }, { DomainName: 'wonder.ninja', Availability: 'AVAILABLE' }] };
    case 'CheckDomainTransferabilityCommand':
      return { Transferability: { Transferable: input.AuthCode === 'good-code' ? 'TRANSFERABLE' : 'UNTRANSFERABLE' } };
    case 'RegisterDomainCommand':
    case 'TransferDomainCommand':
    case 'RenewDomainCommand':
      if (registrarState.refuse) throw Object.assign(new Error('The registry refused this name.'), { name: 'InvalidInput' });
      return { OperationId: `op-${registrarCalls.length}` };
    case 'GetOperationDetailCommand':
      return { Status: registrarState.operation, Message: registrarState.operation === 'FAILED' ? 'Registry said no' : undefined };
    case 'GetDomainDetailCommand':
      return { ExpirationDate: new Date(registrarState.expiresAt), Nameservers: [{ Name: 'ns-1.awsdns-01.org' }, { Name: 'ns-2.awsdns-02.com' }] };
    default:
      throw new Error(`unexpected ${name}`);
  }
};

let dnsCalls;
let zone;
Route53Client.prototype.send = async function send(command) {
  const name = command.constructor.name;
  dnsCalls.push([name, command.input]);
  if (name === 'ListHostedZonesByNameCommand') return { HostedZones: [{ Id: '/hostedzone/Z123', Name: `${command.input.DNSName}.`, Config: { PrivateZone: false } }] };
  if (name === 'ListResourceRecordSetsCommand') return { ResourceRecordSets: structuredClone(zone), IsTruncated: false };
  if (name === 'ChangeResourceRecordSetsCommand') {
    for (const change of command.input.ChangeBatch.Changes) {
      const set = { ...change.ResourceRecordSet, Name: change.ResourceRecordSet.Name.replace(/\.?$/, '.') };
      zone = zone.filter((item) => !(item.Name === set.Name && item.Type === set.Type));
      if (change.Action === 'UPSERT') zone.push(set);
    }
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

async function connectStripe() {
  return call(SUPER, 'PUT', '/admin/stripe', { secretKey: 'sk_test_1234567890abcdef' });
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
  registrarState = { taken: ['taken.com'], refuse: false, operation: 'IN_PROGRESS', expiresAt: '2027-11-04T00:00:00Z' };
  dnsCalls = [];
  zone = [{ Name: 'wonder.com.', Type: 'NS', TTL: 172800, ResourceRecords: [{ Value: 'ns-1.awsdns-01.org.' }] }];
  stripeCalls = [];
  stripeState = { decline: false };
  upstreamQueries = [];
});

// ---------------------------------------------------------------- tests

test('the public price list adds DNS hosting and the commission, rounded to .99', async () => {
  const { status, body } = await call(null, 'GET', '/public/domains/prices');
  assert.equal(status, 200);
  const com = body.tlds.find((item) => item.tld === 'com');
  // ($16 + $6 DNS) * 1.10 = $24.20 -> $24.99; transfers skip DNS: $16 * 1.10 = $17.60 -> $17.99.
  assert.deepEqual([com.register, com.renew, com.transfer], [2499, 2499, 1799]);
  assert.equal(body.tlds.some((item) => item.tld === 'ninja'), false, 'TLDs that are not enabled are not sold');
});

test('search reports availability, prices, unsold TLDs and suggestions', async () => {
  const { body } = await call(null, 'GET', '/public/domains/search', undefined, { q: 'Taken.com' });
  assert.equal(body.query, 'taken');
  assert.deepEqual(body.results.map((item) => [item.domain, item.available]), [['taken.com', false], ['taken.net', true], ['taken.org', false], ['taken.io', true]].filter(([d]) => d !== 'taken.org'));
  assert.equal(body.results.find((item) => item.domain === 'taken.net').price, 2599);
  assert.deepEqual(body.suggestions.map((item) => item.domain), ['getwonder.com']);
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
  assert.equal(order.amountCents, 4998);
  const session = stripeCalls.find((item) => item.path === '/checkout/sessions').params;
  assert.equal(session['line_items[0][price_data][unit_amount]'], '4998');
  assert.equal(session['payment_intent_data[setup_future_usage]'], 'off_session');
  assert.equal(session.success_url, 'https://www.lyrcloud.com/dash/#/domains/wonder.com?paid=1');
  assert.equal(domainItem('wonder.com').status, 'awaiting_payment');

  const bob = await call(BOB, 'POST', '/domains/checkout', { action: 'register', domain: 'wonder.com', contact: CONTACT });
  assert.equal(bob.status, 409);
  assert.equal((await call(ALICE, 'POST', '/domains/checkout', { action: 'register', domain: 'wonder.com', contact: CONTACT })).status, 200, 'the holder can start again');
  assert.equal((await call(ALICE, 'POST', '/domains/checkout', { action: 'register', domain: 'taken.com', contact: CONTACT })).status, 409);
  assert.equal((await call(ALICE, 'GET', '/domains')).body.contact.city, 'Oxford', 'the contact is saved for next time');

  // A hold nobody paid for can be taken over.
  domainsTable().get('domain#wonder.com|domain').holdUntil = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call(BOB, 'POST', '/domains/checkout', { action: 'register', domain: 'wonder.com', contact: CONTACT })).status, 200);
});

test('a paid checkout registers the domain once, and a forged webhook does nothing', async () => {
  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  assert.equal((await webhook('checkout.session.completed', session, 'whsec_wrong')).status, 400);
  assert.equal(called('RegisterDomainCommand').length, 0);

  assert.equal((await webhook('checkout.session.completed', session)).status, 200);
  await webhook('checkout.session.completed', session); // Stripe retries
  const registrations = called('RegisterDomainCommand');
  assert.equal(registrations.length, 1);
  const input = registrations[0][1];
  assert.equal(input.DomainName, 'wonder.com');
  assert.equal(input.AutoRenew, false);
  assert.equal(input.PrivacyProtectRegistrantContact, true);
  assert.equal(input.RegistrantContact.PhoneNumber, '+1.6615550100');
  assert.equal(domainItem('wonder.com').status, 'registering');
  assert.equal(domainItem('wonder.com').paymentMethodId, 'pm_card');
});

test('in Stripe test mode a paid order is refunded instead of buying a real domain', async () => {
  process.env.ALLOW_TEST_REGISTRATIONS = '0';
  try {
    await connectStripe();
    const { session, order } = await buy(ALICE, 'wonder.com');
    await webhook('checkout.session.completed', session);
    assert.equal(called('RegisterDomainCommand').length, 0);
    assert.equal(domainsTable().get(`order#${order.orderId}|order`).status, 'refunded');
    assert.equal(domainItem('wonder.com').failureReason, TEST_MODE_REASON);
  } finally {
    process.env.ALLOW_TEST_REGISTRATIONS = '1';
  }
});

test('a tampered amount is never fulfilled', async () => {
  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', { ...session, amount_total: 100 });
  assert.equal(called('RegisterDomainCommand').length, 0);
});

test('when the registrar refuses, the payment is refunded and the name is free again', async () => {
  await connectStripe();
  registrarState.refuse = true;
  const { session, order } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  assert.equal(stripeCalls.filter((item) => item.path === '/refunds').length, 1);
  assert.equal(domainsTable().get(`order#${order.orderId}|order`).status, 'refunded');
  assert.equal(domainItem('wonder.com').status, 'failed');
  registrarState.refuse = false;
  assert.equal((await call(BOB, 'POST', '/domains/checkout', { action: 'register', domain: 'wonder.com', contact: CONTACT })).status, 200);
});

test('an abandoned checkout releases the hold', async () => {
  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.expired', session);
  assert.equal(domainItem('wonder.com'), undefined);
});

test('the scheduled run activates the domain with Lyrcloud DNS, and records can be edited', async () => {
  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  await tick();
  assert.equal(domainItem('wonder.com').status, 'registering');
  registrarState.operation = 'SUCCESSFUL';
  await tick();
  const item = domainItem('wonder.com');
  assert.equal(item.status, 'active');
  assert.equal(item.hostedZoneId, 'Z123');
  assert.equal(item.expiresAt, '2027-11-04T00:00:00.000Z');
  assert.equal(ordersOf()[0].status, 'fulfilled');

  assert.equal((await call(ALICE, 'PUT', '/domains/wonder.com/records', { type: 'A', name: '@', values: ['203.0.113.10'] })).status, 200);
  assert.equal((await call(ALICE, 'PUT', '/domains/wonder.com/records', { type: 'TXT', name: '@', values: ['v=spf1 -all'] })).status, 200);
  assert.equal((await call(ALICE, 'PUT', '/domains/wonder.com/records', { type: 'CNAME', name: '@', values: ['x.example.net'] })).status, 400);
  const detail = await call(ALICE, 'GET', '/domains/wonder.com');
  assert.deepEqual(detail.body.records.map((record) => [record.type, record.label, record.values[0]]), [['A', '@', '203.0.113.10'], ['TXT', '@', 'v=spf1 -all']]);
  assert.equal(detail.body.domain.lyrcloudDns, true);
  assert.equal((await call(ALICE, 'DELETE', '/domains/wonder.com/records', undefined, { type: 'A', name: '@' })).status, 200);
  assert.equal(zone.some((set) => set.Type === 'A'), false);

  assert.equal((await call(BOB, 'GET', '/domains/wonder.com')).status, 404, 'other people can’t see it');
  assert.equal((await call(BOB, 'PUT', '/domains/wonder.com/records', { type: 'A', name: '@', values: ['203.0.113.66'] })).status, 404);
  assert.equal((await call(SUPER, 'GET', '/domains/wonder.com')).body.owner, ALICE.email, 'staff can');
});

test('a registrar failure after payment is refunded by the scheduled run', async () => {
  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  registrarState.operation = 'FAILED';
  await tick();
  assert.equal(domainItem('wonder.com').status, 'failed');
  assert.equal(stripeCalls.filter((item) => item.path === '/refunds').length, 1);
});

async function activeDomain(daysLeft) {
  await connectStripe();
  const { session } = await buy(ALICE, 'wonder.com');
  await webhook('checkout.session.completed', session);
  registrarState.operation = 'SUCCESSFUL';
  registrarState.expiresAt = new Date(Date.now() + daysLeft * 86_400_000).toISOString();
  await tick();
  assert.equal(domainItem('wonder.com').status, 'active');
}

test('auto-renew charges the saved card before expiry, then renews at the registrar', async () => {
  await activeDomain(10);
  registrarState.operation = 'IN_PROGRESS';
  await tick();
  const charge = stripeCalls.find((item) => item.path === '/payment_intents' && item.method === 'POST');
  assert.equal(charge.params.amount, '2499');
  assert.equal(charge.params.off_session, 'true');
  assert.equal(charge.params.payment_method, 'pm_card');
  assert.equal(called('RenewDomainCommand').length, 1);
  assert.equal(called('RenewDomainCommand')[0][1].CurrentExpiryYear, new Date(registrarState.expiresAt).getUTCFullYear());
  assert.equal(domainItem('wonder.com').renewing, true);
  await tick();
  assert.equal(stripeCalls.filter((item) => item.path === '/payment_intents' && item.method === 'POST').length, 1, 'charged once');
  registrarState.operation = 'SUCCESSFUL';
  await tick();
  assert.equal(domainItem('wonder.com').renewing, false);
});

test('a declined renewal is reported and never reaches the registrar; auto-renew can be switched off', async () => {
  await activeDomain(10);
  stripeState.decline = true;
  await tick();
  assert.equal(called('RenewDomainCommand').length, 0);
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

test('transfers check the EPP code first and keep the current DNS', async () => {
  await connectStripe();
  const bad = await call(ALICE, 'POST', '/domains/checkout', { action: 'transfer', domain: 'taken.com', authCode: 'nope', contact: CONTACT });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /Unlock/);
  const { order, session } = await buy(ALICE, 'taken.com', { action: 'transfer', authCode: 'good-code' });
  assert.equal(order.amountCents, 1799);
  await webhook('checkout.session.completed', session);
  assert.equal(called('TransferDomainCommand')[0][1].AuthCode, 'good-code');
  assert.equal(domainsTable().get(`order#${order.orderId}|order`).authCode, undefined, 'the EPP code is not kept');
  registrarState.operation = 'SUCCESSFUL';
  await tick();
  assert.equal(domainItem('taken.com').status, 'active');
  assert.equal(domainItem('taken.com').hostedZoneId, undefined);
  assert.equal((await call(ALICE, 'GET', '/domains')).body.domains[0].renewPrice, 1799, 'renewals without Lyrcloud DNS skip the DNS cost');
});

test('manual renewal goes through Checkout and renews after payment', async () => {
  await activeDomain(200);
  const res = await call(ALICE, 'POST', '/domains/checkout', { action: 'renew', domain: 'wonder.com', years: 2 });
  assert.equal(res.status, 200);
  const order = ordersOf().find((item) => item.orderId === res.body.orderId);
  assert.equal(order.amountCents, 4998);
  await webhook('checkout.session.completed', { id: order.sessionId, metadata: { orderId: order.orderId }, payment_status: 'paid', amount_total: 4998, currency: 'usd', payment_intent: 'pi_2', customer: 'cus_1' });
  assert.equal(called('RenewDomainCommand')[0][1].DurationInYears, 2);
  assert.equal((await call(BOB, 'POST', '/domains/checkout', { action: 'renew', domain: 'wonder.com' })).status, 404);
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
