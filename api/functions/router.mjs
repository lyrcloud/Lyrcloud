// The Edge Functions router. Every <name>.dev.lyr address is an API Gateway custom domain mapped to one
// HTTP API whose only route sends here; this passes the request to the Lambda function lyrfn-<name>
// (which runs __lyrcloud/runtime.mjs) and returns what it answers.
//
// Before the function runs, this enforces Application Security (security.mjs: IP rules, WAF, rate limits,
// bot checks) and Lyrcloud Access (access.mjs: protected paths need a valid session cookie,
// /__lyrcloud/access swaps a sign-in ticket for one, /__lyrcloud/logout ends it). Blocks are logged.
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  ACCESS_HEADER, cookieValue, isProtected, REQUEST_SECONDS, safeReturn, SESSION_COOKIE, SESSION_SECONDS, sign, TICKET_SECONDS, verify,
} from './access.mjs';
import { CACHE_MAX_BODY, CACHE_MAX_SECONDS, FUNCTIONS_DOMAIN_DEFAULT, fromCdn, lambdaName, nameFromHost } from './rules.mjs';
import {
  CHALLENGE_SECONDS, challengePage, HUMAN_COOKIE, HUMAN_SECONDS, ipMatches, looksAutomated, solves, underPath, wafMatch, withSecureHeaders,
} from './security.mjs';
import { newNonce } from './access.mjs';

const env = process.env;
const DOMAIN = env.FUNCTIONS_DOMAIN || FUNCTIONS_DOMAIN_DEFAULT;
const ACCESS_URL = env.ACCESS_URL || 'https://www.lyrcloud.com/access/';
export const lambda = new LambdaClient({});
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const secrets = new SecretsManagerClient({});
export const clock = { now: () => Date.now() };

const page = (statusCode, title, message, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5"><h1>${title}</h1><p>${message}</p><p><a href="https://www.lyrcloud.com/developers/">Lyrcloud Edge Functions</a></p></body>`,
});
const redirect = (location, cookies) => ({ statusCode: 302, headers: { location, 'cache-control': 'no-store' }, ...(cookies ? { cookies } : {}), body: '' });

let secret;
async function platformSecret() {
  if (env.PLATFORM_SECRET) return env.PLATFORM_SECRET;
  secret ??= (await secrets.send(new GetSecretValueCommand({ SecretId: env.PLATFORM_SECRET_NAME }))).SecretString;
  return secret;
}

// A function's Access and Security settings, cached briefly so most requests don't read the table.
const policies = new Map();
export const clearPolicies = () => policies.clear();
async function settingsOf(name) {
  if (!env.FUNCTIONS_TABLE) return {};
  const hit = policies.get(name);
  if (hit && hit.at > clock.now() - 30_000) return hit.settings;
  const { Item } = await ddb.send(new GetCommand({
    TableName: env.FUNCTIONS_TABLE, Key: { pk: `fn#${name}`, sk: 'fn' }, ProjectionExpression: '#a, #s, ownerId, deploys, cacheVersion', ExpressionAttributeNames: { '#a': 'access', '#s': 'security' },
  }));
  const settings = {
    access: Item?.access || null, security: Item?.security || null, ownerId: Item?.ownerId || null,
    cacheVersion: `${Item?.deploys || 0}.${Item?.cacheVersion || 0}`,
  };
  policies.set(name, { settings, at: clock.now() });
  return settings;
}

// Security events go to the owner's log, at most 60 a minute per function from each router instance
// so an attack can't flood the table.
const logBudget = new Map();
async function logEvent(name, settings, entry) {
  if (!settings.ownerId || !env.DATA_TABLE_NAME) return;
  const minute = Math.floor(clock.now() / 60_000);
  const used = logBudget.get(name);
  const count = used?.minute === minute ? used.count : 0;
  if (count >= 60) return;
  logBudget.set(name, { minute, count: count + 1 });
  const at = new Date(clock.now());
  try {
    await ddb.send(new PutCommand({
      TableName: env.DATA_TABLE_NAME,
      Item: { pk: `sec#${settings.ownerId}#${name}`, sk: `${at.toISOString()}#${newNonce()}`, ...entry, expiresAt: Math.floor(at.getTime() / 1000) + 30 * 86400 },
    }));
  } catch (err) {
    console.error('Security log failed', err);
  }
}

const blocked = (statusCode, message, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  body: JSON.stringify({ error: message }),
});

// Fixed-window count for one rule and visitor; returns seconds to wait when over the limit, else 0.
async function overLimit(name, index, rule, ip) {
  const window = Math.floor(clock.now() / 1000 / rule.seconds);
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: env.DATA_TABLE_NAME,
    Key: { pk: `rl#${name}#${index}#${ip}`, sk: String(window) },
    UpdateExpression: 'ADD #c :one SET expiresAt = :exp',
    ExpressionAttributeNames: { '#c': 'count' },
    ExpressionAttributeValues: { ':one': 1, ':exp': (window + 2) * rule.seconds },
    ReturnValues: 'UPDATED_NEW',
  }));
  if (Attributes.count <= rule.requests) return 0;
  return Math.max(1, (window + 1) * rule.seconds - Math.floor(clock.now() / 1000));
}

// Application Security checks; a response to send instead of running the function, or null.
async function screen(event, name, settings, headers) {
  const security = settings.security;
  if (!security) return null;
  const path = event.rawPath || '/';
  const ip = event.requestContext?.http?.sourceIp || '';
  const method = event.requestContext?.http?.method || 'GET';
  const base = { ip, path: path.slice(0, 300), method, userAgent: String(headers['user-agent'] || '').slice(0, 200) };

  if (security.allowIps?.length && !ipMatches(security.allowIps, ip)) {
    await logEvent(name, settings, { ...base, rule: 'ip-allow-list', action: 'block' });
    return blocked(403, 'Your IP address isn’t allowed here.');
  }
  if (ipMatches(security.blockIps, ip)) {
    await logEvent(name, settings, { ...base, rule: 'ip-block-list', action: 'block' });
    return blocked(403, 'Your IP address is blocked here.');
  }
  if (security.waf && security.waf !== 'off') {
    const rule = wafMatch(event);
    if (rule) {
      await logEvent(name, settings, { ...base, rule: `waf:${rule}`, action: security.waf === 'block' ? 'block' : 'log' });
      if (security.waf === 'block') return blocked(403, 'This request was blocked by the site’s firewall.');
    }
  }
  for (const [index, rule] of (security.rateLimits || []).entries()) {
    if (!underPath(rule.path, path)) continue;
    const wait = await overLimit(name, index, rule, ip);
    if (wait) {
      await logEvent(name, settings, { ...base, rule: `rate-limit:${rule.path}`, action: 'block' });
      return blocked(429, 'Too many requests. Slow down and try again shortly.', { 'retry-after': String(wait) });
    }
  }
  const bots = security.bots || { mode: 'off' };
  const botPath = !bots.paths?.length || bots.paths.some((prefix) => underPath(prefix, path));
  if (bots.mode === 'block' && botPath && looksAutomated(headers['user-agent'])) {
    await logEvent(name, settings, { ...base, rule: 'bots:automation', action: 'block' });
    return blocked(403, 'Automated requests aren’t allowed here.');
  }
  if (bots.mode === 'challenge' && botPath) {
    const human = verify(await platformSecret(), 'human', cookieValue(event.cookies || headers.cookie, HUMAN_COOKIE), clock.now());
    if (!human || human.fn !== name) {
      if (method !== 'GET' && method !== 'HEAD') {
        await logEvent(name, settings, { ...base, rule: 'bots:challenge', action: 'block' });
        return blocked(403, 'Open this site in a browser first.');
      }
      const nonce = newNonce();
      const ret = path + (event.rawQueryString ? `?${event.rawQueryString}` : '');
      const token = sign(await platformSecret(), 'challenge', { fn: name, nonce, ret }, CHALLENGE_SECONDS, clock.now());
      return { statusCode: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: challengePage(token, nonce, ret) };
    }
  }
  return null;
}

// ---------------------------------------------------------------- cache

// Seconds a function's response may be shared for, or 0. Only plain public answers are kept: no
// cookies, no private/no-store, no Vary beyond Accept-Encoding, and small enough for one table item.
export function cacheSeconds(answer) {
  if (![200, 203, 301, 404, 410].includes(answer.statusCode)) return 0;
  if (answer.cookies?.length || answer.multiValueHeaders) return 0;
  const headers = Object.fromEntries(Object.entries(answer.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (headers['set-cookie']) return 0;
  const vary = (headers.vary || '').toLowerCase().split(',').map((v) => v.trim()).filter(Boolean);
  if (vary.some((v) => v !== 'accept-encoding')) return 0;
  const cc = (headers['cache-control'] || '').toLowerCase();
  if (!cc || /\b(private|no-store|no-cache)\b/.test(cc)) return 0;
  const shared = /\bs-maxage=(\d+)/.exec(cc);
  const max = /\bmax-age=(\d+)/.exec(cc);
  if (!shared && !(max && /\bpublic\b/.test(cc))) return 0;
  const seconds = Number((shared || max)[1]);
  if (!(seconds > 0)) return 0;
  if (String(answer.body || '').length > CACHE_MAX_BODY) return 0;
  return Math.min(seconds, CACHE_MAX_SECONDS);
}

const withCacheHeader = (answer, state, age) => ({
  ...answer,
  headers: { ...(answer.headers || {}), 'x-lyr-cache': state, ...(age !== undefined ? { age: String(age) } : {}) },
});

async function cacheLookup(key) {
  if (!env.DATA_TABLE_NAME) return null;
  const { Item } = await ddb.send(new GetCommand({ TableName: env.DATA_TABLE_NAME, Key: key }));
  if (!Item || Item.expiresAt <= Math.floor(clock.now() / 1000)) return null;
  return Item;
}

async function acceptChallenge(event, name) {
  const params = new URLSearchParams(event.rawQueryString || '');
  const challenge = verify(await platformSecret(), 'challenge', params.get('token'), clock.now());
  if (!challenge || challenge.fn !== name || !solves(challenge.nonce, params.get('answer'))) {
    return page(403, 'Check failed', 'Your browser didn’t pass the check. <a href="/">Try again</a>.');
  }
  const human = sign(await platformSecret(), 'human', { fn: name }, HUMAN_SECONDS, clock.now());
  return redirect(safeReturn(challenge.ret), [`${HUMAN_COOKIE}=${human}; Path=/; Max-Age=${HUMAN_SECONDS}; HttpOnly; Secure; SameSite=Lax`]);
}

const sessionCookie = (value, maxAge) => `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

// Swaps a sign-in ticket for a session cookie. Tickets work once: their nonce is recorded.
async function acceptTicket(event, name) {
  const params = new URLSearchParams(event.rawQueryString || '');
  const ticket = verify(await platformSecret(), 'ticket', params.get('ticket'), clock.now());
  if (!ticket || ticket.fn !== name) return page(403, 'Sign-in link expired', `This sign-in link isn’t valid any more. <a href="/">Try again</a>.`);
  try {
    await ddb.send(new PutCommand({
      TableName: env.DATA_TABLE_NAME,
      Item: { pk: `ticket#${ticket.nonce}`, sk: 'used', expiresAt: ticket.exp + 60 },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return page(403, 'Sign-in link already used', 'Each sign-in link works once. <a href="/">Try again</a>.');
    throw err;
  }
  const session = sign(await platformSecret(), 'session', { fn: name, email: ticket.email }, SESSION_SECONDS, clock.now());
  return redirect(safeReturn(ticket.ret), [sessionCookie(session, SESSION_SECONDS)]);
}

// The router's own function URL is only for the Lyrcloud CDN (a customer's domain pointed at a function).
const viaFunctionUrl = (event) => /\.lambda-url\./.test(String(event.requestContext?.domainName || ''));

export const handler = async (incoming) => {
  let event = incoming;
  let name;
  const cdn = viaFunctionUrl(incoming);
  if (cdn) {
    const routed = fromCdn(incoming, await platformSecret());
    if (!routed) return page(404, 'Not found', 'There’s no Lyrcloud function at this address.');
    ({ name, event } = routed);
  } else {
    name = nameFromHost(event.requestContext?.domainName || event.headers?.host, DOMAIN);
  }
  if (!name) return page(404, 'Not found', 'There’s no Lyrcloud function at this address.');
  const path = event.rawPath || '/';

  // Nobody outside Lyrcloud may claim to be a signed-in visitor, or claim CloudFront's viewer details.
  const headers = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    const lower = key.toLowerCase();
    if (!lower.startsWith('lyr-access-') && (cdn || !lower.startsWith('cloudfront-viewer-'))) headers[key] = value;
  }
  const forwarded = { ...event, headers };

  if (path === '/__lyrcloud/access') return acceptTicket(event, name);
  if (path === '/__lyrcloud/logout') return redirect('/', [sessionCookie('', 0)]);
  if (path === '/__lyrcloud/challenge') return acceptChallenge(event, name);

  const settings = await settingsOf(name);
  const refused = await screen(forwarded, name, settings, headers);
  if (refused) return refused;
  const finish = (result) => (settings.security?.headers ? withSecureHeaders(result) : result);

  const policy = settings.access;
  if (isProtected(policy, path)) {
    const session = verify(await platformSecret(), 'session', cookieValue(event.cookies || headers.cookie), clock.now());
    if (!session || session.fn !== name) {
      const method = event.requestContext?.http?.method || 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        return { statusCode: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ error: 'Sign in with Lyrcloud Access first.' }) };
      }
      const ret = path + (event.rawQueryString ? `?${event.rawQueryString}` : '');
      const to = sign(await platformSecret(), 'request', { fn: name, ret }, REQUEST_SECONDS, clock.now());
      return redirect(`${ACCESS_URL}?to=${encodeURIComponent(to)}`);
    }
    headers[ACCESS_HEADER] = session.email;
  }

  // The cache: GET and HEAD for paths that aren't behind Access, without an Authorization header.
  const method = (event.requestContext?.http?.method || 'GET').toUpperCase();
  const cacheable = (method === 'GET' || method === 'HEAD') && !isProtected(policy, path) && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  const cacheKey = { pk: `cache#${name}#${settings.cacheVersion || '0.0'}`, sk: path + (event.rawQueryString ? `?${event.rawQueryString}` : '') };
  if (cacheable) {
    const hit = await cacheLookup(cacheKey).catch((err) => {
      console.error('Cache read failed', err);
      return null;
    });
    if (hit) {
      const age = Math.max(0, Math.floor(clock.now() / 1000) - hit.storedAt);
      const answer = { statusCode: hit.statusCode, headers: hit.headers, body: method === 'HEAD' ? '' : hit.body, isBase64Encoded: method === 'HEAD' ? false : hit.isBase64Encoded };
      return finish(withCacheHeader(answer, 'HIT', age));
    }
  }

  let result;
  try {
    result = await lambda.send(new InvokeCommand({ FunctionName: lambdaName(name), Payload: Buffer.from(JSON.stringify(forwarded)) }));
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return page(404, 'Not found', `There’s no function called ${name} yet.`);
    if (err.name === 'TooManyRequestsException') return page(503, 'Busy', 'This function is receiving too many requests or has been paused. Try again shortly.');
    if (err.name === 'RequestTooLargeException') return page(413, 'Too large', 'The request is larger than functions accept (6 MB).');
    console.error('Invoke failed', name, err);
    return page(502, 'Function unavailable', 'This function couldn’t be reached. Try again shortly.');
  }
  const text = Buffer.from(result.Payload || []).toString('utf8');
  if (result.FunctionError) {
    console.error('Function error', name, result.FunctionError, text.slice(0, 2000));
    const timedOut = /timed out/i.test(text);
    return page(timedOut ? 504 : 502, timedOut ? 'Timed out' : 'Function failed', timedOut
      ? 'This function took longer than its time limit to answer.'
      : 'This function stopped unexpectedly. Its owner can see why with <code>lyrcloud logs</code>.');
  }
  try {
    const answer = JSON.parse(text);
    if (answer && typeof answer.statusCode === 'number') {
      const seconds = cacheable && method === 'GET' ? cacheSeconds(answer) : 0;
      if (seconds && env.DATA_TABLE_NAME) {
        const storedAt = Math.floor(clock.now() / 1000);
        await ddb.send(new PutCommand({
          TableName: env.DATA_TABLE_NAME,
          Item: { ...cacheKey, statusCode: answer.statusCode, headers: answer.headers || {}, body: answer.body || '', isBase64Encoded: Boolean(answer.isBase64Encoded), storedAt, expiresAt: storedAt + seconds },
        })).catch((err) => console.error('Cache write failed', err));
      }
      return finish(cacheable ? withCacheHeader(answer, seconds ? 'MISS' : 'BYPASS') : answer);
    }
  } catch {
    // fall through
  }
  return page(502, 'Function failed', 'This function returned something that isn’t an HTTP response.');
};
