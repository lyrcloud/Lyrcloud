// Lyrcloud account API.
//   GET /me                               the signed-in profile (role, plan) and the site announcement
//   PUT /me                               { plan } change your own plan (billing isn't connected yet)
//   GET /admin/users                      every account (admins and the super admin)
//   PUT /admin/users/{userId}             { role?, plan?, disabled?, name? } (rules in roles.mjs)
//   DELETE /admin/users/{userId}          delete the account from Lyrcloud and Cognito (super admin)
//   POST /admin/users/{userId}/sign-out   sign the account out on every device
//   GET /admin/settings                   site settings (admins and the super admin)
//   PUT /admin/settings                   { announcement } (super admin only)
//   POST /public/lyrbot                   the site's help assistant (lyrbot.mjs); the only public route
//
// The other routes are protected by an API Gateway HTTP API JWT authorizer validating the Cognito
// *access token*. Access tokens only carry `sub`/`username`, not profile
// attributes, so each request calls the Cognito Hosted UI userInfo endpoint
// (authenticated by the bearer token itself) for email/name/picture, then upserts the profile row in
// DynamoDB with the AWS SDK that ships with the Lambda Node.js runtime.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  cleanLyrbotMessages,
  LYRBOT_DAILY_LIMIT,
  LYRBOT_DAILY_MESSAGE,
  LYRBOT_FALLBACK_REPLY,
  LYRBOT_HOURLY_LIMIT,
  LYRBOT_HOURLY_MESSAGE,
  lyrbotReply,
} from './lyrbot.mjs';
import {
  canManage,
  deleteUserError,
  isStaff,
  normalizeProvider,
  PLANS,
  publicProfile,
  roleFor,
  userUpdateError,
} from './roles.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const USER_POOL_ID = process.env.USER_POOL_ID;
// Site-wide settings live in the users table under this key. Cognito subs are UUIDs, so it can't
// collide with an account, and listProfiles() skips it.
const SETTINGS_KEY = '#settings';
const ANNOUNCEMENT_MAX = 500;
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com';
// Cognito Hosted UI domain; its userInfo endpoint turns an access token into the caller's profile.
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN || 'lyrcloud-auth.auth.us-east-1.amazoncognito.com';
// Lyrbot use counters, keyed { key: "lyrbot#<ip>" | "lyrbot#all", period: <hour> | <day> }, expire via TTL.
const RATE_TABLE_NAME = process.env.RATE_TABLE_NAME;
// Secrets Manager secret holding the Anthropic API key for Lyrbot; ANTHROPIC_API_KEY wins (local dev).
const ANTHROPIC_SECRET = process.env.ANTHROPIC_SECRET;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const errorResponse = (statusCode, message) => jsonResponse(statusCode, { error: message });

// userInfo, not GetUser: GetUser needs the aws.cognito.signin.user.admin scope, which the app
// client doesn't grant, so it failed on every call and the super admin was never recognised.
async function cognitoUserInfo(accessToken) {
  const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/userInfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userInfo failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Refreshes the caller's profile from Cognito and returns the stored row.
async function upsertCaller(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const userId = claims?.sub;
  if (!userId) return null;

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');

  let email = null;
  let name = null;
  let picture = null;
  let provider = (claims.username || 'unknown').split('_')[0];

  try {
    const user = await cognitoUserInfo(accessToken);
    email = user.email ? String(user.email).toLowerCase() : null;
    name = user.name ?? null;
    picture = user.picture ?? null;
    provider = (user.username || provider).split('_')[0];
  } catch (err) {
    console.error('cognitoUserInfo failed', err);
  }

  const now = new Date().toISOString();
  const existing = (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId } }))).Item;

  const profile = {
    ...existing,
    userId,
    // The Cognito username ("GoogleOIDC_123…"), needed to disable, sign out or delete the account.
    username: claims.username || existing?.username || null,
    email: email ?? existing?.email ?? null,
    // A name set by an admin sticks; otherwise follow the identity provider.
    name: existing?.nameLocked ? existing.name : name ?? existing?.name ?? null,
    picture: picture ?? existing?.picture ?? null,
    provider: normalizeProvider(provider),
    createdAt: existing?.createdAt || now,
    lastLoginAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: profile }));
  return profile;
}

async function listProfiles() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, ExclusiveStartKey }));
    items.push(...(page.Items || []).filter((item) => item.userId !== SETTINGS_KEY));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

function parseBody(event) {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ admin

async function getSettings() {
  const item = (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: SETTINGS_KEY } }))).Item;
  return { announcement: item?.announcement || '', updatedAt: item?.updatedAt || null };
}

// The Cognito username for a stored profile. Rows written before usernames were stored are looked
// up by sub.
async function cognitoUsername(profile) {
  if (profile.username) return profile.username;
  const sub = String(profile.userId).replace(/[^0-9a-f-]/gi, '');
  const { Users } = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Filter: `sub = "${sub}"`, Limit: 1 }));
  return Users?.[0]?.Username || null;
}

// Runs a Cognito admin call for `profile`; an account that no longer exists in Cognito is not an error.
async function onCognitoUser(profile, makeCommand) {
  const Username = await cognitoUsername(profile);
  if (!Username) return false;
  try {
    await cognito.send(makeCommand({ UserPoolId: USER_POOL_ID, Username }));
    return true;
  } catch (err) {
    if (err.name === 'UserNotFoundException') return false;
    throw err;
  }
}

const getProfile = async (userId) => (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId } }))).Item;

async function adminRoutes(event, method, path, caller, callerRole) {
  if (!isStaff(callerRole)) return errorResponse(403, 'Admins only.');

  if (path === '/admin/settings') {
    if (method === 'GET') return jsonResponse(200, await getSettings());
    if (method === 'PUT') {
      if (callerRole !== 'superadmin') return errorResponse(403, 'Only the super admin can change site settings.');
      const body = parseBody(event);
      if (!body || typeof body.announcement !== 'string') return errorResponse(400, 'Send { "announcement": "…" }.');
      const announcement = body.announcement.trim().slice(0, ANNOUNCEMENT_MAX);
      const updatedAt = new Date().toISOString();
      await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: { userId: SETTINGS_KEY, announcement, updatedAt, updatedBy: caller.userId } }));
      return jsonResponse(200, { announcement, updatedAt });
    }
    return errorResponse(404, 'not_found');
  }

  if (method === 'GET' && path === '/admin/users') {
    const users = (await listProfiles())
      .map((profile) => publicProfile(profile, SUPER_ADMIN_EMAIL))
      .sort((a, b) => String(b.lastLoginAt).localeCompare(String(a.lastLoginAt)));
    return jsonResponse(200, { users });
  }

  const match = path.match(/^\/admin\/users\/([^/]+)(\/sign-out)?$/);
  if (!match) return errorResponse(404, 'not_found');
  const userId = decodeURIComponent(event.pathParameters?.userId || match[1]);
  const target = await getProfile(userId);
  if (!target) return errorResponse(404, 'No such user.');
  const targetRole = roleFor(target, SUPER_ADMIN_EMAIL);

  if (match[2]) {
    if (method !== 'POST') return errorResponse(404, 'not_found');
    if (!canManage(callerRole, targetRole)) return errorResponse(403, 'You can’t sign this account out.');
    return jsonResponse(200, { signedOut: await onCognitoUser(target, (input) => new AdminUserGlobalSignOutCommand(input)) });
  }

  if (method === 'DELETE') {
    const refused = deleteUserError(callerRole, targetRole);
    if (refused) return errorResponse(...refused);
    await onCognitoUser(target, (input) => new AdminDeleteUserCommand(input));
    await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { userId } }));
    return jsonResponse(200, { deleted: userId });
  }

  if (method === 'PUT') {
    const body = parseBody(event);
    if (!body) return errorResponse(400, 'Invalid JSON body.');
    const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    const refused = userUpdateError(callerRole, targetRole, changes);
    if (refused) return errorResponse(...refused);

    // Disabling also blocks sign-in in Cognito and ends the account's current sessions.
    if ('disabled' in changes && changes.disabled !== (target.disabled === true)) {
      await onCognitoUser(target, (input) => (changes.disabled ? new AdminDisableUserCommand(input) : new AdminEnableUserCommand(input)));
      if (changes.disabled) await onCognitoUser(target, (input) => new AdminUserGlobalSignOutCommand(input));
    }

    const names = {};
    const values = { ':now': new Date().toISOString(), ':by': caller.userId };
    const sets = ['updatedAt = :now', 'updatedBy = :by'];
    for (const [key, value] of Object.entries(changes)) {
      names[`#${key}`] = key;
      values[`:${key}`] = key === 'name' ? value.trim() || null : value;
      sets.push(`#${key} = :${key}`);
    }
    if ('name' in changes) {
      // An admin-set name stays put on later sign-ins; clearing it hands the name back to the provider.
      sets.push('nameLocked = :locked');
      values[':locked'] = Boolean(values[':name']);
    }
    const { Attributes } = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(userId)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return jsonResponse(200, { user: publicProfile(Attributes, SUPER_ADMIN_EMAIL) });
  }

  return errorResponse(404, 'not_found');
}

// ------------------------------------------------------------------ Lyrbot

// Counts one use of `key` in the current hour or day and returns the running total.
async function countUse(key, period = 'hour') {
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: RATE_TABLE_NAME,
    Key: { key, period: new Date().toISOString().slice(0, period === 'day' ? 10 : 13) },
    UpdateExpression: 'ADD hits :one SET expiresAt = :expires',
    ExpressionAttributeValues: { ':one': 1, ':expires': Math.floor(Date.now() / 1000) + (period === 'day' ? 26 : 2) * 3600 },
    ReturnValues: 'ALL_NEW',
  }));
  return Attributes.hits;
}

let anthropicKey;
async function getAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_SECRET) return null;
  anthropicKey ??= (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: ANTHROPIC_SECRET }))).SecretString.trim();
  return anthropicKey;
}

async function lyrbotChat(event) {
  const apiKey = await getAnthropicKey();
  if (!apiKey || !RATE_TABLE_NAME) return errorResponse(503, LYRBOT_FALLBACK_REPLY);
  const body = parseBody(event);
  if (!body) return errorResponse(400, 'Invalid JSON body.');
  const conversation = cleanLyrbotMessages(body.messages);
  if (!conversation) return errorResponse(422, 'Type a question for Lyrbot.');
  if ((await countUse(`lyrbot#${event.requestContext?.http?.sourceIp || 'unknown'}`)) > LYRBOT_HOURLY_LIMIT) {
    return errorResponse(429, LYRBOT_HOURLY_MESSAGE);
  }
  if ((await countUse('lyrbot#all', 'day')) > LYRBOT_DAILY_LIMIT) return errorResponse(429, LYRBOT_DAILY_MESSAGE);
  const [status, reply] = await lyrbotReply(apiKey, conversation);
  return jsonResponse(status, reply);
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';

  if (method === 'POST' && path === '/public/lyrbot') {
    try {
      return await lyrbotChat(event);
    } catch (err) {
      console.error('Lyrbot failed', err);
      return errorResponse(500, LYRBOT_FALLBACK_REPLY);
    }
  }

  const caller = await upsertCaller(event);
  if (!caller) return errorResponse(401, 'unauthorized');
  const callerRole = roleFor(caller, SUPER_ADMIN_EMAIL);

  // Disabled accounts are also blocked in Cognito; this covers tokens issued before that.
  if (caller.disabled === true && callerRole !== 'superadmin') return errorResponse(403, 'This account has been disabled.');

  if (path === '/me') {
    if (method === 'GET') {
      const { announcement } = await getSettings();
      return jsonResponse(200, { ...publicProfile(caller, SUPER_ADMIN_EMAIL), announcement });
    }
    if (method === 'PUT') {
      const body = parseBody(event);
      if (!body || !PLANS.includes(body.plan)) return errorResponse(400, `Plan must be one of ${PLANS.join(', ')}.`);
      const { Attributes } = await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId: caller.userId },
        UpdateExpression: 'SET #plan = :plan, planUpdatedAt = :now',
        ExpressionAttributeNames: { '#plan': 'plan' },
        ExpressionAttributeValues: { ':plan': body.plan, ':now': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
      }));
      return jsonResponse(200, publicProfile(Attributes, SUPER_ADMIN_EMAIL));
    }
  }

  if (path.startsWith('/admin/')) return adminRoutes(event, method, path, caller, callerRole);

  return errorResponse(404, 'not_found');
};
