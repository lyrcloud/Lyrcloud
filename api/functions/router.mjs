// The Edge Functions router. Every <name>.dev.lyr address is an API Gateway custom domain mapped to one
// HTTP API whose only route sends here; this passes the request to the Lambda function lyrfn-<name>
// (which runs __lyrcloud/runtime.mjs) and returns what it answers.
//
// Lyrcloud Access (access.mjs) is enforced here, before the function runs: protected paths need a valid
// session cookie, /__lyrcloud/access swaps a sign-in ticket for one, and /__lyrcloud/logout ends it.
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  ACCESS_HEADER, cookieValue, isProtected, REQUEST_SECONDS, safeReturn, SESSION_COOKIE, SESSION_SECONDS, sign, TICKET_SECONDS, verify,
} from './access.mjs';
import { FUNCTIONS_DOMAIN_DEFAULT, lambdaName, nameFromHost } from './rules.mjs';

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

// A function's Access policy, cached briefly so most requests don't read the table.
const policies = new Map();
async function accessPolicy(name) {
  if (!env.FUNCTIONS_TABLE) return null;
  const hit = policies.get(name);
  if (hit && hit.at > clock.now() - 30_000) return hit.policy;
  const { Item } = await ddb.send(new GetCommand({ TableName: env.FUNCTIONS_TABLE, Key: { pk: `fn#${name}`, sk: 'fn' }, ProjectionExpression: 'access' }));
  const policy = Item?.access || null;
  policies.set(name, { policy, at: clock.now() });
  return policy;
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

export const handler = async (event) => {
  const name = nameFromHost(event.requestContext?.domainName || event.headers?.host, DOMAIN);
  if (!name) return page(404, 'Not found', 'There’s no Lyrcloud function at this address.');
  const path = event.rawPath || '/';

  // Nobody outside Lyrcloud may claim to be a signed-in visitor.
  const headers = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (!key.toLowerCase().startsWith('lyr-access-')) headers[key] = value;
  }
  const forwarded = { ...event, headers };

  if (path === '/__lyrcloud/access') return acceptTicket(event, name);
  if (path === '/__lyrcloud/logout') return redirect('/', [sessionCookie('', 0)]);

  const policy = await accessPolicy(name);
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
    if (answer && typeof answer.statusCode === 'number') return answer;
  } catch {
    // fall through
  }
  return page(502, 'Function failed', 'This function returned something that isn’t an HTTP response.');
};
