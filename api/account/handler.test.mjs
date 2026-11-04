// Account API handler with DynamoDB, Cognito, SES, SNS and the userInfo endpoint replaced by in-memory fakes.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SNSClient } from '@aws-sdk/client-sns';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

process.env.TABLE_NAME = 'users';
process.env.RATE_TABLE_NAME = 'rates';
process.env.USER_POOL_ID = 'pool';
process.env.MAIL_FROM = 'Lyrcloud <no-reply@lyrcloud.com>';
process.env.APP_SECRET = 'test-secret';
const { handler } = await import('./index.mjs');

const SUPER = { sub: 'sub-super', username: 'googleoidc_1', email: 'lyrclouds@gmail.com' };
const ADMIN = { sub: 'sub-admin', username: 'GoogleOIDC_2', email: 'admin@example.com' };
const USER = { sub: 'sub-user', username: 'GitHubBridge_3', email: 'user@example.com' };
// An email-and-password account: its token has no openid scope, so userInfo refuses it.
const EMAIL_USER = { sub: 'sub-email', username: 'lyrclouds@gmail.com', email: 'lyrclouds@gmail.com', email_verified: 'false', passwordAccount: true };
const PEOPLE = Object.fromEntries([SUPER, ADMIN, USER, EMAIL_USER].map((person) => [`token-${person.sub}`, person]));

let table;
let rates;
let cognitoCalls;
let emails;
let texts;

// Applies a DynamoDB UpdateExpression made of SET, REMOVE and ADD clauses to `item`.
function applyUpdate(item, input) {
  const name = (token) => input.ExpressionAttributeNames?.[token] || token;
  const value = (token) => input.ExpressionAttributeValues[token];
  for (const [, clause, body] of input.UpdateExpression.matchAll(/(SET|REMOVE|ADD) (.*?)(?= (?:SET|REMOVE|ADD) |$)/g)) {
    for (const part of body.split(', ')) {
      if (clause === 'SET') {
        const [field, token] = part.split(' = ');
        item[name(field)] = value(token);
      } else if (clause === 'REMOVE') delete item[name(part)];
      else {
        const [field, token] = part.split(' ');
        item[name(field)] = (item[name(field)] || 0) + value(token);
      }
    }
  }
}

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const input = command.input;
  if (name === 'GetCommand') return { Item: table.get(input.Key.userId) && structuredClone(table.get(input.Key.userId)) };
  if (name === 'PutCommand') return table.set(input.Item.userId, structuredClone(input.Item)), {};
  if (name === 'DeleteCommand') return table.delete(input.Key.userId), {};
  if (name === 'ScanCommand') return { Items: [...table.values()].map((item) => structuredClone(item)) };
  if (name === 'UpdateCommand' && input.TableName === 'rates') {
    const key = `${input.Key.key}|${input.Key.period}`;
    const item = rates.get(key) || {};
    applyUpdate(item, input);
    rates.set(key, item);
    return { Attributes: structuredClone(item) };
  }
  if (name === 'UpdateCommand') {
    const item = table.get(input.Key.userId);
    applyUpdate(item, input);
    return { Attributes: structuredClone(item) };
  }
  throw new Error(`unexpected ${name}`);
};
CognitoIdentityProviderClient.prototype.send = async function send(command) {
  cognitoCalls.push([command.constructor.name, command.input.Username]);
  if (command.constructor.name === 'AdminGetUserCommand') {
    const person = Object.values(PEOPLE).find((item) => item.username === command.input.Username);
    const attributes = { sub: person.sub, email: person.email, email_verified: person.email_verified };
    return { Username: person.username, UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })) };
  }
  return {};
};
SESv2Client.prototype.send = async function send(command) {
  const { Destination, Content } = command.input;
  emails.push({ to: Destination.ToAddresses[0], subject: Content.Simple.Subject.Data, text: Content.Simple.Body.Text.Data });
  return {};
};
SNSClient.prototype.send = async function send(command) {
  texts.push({ to: command.input.PhoneNumber, code: command.input.Message.slice(0, 6) });
  return {};
};
globalThis.fetch = async (url, { headers }) => {
  const person = PEOPLE[headers.authorization.replace('Bearer ', '')];
  if (person.passwordAccount) return new Response('{"error":"invalid_token"}', { status: 401 });
  return new Response(JSON.stringify({ email: person.email, username: person.username }), { status: 200 });
};

function call(person, method, path, body) {
  return handler({
    requestContext: { http: { method, path }, domainName: 'api.example.com', authorizer: { jwt: { claims: { sub: person.sub, username: person.username } } } },
    headers: { authorization: `Bearer token-${person.sub}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((response) => ({ status: response.statusCode, body: JSON.parse(response.body) }));
}

beforeEach(async () => {
  table = new Map();
  rates = new Map();
  emails = [];
  texts = [];
  cognitoCalls = [];
  for (const person of [SUPER, ADMIN, USER]) await call(person, 'GET', '/me');
  table.get(ADMIN.sub).role = 'admin';
  cognitoCalls = [];
});

const publicCall = (method, path, query) =>
  handler({ requestContext: { http: { method, path }, domainName: 'api.example.com' }, queryStringParameters: query, headers: {} });

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

test('anyone can set their own name and photo, and they survive the next sign-in', async () => {
  const photo = `data:image/jpeg;base64,${'A'.repeat(400)}`;
  let res = await call(USER, 'PUT', '/me', { name: '  Ada Lovelace ', avatar: photo });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Ada Lovelace');
  assert.equal(res.body.avatar, photo);
  assert.equal(res.body.avatarSource, 'upload');
  res = await call(USER, 'GET', '/me');
  assert.equal(res.body.name, 'Ada Lovelace');
  assert.equal(res.body.avatar, photo);
  assert.equal((await call(USER, 'PUT', '/me', { avatar: 'initials' })).body.avatar, null);
  assert.equal((await call(USER, 'PUT', '/me', { avatar: null })).body.avatarSource, 'provider');
  assert.equal((await call(USER, 'PUT', '/me', { avatar: 'https://evil.example/x.png' })).status, 400);
  assert.equal((await call(USER, 'PUT', '/me', { name: '' })).status, 400);
  assert.equal((await call(USER, 'PUT', '/me', { role: 'admin' })).status, 400);
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

test('new accounts get one welcome email', async () => {
  assert.deepEqual(emails.map((email) => email.to).sort(), [ADMIN.email, SUPER.email, USER.email].sort());
  assert.match(emails[0].subject, /^Welcome to Lyrcloud/);
  await call(USER, 'GET', '/me');
  assert.equal(emails.length, 3);
  assert.ok(table.get(USER.sub).welcomeSentAt);
});

test('email-and-password accounts are read with AdminGetUser and need a verified email', async () => {
  let me = (await call(EMAIL_USER, 'GET', '/me')).body;
  assert.equal(me.provider, 'Cognito');
  assert.equal(me.email, null);
  assert.equal(emails.length, 3);
  assert.deepEqual(cognitoCalls[0], ['AdminGetUserCommand', EMAIL_USER.username]);
  EMAIL_USER.email_verified = 'true';
  try {
    me = (await call(EMAIL_USER, 'GET', '/me')).body;
    assert.equal(me.email, 'lyrclouds@gmail.com');
    // The owner's address alone isn't enough: the super admin must sign in with Google.
    assert.equal(me.role, 'user');
  } finally {
    EMAIL_USER.email_verified = 'false';
  }
});

test('a mobile number is verified with a texted code', async () => {
  assert.equal((await call(USER, 'POST', '/me/phone', { phone: '12345' })).status, 400);
  let res = await call(USER, 'POST', '/me/phone', { phone: '+91 98765-43210' });
  assert.equal(res.status, 200);
  assert.equal(res.body.phonePending, '+919876543210');
  assert.equal(res.body.phoneVerified, false);
  assert.deepEqual(texts.map((text) => text.to), ['+919876543210']);
  assert.equal((await call(USER, 'POST', '/me/phone', { phone: '+919876543210' })).status, 429, 'a second code within 30 seconds');

  const wrong = texts[0].code === '000000' ? '111111' : '000000';
  assert.equal((await call(USER, 'POST', '/me/phone/verify', { code: wrong })).status, 400);
  assert.equal(table.get(USER.sub).phonePending.attempts, 1);
  res = await call(USER, 'POST', '/me/phone/verify', { code: texts[0].code });
  assert.equal(res.status, 200);
  assert.equal(res.body.phone, '+919876543210');
  assert.equal(res.body.phoneVerified, true);
  assert.equal(res.body.phonePending, null);
  assert.equal(JSON.stringify(table.get(USER.sub)).includes(texts[0].code), false, 'only a hash of the code is stored');

  const listed = (await call(ADMIN, 'GET', '/admin/users')).body.users.find((user) => user.userId === USER.sub);
  assert.equal(listed.phone, '+91••••210');
  assert.equal((await call(USER, 'DELETE', '/me/phone')).body.phone, null);
});

test('wrong codes run out after five tries', async () => {
  await call(USER, 'POST', '/me/phone', { phone: '+14155550100' });
  const wrong = texts[0].code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) await call(USER, 'POST', '/me/phone/verify', { code: wrong });
  assert.equal((await call(USER, 'POST', '/me/phone/verify', { code: texts[0].code })).status, 429);
});

test('the super admin emails updates to everyone opted in, and links unsubscribe', async () => {
  emails = [];
  await call(ADMIN, 'PUT', '/me', { emailUpdates: false });
  assert.equal((await call(ADMIN, 'POST', '/admin/updates', { subject: 'Hi', message: 'News' })).status, 403);
  assert.equal((await call(SUPER, 'POST', '/admin/updates', { subject: '', message: 'News' })).status, 400);

  const res = await call(SUPER, 'POST', '/admin/updates', { subject: 'Edge functions are here', message: 'Read more at https://www.lyrcloud.com/' });
  assert.equal(res.status, 200);
  assert.equal(res.body.remaining, 0);
  assert.equal(res.body.update.sent, 2);
  assert.deepEqual(emails.map((email) => email.to).sort(), [SUPER.email, USER.email].sort());
  // Sending the same update again reaches nobody twice.
  assert.equal((await call(SUPER, 'POST', '/admin/updates', { updateId: res.body.update.id })).body.update.sent, 2);
  assert.equal(emails.length, 2);

  const listing = (await call(ADMIN, 'GET', '/admin/updates')).body;
  assert.equal(listing.updates[0].subject, 'Edge functions are here');
  assert.equal(listing.recipients, 2);
  assert.equal((await call(ADMIN, 'GET', '/admin/users')).body.users.length, 3, 'the update log isn’t an account');

  const link = new URL(emails.find((email) => email.to === USER.email).text.match(/Unsubscribe: (\S+)/)[1]);
  assert.equal(link.origin, 'https://api.example.com');
  const query = Object.fromEntries(link.searchParams);
  assert.equal((await publicCall('GET', '/public/unsubscribe', query)).statusCode, 200);
  assert.notEqual(table.get(USER.sub).emailUpdates, false, 'opening the link alone changes nothing');
  assert.equal((await publicCall('POST', '/public/unsubscribe', { ...query, t: 'forged' })).statusCode, 400);
  assert.equal((await publicCall('POST', '/public/unsubscribe', query)).statusCode, 200);
  assert.equal((await call(USER, 'GET', '/me')).body.emailUpdates, false);
});
