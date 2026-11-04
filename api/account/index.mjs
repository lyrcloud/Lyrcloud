// Lyrcloud account API.
//   GET /me                               the signed-in profile (role, plan) and the site announcement
//   PUT /me                               { plan?, name?, avatar?, emailUpdates? } edit your own profile (billing isn't connected yet)
//   POST /me/phone                        { phone } text a 6-digit code to a mobile number (E.164)
//   POST /me/phone/verify                 { code } confirm the number with that code
//   DELETE /me/phone                      remove the mobile number
//   GET /admin/users                      every account (admins and the super admin)
//   PUT /admin/users/{userId}             { role?, plan?, disabled?, name? } (rules in roles.mjs)
//   DELETE /admin/users/{userId}          delete the account from Lyrcloud and Cognito (super admin)
//   POST /admin/users/{userId}/sign-out   sign the account out on every device
//   GET /admin/settings                   site settings (admins and the super admin)
//   PUT /admin/settings                   { announcement } (super admin only)
//   GET /admin/updates                    product update emails sent so far
//   POST /admin/updates                   { subject, message } email an update to everyone opted in (super
//                                         admin); { updateId } carries on with one that ran out of time
//   POST /public/lyrbot                   the site's help assistant (lyrbot.mjs)
//   GET|POST /public/unsubscribe?u=&t=    stop product update emails from a signed email link
//
// The /public/ routes need no sign-in. The other routes are protected by an API Gateway HTTP API JWT authorizer validating the Cognito
// *access token*. Access tokens only carry `sub`/`username`, not profile
// attributes, so each request calls the Cognito Hosted UI userInfo endpoint
// (authenticated by the bearer token itself) for email/name/picture — or AdminGetUser when the token
// lacks the openid scope, as email-and-password sessions do — then upserts the profile row in
// DynamoDB with the AWS SDK that ships with the Lambda Node.js runtime.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  cleanLyrbotMessages,
  LYRBOT_DAILY_LIMIT,
  LYRBOT_DAILY_MESSAGE,
  LYRBOT_FALLBACK_REPLY,
  LYRBOT_HOURLY_LIMIT,
  LYRBOT_HOURLY_MESSAGE,
  lyrbotReply,
} from './lyrbot.mjs';
import { unsubscribePage, unsubscribeToken, updateEmail, updateEmailError, validUnsubscribeToken, welcomeEmail } from './mail.mjs';
import { checkCode, CODE_TTL_MS, hashCode, newCode, normalizePhone, SMS_PER_USER_PER_DAY, SMS_SITE_PER_DAY, smsMessage } from './phone.mjs';
import {
  canManage,
  deleteUserError,
  EMAIL_PROVIDER,
  isStaff,
  normalizeProvider,
  PLANS,
  providerFromUsername,
  publicProfile,
  roleFor,
  selfUpdateError,
  userUpdateError,
} from './roles.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const USER_POOL_ID = process.env.USER_POOL_ID;
// Site-wide settings live in the users table under this key. Cognito subs are UUIDs, so it can't
// collide with an account, and listProfiles() skips it.
const SETTINGS_KEY = '#settings';
// The product update emails sent so far, newest first.
const UPDATES_KEY = '#updates';
const UPDATES_KEPT = 10;
const ANNOUNCEMENT_MAX = 500;
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com';
// Cognito Hosted UI domain; its userInfo endpoint turns an access token into the caller's profile.
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN || 'lyrcloud-auth.auth.us-east-1.amazoncognito.com';
// Lyrbot use counters, keyed { key: "lyrbot#<ip>" | "lyrbot#all", period: <hour> | <day> }, expire via TTL.
const RATE_TABLE_NAME = process.env.RATE_TABLE_NAME;
// Secrets Manager secret holding the Anthropic API key for Lyrbot; ANTHROPIC_API_KEY wins (local dev).
const ANTHROPIC_SECRET = process.env.ANTHROPIC_SECRET;
// Secrets Manager secret that signs unsubscribe links and phone codes; APP_SECRET wins (tests).
const APP_SECRET_NAME = process.env.APP_SECRET_NAME;
// SES sender, e.g. "Lyrcloud <no-reply@lyrcloud.com>"; without it no email is sent.
const MAIL_FROM = process.env.MAIL_FROM;
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO;
const SMS_SENDER_ID = process.env.SMS_SENDER_ID;
const ses = new SESv2Client({});
const sns = new SNSClient({});

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

// The caller's Cognito attributes. Hosted UI tokens (Google, GitHub) work with userInfo; tokens from
// the email-and-password form don't carry the openid scope, so those are read with AdminGetUser.
async function cognitoProfile(accessToken, username) {
  try {
    return await cognitoUserInfo(accessToken);
  } catch (err) {
    if (!username || !USER_POOL_ID) throw err;
  }
  const { UserAttributes = [], Username } = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
  return { ...Object.fromEntries(UserAttributes.map(({ Name, Value }) => [Name, Value])), username: Username };
}

async function sendEmail(to, { subject, text, html }, headers) {
  if (!MAIL_FROM) throw new Error('MAIL_FROM is not set');
  await ses.send(new SendEmailCommand({
    FromEmailAddress: MAIL_FROM,
    ...(MAIL_REPLY_TO ? { ReplyToAddresses: [MAIL_REPLY_TO] } : {}),
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: text, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } },
        ...(headers ? { Headers: headers } : {}),
      },
    },
  }));
}

// Refreshes the caller's profile from Cognito and returns the stored row. A brand-new account is sent
// the welcome email.
async function upsertCaller(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const userId = claims?.sub;
  if (!userId) return null;

  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');

  let email = null;
  let name = null;
  let picture = null;
  let provider = providerFromUsername(claims.username);

  try {
    const user = await cognitoProfile(accessToken, claims.username);
    provider = providerFromUsername(user.username || claims.username);
    // Email-and-password accounts can change their email attribute, so only a verified one counts.
    const emailTrusted = provider !== EMAIL_PROVIDER || String(user.email_verified) === 'true';
    email = user.email && emailTrusted ? String(user.email).toLowerCase() : null;
    name = user.name ?? null;
    picture = user.picture ?? null;
  } catch (err) {
    console.error('Cognito profile lookup failed', err);
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

  if (!existing && profile.email && MAIL_FROM) {
    try {
      await sendEmail(profile.email, welcomeEmail(profile));
      profile.welcomeSentAt = now;
    } catch (err) {
      console.error('Welcome email failed', err);
    }
  }

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: profile }));
  return profile;
}

async function listProfiles() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, ExclusiveStartKey }));
    items.push(...(page.Items || []).filter((item) => !String(item.userId).startsWith('#')));
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

  if (path === '/admin/updates') return updatesRoutes(event, method, caller, callerRole);

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

// ------------------------------------------------------------------ secrets, phone and email

let appSecret;
async function getAppSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (!APP_SECRET_NAME) throw new Error('APP_SECRET_NAME is not set');
  appSecret ??= (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: APP_SECRET_NAME }))).SecretString.trim();
  return appSecret;
}

// Applies SET (`set`) and REMOVE (`remove`) to the caller's row and returns the updated row.
async function updateProfile(userId, set = {}, remove = []) {
  const names = {};
  const values = {};
  const sets = Object.entries(set).map(([key, value]) => {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    return `#${key} = :${key}`;
  });
  for (const key of remove) names[`#${key}`] = key;
  const expression = [sets.length ? `SET ${sets.join(', ')}` : '', remove.length ? `REMOVE ${remove.map((key) => `#${key}`).join(', ')}` : '']
    .filter(Boolean)
    .join(' ');
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { userId },
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    ...(sets.length ? { ExpressionAttributeValues: values } : {}),
    ReturnValues: 'ALL_NEW',
  }));
  return Attributes;
}

const selfResponse = (profile) => jsonResponse(200, publicProfile(profile, SUPER_ADMIN_EMAIL, { self: true }));

async function phoneRoutes(event, method, path, caller) {
  if (method === 'DELETE' && path === '/me/phone') {
    return selfResponse(await updateProfile(caller.userId, {}, ['phone', 'phoneVerified', 'phoneVerifiedAt', 'phonePending']));
  }
  const body = parseBody(event);
  if (!body) return errorResponse(400, 'Invalid JSON body.');
  const secret = await getAppSecret();

  if (method === 'POST' && path === '/me/phone') {
    const phone = normalizePhone(body.phone);
    if (!phone) return errorResponse(400, 'Enter your mobile number with its country code, e.g. +91 98765 43210.');
    if (caller.phoneVerified && caller.phone === phone) return errorResponse(400, 'That number is already verified.');
    const sentAt = caller.phonePending?.sentAt || 0;
    if (Date.now() - sentAt < 30_000) return errorResponse(429, 'Wait 30 seconds before asking for another code.');
    if (!RATE_TABLE_NAME) return errorResponse(503, 'Text messages aren’t set up yet.');
    if ((await countUse(`sms#${caller.userId}`, 'day')) > SMS_PER_USER_PER_DAY) return errorResponse(429, 'That’s enough codes for today. Try again tomorrow.');
    if ((await countUse('sms#all', 'day')) > SMS_SITE_PER_DAY) return errorResponse(429, 'Text messages are busy right now. Try again later.');

    const code = newCode();
    try {
      await sns.send(new PublishCommand({
        PhoneNumber: phone,
        Message: smsMessage(code),
        MessageAttributes: {
          'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
          ...(SMS_SENDER_ID ? { 'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: SMS_SENDER_ID } } : {}),
        },
      }));
    } catch (err) {
      console.error('SMS failed', err);
      return errorResponse(502, 'We couldn’t text that number. Check it and try again.');
    }
    const pending = { phone, hash: hashCode(secret, caller.userId, phone, code), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: Date.now() };
    return selfResponse(await updateProfile(caller.userId, { phonePending: pending }));
  }

  if (method === 'POST' && path === '/me/phone/verify') {
    const result = checkCode(secret, caller, body.code);
    if (result.error) {
      if (result.wrong) await updateProfile(caller.userId, { phonePending: { ...caller.phonePending, attempts: (caller.phonePending.attempts || 0) + 1 } });
      return errorResponse(...result.error);
    }
    const now = new Date().toISOString();
    return selfResponse(await updateProfile(caller.userId, { phone: result.phone, phoneVerified: true, phoneVerifiedAt: now }, ['phonePending']));
  }

  return errorResponse(404, 'not_found');
}

const apiBaseUrl = (event) => (event.requestContext?.domainName ? `https://${event.requestContext.domainName}` : process.env.API_BASE_URL || '');

const htmlResponse = (statusCode, html) => ({ statusCode, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html });

// GET shows a button (so mail scanners that open links don't unsubscribe anyone); POST unsubscribes,
// which is also what mail apps' one-click "Unsubscribe" sends.
async function unsubscribe(event, method) {
  const { u: userId, t: token } = event.queryStringParameters || {};
  const valid = validUnsubscribeToken(await getAppSecret(), userId, token);
  if (!valid || !(await getProfile(userId))) return htmlResponse(400, unsubscribePage('invalid'));
  if (method === 'GET') return htmlResponse(200, unsubscribePage('confirm', `/public/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`));
  await updateProfile(userId, { emailUpdates: false, emailUpdatesChangedAt: new Date().toISOString() });
  return htmlResponse(200, unsubscribePage('done'));
}

const getUpdates = async () => (await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { userId: UPDATES_KEY } }))).Item?.updates || [];
const saveUpdates = (updates) => ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: { userId: UPDATES_KEY, updates: updates.slice(0, UPDATES_KEPT) } }));
const updateRecipients = (profiles) => profiles.filter((profile) => profile.email && profile.emailUpdates !== false && profile.disabled !== true);

// Sends an update to everyone opted in who hasn't had it yet, for up to ~20 seconds (API Gateway
// gives up at 30). The console calls again with the updateId until nothing remains.
async function sendUpdate(event, caller) {
  if (!MAIL_FROM) return errorResponse(503, 'Email sending isn’t set up yet (MAIL_FROM).');
  const body = parseBody(event);
  if (!body) return errorResponse(400, 'Invalid JSON body.');
  const updates = await getUpdates();
  let update;
  if (body.updateId) {
    update = updates.find((item) => item.id === body.updateId);
    if (!update) return errorResponse(404, 'No such update.');
  } else {
    const refused = updateEmailError(body);
    if (refused) return errorResponse(...refused);
    update = {
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      subject: body.subject.trim(),
      message: body.message.trim(),
      sentAt: new Date().toISOString(),
      sentBy: caller.email || caller.userId,
      sent: 0,
      failed: 0,
    };
    updates.unshift(update);
  }

  const secret = await getAppSecret();
  const base = apiBaseUrl(event);
  const queue = updateRecipients(await listProfiles()).filter((profile) => profile.lastUpdateId !== update.id && profile.failedUpdateId !== update.id);
  const deadline = Date.now() + 20_000;
  let processed = 0;
  const worker = async () => {
    while (queue.length && Date.now() < deadline) {
      const profile = queue.shift();
      const url = `${base}/public/unsubscribe?u=${encodeURIComponent(profile.userId)}&t=${unsubscribeToken(secret, profile.userId)}`;
      try {
        await sendEmail(profile.email, updateEmail({ subject: update.subject, message: update.message, unsubscribeUrl: url }), [
          { Name: 'List-Unsubscribe', Value: `<${url}>` },
          { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
        ]);
        await updateProfile(profile.userId, { lastUpdateId: update.id });
        update.sent += 1;
      } catch (err) {
        console.error('Update email failed', profile.userId, err);
        await updateProfile(profile.userId, { failedUpdateId: update.id });
        update.failed += 1;
      }
      processed += 1;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  // Re-read so a send running alongside isn't overwritten, then store this update's counts.
  const latest = await getUpdates();
  const index = latest.findIndex((item) => item.id === update.id);
  if (index === -1) latest.unshift(update);
  else latest[index] = update;
  await saveUpdates(latest);
  return jsonResponse(200, { update: { ...update, message: undefined }, remaining: queue.length, processed });
}

async function updatesRoutes(event, method, caller, callerRole) {
  if (method === 'GET') {
    const recipients = updateRecipients(await listProfiles()).length;
    return jsonResponse(200, { updates: (await getUpdates()).map(({ message, ...update }) => update), recipients, mailEnabled: Boolean(MAIL_FROM) });
  }
  if (method === 'POST') {
    if (callerRole !== 'superadmin') return errorResponse(403, 'Only the super admin can email updates.');
    return sendUpdate(event, caller);
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

  if (path === '/public/unsubscribe' && (method === 'GET' || method === 'POST')) return unsubscribe(event, method);

  const caller = await upsertCaller(event);
  if (!caller) return errorResponse(401, 'unauthorized');
  const callerRole = roleFor(caller, SUPER_ADMIN_EMAIL);

  // Disabled accounts are also blocked in Cognito; this covers tokens issued before that.
  if (caller.disabled === true && callerRole !== 'superadmin') return errorResponse(403, 'This account has been disabled.');

  if (path === '/me') {
    if (method === 'GET') {
      const { announcement } = await getSettings();
      return jsonResponse(200, { ...publicProfile(caller, SUPER_ADMIN_EMAIL, { self: true }), announcement });
    }
    if (method === 'PUT') {
      const body = parseBody(event);
      if (!body) return errorResponse(400, 'Invalid JSON body.');
      const refused = selfUpdateError(body);
      if (refused) return errorResponse(...refused);
      const now = new Date().toISOString();
      const sets = ['profileUpdatedAt = :now'];
      const names = {};
      const values = { ':now': now };
      if ('plan' in body) {
        sets.push('#plan = :plan', 'planUpdatedAt = :now');
        names['#plan'] = 'plan';
        values[':plan'] = body.plan;
      }
      if ('name' in body) {
        // A name the user picked sticks over the identity provider's on later sign-ins.
        sets.push('#name = :name', 'nameLocked = :locked');
        names['#name'] = 'name';
        values[':name'] = body.name.trim();
        values[':locked'] = true;
      }
      if ('avatar' in body) {
        sets.push('avatar = :avatar');
        values[':avatar'] = body.avatar;
      }
      if ('emailUpdates' in body) {
        sets.push('emailUpdates = :emailUpdates', 'emailUpdatesChangedAt = :now');
        values[':emailUpdates'] = body.emailUpdates;
      }
      const { Attributes } = await ddb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId: caller.userId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }));
      return selfResponse(Attributes);
    }
  }

  if (path.startsWith('/me/phone')) return phoneRoutes(event, method, path, caller);

  if (path.startsWith('/admin/')) return adminRoutes(event, method, path, caller, callerRole);

  return errorResponse(404, 'not_found');
};
