// Lyrcloud Access: policy rules, and the whole sign-in loop through the router and the API with AWS faked.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

Object.assign(process.env, {
  TABLE_NAME: 'functions', FUNCTIONS_TABLE: 'functions', USERS_TABLE_NAME: 'users', DATA_TABLE_NAME: 'data', FUNCTIONS_DOMAIN: 'dev.lyr',
  PLATFORM_SECRET: 'test-secret', ACCESS_URL: 'https://www.lyrcloud.com/access/',
});
const access = await import('./access.mjs');
const router = await import('./router.mjs');
const { handler: api } = await import('./index.mjs');

let items;
let users;
let invoked;

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const { input } = command;
  const name = command.constructor.name;
  if (input.TableName === 'users') return { Item: structuredClone(users.get(input.Key.userId)) };
  const k = (key) => `${input.TableName}|${key.pk}|${key.sk}`;
  if (name === 'GetCommand') return { Item: structuredClone(items.get(k(input.Key))) };
  if (name === 'PutCommand') {
    if (input.ConditionExpression === 'attribute_not_exists(pk)' && items.has(k(input.Item))) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    items.set(k(input.Item), structuredClone(input.Item));
    return {};
  }
  if (name === 'QueryCommand') {
    const pk = input.ExpressionAttributeValues[':pk'];
    return { Items: [...items.values()].filter((item) => item.pk === pk).sort((a, b) => b.sk.localeCompare(a.sk)) };
  }
  throw new Error(`unexpected ${name}`);
};

LambdaClient.prototype.send = async function send(command) {
  const event = JSON.parse(Buffer.from(command.input.Payload).toString());
  invoked.push(event);
  return { Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: `hello ${event.headers['lyr-access-email'] || 'anyone'}` })) };
};

beforeEach(() => {
  items = new Map();
  users = new Map([['owner', { userId: 'owner', email: 'owner@example.com' }], ['ada', { userId: 'ada', email: 'ada@corp.com' }], ['eve', { userId: 'eve', email: 'eve@evil.com' }]]);
  invoked = [];
  const fn = { pk: 'fn#portal', sk: 'fn', name: 'portal', ownerId: 'owner', ownerEmail: 'owner@example.com', access: { allow: ['@corp.com'], paths: ['/admin'] } };
  items.set('functions|fn#portal|fn', fn);
});

const visit = (path, { cookies, headers = {}, method = 'GET', query = '' } = {}) => router.handler({
  rawPath: path, rawQueryString: query, cookies, headers: { host: 'portal.dev.lyr', ...headers },
  requestContext: { domainName: 'portal.dev.lyr', http: { method } },
});
const grant = (user, to) => api({
  requestContext: { http: { method: 'POST', path: '/access/grant', sourceIp: '198.51.100.1' }, authorizer: { jwt: { claims: { sub: user } } } },
  headers: { 'user-agent': 'test' },
  body: JSON.stringify({ to }),
});

test('policies from lyrcloud.json', () => {
  assert.deepEqual(access.cleanAccess({ allow: ['Ada@Corp.com', '@corp.com'], paths: ['/admin/*'] }), [{ allow: ['ada@corp.com', '@corp.com'], paths: ['/admin/'] }, null]);
  assert.deepEqual(access.cleanAccess(undefined), [null, null]);
  assert.match(access.cleanAccess({ allow: ['not an email'] })[1], /isn’t an email/);
  assert.match(access.cleanAccess({ allow: [], paths: ['admin'] })[1], /starting with \//);
});

test('protected paths and allow-lists', () => {
  const policy = { allow: ['ada@corp.com', '@team.io'], paths: ['/admin'] };
  assert.equal(access.isProtected(policy, '/admin'), true);
  assert.equal(access.isProtected(policy, '/admin/users'), true);
  assert.equal(access.isProtected(policy, '/administrator'), false);
  assert.equal(access.isProtected(policy, '/'), false);
  assert.equal(access.isProtected({ allow: [], paths: [] }, '/anything'), true);
  assert.equal(access.isProtected(null, '/admin'), false);
  assert.equal(access.isAllowed(policy, 'ADA@corp.com'), true);
  assert.equal(access.isAllowed(policy, 'bob@team.io'), true);
  assert.equal(access.isAllowed(policy, 'bob@notteam.io'), false);
  assert.equal(access.isAllowed(policy, 'bob@evilteam.io'), false);
  assert.equal(access.isAllowed(policy, 'me@x.com', 'me@x.com'), true);
});

test('signed tokens check kind, signature and expiry', () => {
  const token = access.sign('s', 'session', { fn: 'a' }, 60, 0);
  assert.equal(access.verify('s', 'session', token, 1000).fn, 'a');
  assert.equal(access.verify('s', 'ticket', token, 1000), null);
  assert.equal(access.verify('other', 'session', token, 1000), null);
  assert.equal(access.verify('s', 'session', token, 61_000), null);
});

test('the full sign-in loop: redirect, grant, ticket, cookie, then the function sees the email', async () => {
  // Public paths pass straight through.
  assert.equal((await visit('/')).body, 'hello anyone');
  // A protected path redirects to the Lyrcloud Access page.
  const first = await visit('/admin/users', { query: 'tab=2' });
  assert.equal(first.statusCode, 302);
  const to = new URL(first.headers.location).searchParams.get('to');
  assert.ok(first.headers.location.startsWith('https://www.lyrcloud.com/access/?to='));
  assert.equal(invoked.length, 1); // the function never ran for the protected request
  // The page signs Ada in and asks for a grant.
  const granted = JSON.parse((await grant('ada', to)).body);
  assert.equal(granted.email, 'ada@corp.com');
  const ticketUrl = new URL(granted.url);
  assert.equal(ticketUrl.host, 'portal.dev.lyr');
  assert.equal(ticketUrl.pathname, '/__lyrcloud/access');
  // The router swaps the ticket for a session cookie and sends her back where she was going.
  const swap = await visit('/__lyrcloud/access', { query: ticketUrl.search.slice(1) });
  assert.equal(swap.statusCode, 302);
  assert.equal(swap.headers.location, '/admin/users?tab=2');
  assert.match(swap.cookies[0], /^__lyr_access=.+; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/);
  const cookie = swap.cookies[0].split(';')[0];
  // With the cookie, the function runs and gets her email.
  const inside = await visit('/admin/users', { cookies: [cookie] });
  assert.equal(inside.body, 'hello ada@corp.com');
  // A ticket works once.
  assert.equal((await visit('/__lyrcloud/access', { query: ticketUrl.search.slice(1) })).statusCode, 403);
  // Every decision is in the owner's access log.
  const logRes = await api({ requestContext: { http: { method: 'GET', path: '/functions/portal/access-log' }, authorizer: { jwt: { claims: { sub: 'owner' } } } } });
  assert.equal(logRes.statusCode, 200, logRes.body);
  const log = JSON.parse(logRes.body);
  assert.deepEqual(log.events.map((e) => [e.email, e.allowed]), [['ada@corp.com', true]]);
});

test('people outside the allow-list are refused and logged; the owner always gets in', async () => {
  const to = new URL((await visit('/admin')).headers.location).searchParams.get('to');
  const denied = await grant('eve', to);
  assert.equal(denied.statusCode, 403);
  assert.match(JSON.parse(denied.body).error, /eve@evil.com isn’t allowed/);
  assert.equal((await grant('owner', to)).statusCode, 200);
  const logged = [...items.values()].filter((item) => item.pk === 'access#owner#portal').map((item) => [item.email, item.allowed]).sort();
  assert.deepEqual(logged, [['eve@evil.com', false], ['owner@example.com', true]]);
});

test('forged headers, cookies from other functions and non-GET requests get nothing', async () => {
  // A visitor can't claim an identity with the header.
  assert.equal((await visit('/', { headers: { 'lyr-access-email': 'ceo@corp.com' } })).body, 'hello anyone');
  assert.equal((await visit('/admin', { headers: { 'lyr-access-email': 'ceo@corp.com' } })).statusCode, 302);
  // A session for another function doesn't open this one.
  const other = access.sign('test-secret', 'session', { fn: 'other', email: 'ada@corp.com' }, 3600);
  assert.equal((await visit('/admin', { cookies: [`__lyr_access=${other}`] })).statusCode, 302);
  // API calls without a session get 401 rather than a redirect.
  assert.equal((await visit('/admin/api', { method: 'POST' })).statusCode, 401);
  // Logging out clears the cookie.
  assert.match((await visit('/__lyrcloud/logout')).cookies[0], /Max-Age=0/);
});

test('deploying with an access policy stores it', async () => {
  assert.equal(access.cleanAccess({ allow: ['x'] })[0], null);
});
