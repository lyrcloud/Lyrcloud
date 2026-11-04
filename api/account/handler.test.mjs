// Account API handler with DynamoDB, Cognito and the userInfo endpoint replaced by in-memory fakes.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

process.env.TABLE_NAME = 'users';
process.env.USER_POOL_ID = 'pool';
const { handler } = await import('./index.mjs');

const SUPER = { sub: 'sub-super', username: 'googleoidc_1', email: 'lyrclouds@gmail.com' };
const ADMIN = { sub: 'sub-admin', username: 'GoogleOIDC_2', email: 'admin@example.com' };
const USER = { sub: 'sub-user', username: 'GitHubBridge_3', email: 'user@example.com' };
const PEOPLE = Object.fromEntries([SUPER, ADMIN, USER].map((person) => [`token-${person.sub}`, person]));

let table;
let cognitoCalls;

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const input = command.input;
  if (name === 'GetCommand') return { Item: table.get(input.Key.userId) && structuredClone(table.get(input.Key.userId)) };
  if (name === 'PutCommand') return table.set(input.Item.userId, structuredClone(input.Item)), {};
  if (name === 'DeleteCommand') return table.delete(input.Key.userId), {};
  if (name === 'ScanCommand') return { Items: [...table.values()].map((item) => structuredClone(item)) };
  if (name === 'UpdateCommand') {
    const item = table.get(input.Key.userId);
    for (const part of input.UpdateExpression.replace(/^SET /, '').split(', ')) {
      const [field, value] = part.split(' = ');
      item[input.ExpressionAttributeNames?.[field] || field] = input.ExpressionAttributeValues[value];
    }
    return { Attributes: structuredClone(item) };
  }
  throw new Error(`unexpected ${name}`);
};
CognitoIdentityProviderClient.prototype.send = async function send(command) {
  cognitoCalls.push([command.constructor.name, command.input.Username]);
  return {};
};
globalThis.fetch = async (url, { headers }) => {
  const person = PEOPLE[headers.authorization.replace('Bearer ', '')];
  return new Response(JSON.stringify({ email: person.email, username: person.username }), { status: 200 });
};

function call(person, method, path, body) {
  return handler({
    requestContext: { http: { method, path }, authorizer: { jwt: { claims: { sub: person.sub, username: person.username } } } },
    headers: { authorization: `Bearer token-${person.sub}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((response) => ({ status: response.statusCode, body: JSON.parse(response.body) }));
}

beforeEach(async () => {
  table = new Map();
  cognitoCalls = [];
  for (const person of [SUPER, ADMIN, USER]) await call(person, 'GET', '/me');
  table.get(ADMIN.sub).role = 'admin';
});

test('/me reports the super admin, the plan and the announcement', async () => {
  const me = await call(SUPER, 'GET', '/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'superadmin');
  assert.equal(me.body.provider, 'GoogleOIDC');
  assert.equal(me.body.plan, 'launch');
  assert.equal(me.body.announcement, '');
});

test('anyone can change their own plan, and it sticks', async () => {
  assert.equal((await call(USER, 'PUT', '/me', { plan: 'scale' })).body.plan, 'scale');
  assert.equal((await call(USER, 'GET', '/me')).body.plan, 'scale');
  assert.equal((await call(USER, 'PUT', '/me', { plan: 'gold' })).status, 400);
});

test('the super admin manages every account except their own', async () => {
  let res = await call(SUPER, 'PUT', `/admin/users/${ADMIN.sub}`, { plan: 'enterprise', role: 'user' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.plan, 'enterprise');
  assert.equal(res.body.user.role, 'user');
  res = await call(SUPER, 'PUT', `/admin/users/${SUPER.sub}`, { plan: 'scale' });
  assert.equal(res.status, 400);
});

test('admins manage users but not admins, roles or deletions', async () => {
  assert.equal((await call(ADMIN, 'PUT', `/admin/users/${USER.sub}`, { plan: 'scale' })).status, 200);
  assert.equal((await call(ADMIN, 'PUT', `/admin/users/${USER.sub}`, { role: 'admin' })).status, 403);
  assert.equal((await call(ADMIN, 'DELETE', `/admin/users/${USER.sub}`)).status, 403);
  assert.equal((await call(ADMIN, 'PUT', '/admin/settings', { announcement: 'hi' })).status, 403);
  assert.equal((await call(USER, 'GET', '/admin/users')).status, 403);
});

test('disabling blocks the account in Cognito and in the API, enabling restores it', async () => {
  const res = await call(SUPER, 'PUT', `/admin/users/${USER.sub}`, { disabled: true });
  assert.equal(res.body.user.disabled, true);
  assert.deepEqual(cognitoCalls, [['AdminDisableUserCommand', USER.username], ['AdminUserGlobalSignOutCommand', USER.username]]);
  assert.equal((await call(USER, 'GET', '/me')).status, 403);
  await call(SUPER, 'PUT', `/admin/users/${USER.sub}`, { disabled: false });
  assert.equal((await call(USER, 'GET', '/me')).status, 200);
});

test('an admin-set name survives the next sign-in', async () => {
  await call(SUPER, 'PUT', `/admin/users/${USER.sub}`, { name: 'Renamed' });
  await call(USER, 'GET', '/me');
  assert.equal(table.get(USER.sub).name, 'Renamed');
});

test('sign out everywhere and delete', async () => {
  assert.equal((await call(ADMIN, 'POST', `/admin/users/${USER.sub}/sign-out`)).body.signedOut, true);
  assert.equal((await call(ADMIN, 'POST', `/admin/users/${SUPER.sub}/sign-out`)).status, 403);
  assert.equal((await call(SUPER, 'DELETE', `/admin/users/${USER.sub}`)).status, 200);
  assert.equal(table.has(USER.sub), false);
  assert.deepEqual(cognitoCalls.at(-1), ['AdminDeleteUserCommand', USER.username]);
  assert.equal((await call(SUPER, 'DELETE', `/admin/users/${SUPER.sub}`)).status, 400);
});

test('the announcement is set by the super admin, shown to everyone, and hidden from the user list', async () => {
  assert.equal((await call(SUPER, 'PUT', '/admin/settings', { announcement: '  Maintenance tonight  ' })).body.announcement, 'Maintenance tonight');
  assert.equal((await call(USER, 'GET', '/me')).body.announcement, 'Maintenance tonight');
  const { body } = await call(ADMIN, 'GET', '/admin/users');
  assert.equal(body.users.length, 3);
});
