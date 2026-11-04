// Lyrcloud account API.
//   GET /me                    the signed-in profile, including its role
//   GET /admin/users           every account (admins and the super admin)
//   PUT /admin/users/{userId}  { role: "admin" | "user" } (super admin only)
//   POST /public/lyrbot        the site's help assistant (lyrbot.mjs); the only public route
//
// The other routes are protected by an API Gateway HTTP API JWT authorizer validating the Cognito
// *access token*. Access tokens only carry `sub`/`username`, not profile
// attributes, so each request calls the Cognito Hosted UI userInfo endpoint
// (authenticated by the bearer token itself) for email/name/picture, then upserts the profile row in
// DynamoDB with the AWS SDK that ships with the Lambda Node.js runtime.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
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
import { isStaff, normalizeProvider, publicProfile, roleChangeError, roleFor } from './roles.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
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
    email: email ?? existing?.email ?? null,
    name: name ?? existing?.name ?? null,
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
    items.push(...(page.Items || []));
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

  if (method === 'GET' && path === '/me') {
    return jsonResponse(200, publicProfile(caller, SUPER_ADMIN_EMAIL));
  }

  if (path === '/admin/users' || path.startsWith('/admin/users/')) {
    if (!isStaff(callerRole)) return errorResponse(403, 'Admins only.');

    if (method === 'GET' && path === '/admin/users') {
      const users = (await listProfiles())
        .map((profile) => publicProfile(profile, SUPER_ADMIN_EMAIL))
        .sort((a, b) => String(b.lastLoginAt).localeCompare(String(a.lastLoginAt)));
      return jsonResponse(200, { users });
    }

    if (method === 'PUT') {
      const userId = decodeURIComponent(event.pathParameters?.userId || path.slice('/admin/users/'.length));
      const body = parseBody(event);
      if (!body) return errorResponse(400, 'Invalid JSON body.');
      const target = (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId } }))).Item;
      if (!target) return errorResponse(404, 'No such user.');

      const refused = roleChangeError(callerRole, roleFor(target, SUPER_ADMIN_EMAIL), body.role);
      if (refused) return errorResponse(...refused);

      const { Attributes } = await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId },
        UpdateExpression: 'SET #role = :role, roleUpdatedAt = :now, roleUpdatedBy = :by',
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':role': body.role, ':now': new Date().toISOString(), ':by': caller.userId },
        ReturnValues: 'ALL_NEW',
      }));
      return jsonResponse(200, { user: publicProfile(Attributes, SUPER_ADMIN_EMAIL) });
    }
  }

  return errorResponse(404, 'not_found');
};
