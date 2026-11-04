// The GitHub OIDC bridge against a fake GitHub.
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SECRET = {
  githubClientId: 'gh-app',
  githubClientSecret: 'gh-app-secret',
  rsaPrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  keyId: 'key-1',
  internalCodeHmacSecret: 'hmac-secret',
  bridgeClientId: 'lyrcloud-github-bridge',
  bridgeClientSecret: 'cognito-secret',
};
process.env.BRIDGE_SECRET_JSON = JSON.stringify(SECRET);
process.env.BRIDGE_BASE_URL = 'https://bridge.example.com';
process.env.ALLOWED_REDIRECT_URI = 'https://auth.example.com/oauth2/idpresponse';
const { handler } = await import('./index.mjs');

globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  if (path === '/login/oauth/access_token') {
    const { code, client_id: id, client_secret: secret } = JSON.parse(options.body);
    if (code !== 'gh-code' || id !== 'gh-app' || secret !== 'gh-app-secret') return Response.json({ error: 'bad_verification_code' });
    return Response.json({ access_token: 'gh-token', token_type: 'bearer' });
  }
  if (options.headers?.authorization !== 'Bearer gh-token') return new Response('{}', { status: 401 });
  if (path === '/user') return Response.json({ id: 42, login: 'octo', name: null, avatar_url: 'https://avatars/42', email: null });
  if (path === '/user/emails') return Response.json([{ email: 'Old@Example.com', primary: false, verified: true }, { email: 'Octo@Example.com', primary: true, verified: true }]);
  return new Response('{}', { status: 404 });
};

const request = (method, path, { query, body, headers } = {}) =>
  handler({ requestContext: { http: { method, path } }, queryStringParameters: query, body, headers: headers || {} });

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const tokenBody = (code, extra = {}) =>
  new URLSearchParams({ grant_type: 'authorization_code', code, client_id: SECRET.bridgeClientId, client_secret: SECRET.bridgeClientSecret, ...extra }).toString();

async function signIn() {
  const authorize = await request('GET', '/authorize', {
    query: { client_id: SECRET.bridgeClientId, redirect_uri: process.env.ALLOWED_REDIRECT_URI, state: 'cognito-state', nonce: 'n-123', scope: 'openid' },
  });
  const toGithub = new URL(authorize.headers.location);
  const callback = await request('GET', '/callback', { query: { code: 'gh-code', state: toGithub.searchParams.get('state') } });
  return { toGithub, toCognito: new URL(callback.headers.location) };
}

test('discovery points at the bridge itself', async () => {
  const doc = JSON.parse((await request('GET', '/.well-known/openid-configuration')).body);
  assert.equal(doc.issuer, 'https://bridge.example.com');
  assert.equal(doc.userinfo_endpoint, 'https://bridge.example.com/userinfo');
});

test('a full sign-in: authorize, callback, token and userinfo', async () => {
  const { toGithub, toCognito } = await signIn();
  assert.equal(toGithub.origin + toGithub.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(toGithub.searchParams.get('client_id'), 'gh-app');
  assert.equal(toGithub.searchParams.get('redirect_uri'), 'https://bridge.example.com/callback');
  assert.equal(toCognito.origin + toCognito.pathname, process.env.ALLOWED_REDIRECT_URI);
  assert.equal(toCognito.searchParams.get('state'), 'cognito-state');

  const token = await request('POST', '/token', { body: tokenBody(toCognito.searchParams.get('code')) });
  assert.equal(token.statusCode, 200);
  const { access_token: accessToken, id_token: idToken } = JSON.parse(token.body);

  const [header, payload, signature] = idToken.split('.');
  const { keys } = JSON.parse((await request('GET', '/.well-known/jwks.json')).body);
  assert.equal(decode(header).kid, 'key-1');
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: keys[0], format: 'jwk' }), Buffer.from(signature, 'base64url')));
  const claims = decode(payload);
  assert.equal(claims.iss, 'https://bridge.example.com');
  assert.equal(claims.aud, SECRET.bridgeClientId);
  assert.equal(claims.nonce, 'n-123');
  assert.equal(claims.sub, 'github:42');
  assert.equal(claims.email, 'octo@example.com');
  assert.equal(claims.email_verified, true);
  assert.equal(claims.name, 'octo');

  const userinfo = JSON.parse((await request('GET', '/userinfo', { headers: { authorization: `Bearer ${accessToken}` } })).body);
  assert.deepEqual(userinfo, { sub: 'github:42', email: 'octo@example.com', email_verified: true, name: 'octo', preferred_username: 'octo', picture: 'https://avatars/42' });
  assert.equal((await request('GET', '/userinfo', { headers: { authorization: `Bearer ${accessToken}x` } })).statusCode, 401);
});

test('basic-auth client credentials work too', async () => {
  const { toCognito } = await signIn();
  const res = await request('POST', '/token', {
    headers: { authorization: `Basic ${Buffer.from(`${SECRET.bridgeClientId}:${SECRET.bridgeClientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: toCognito.searchParams.get('code') }).toString(),
  });
  assert.equal(res.statusCode, 200);
});

test('refuses foreign clients, redirects, forged codes and other grants', async () => {
  const { toCognito } = await signIn();
  const code = toCognito.searchParams.get('code');
  assert.equal((await request('GET', '/authorize', { query: { client_id: 'other', redirect_uri: process.env.ALLOWED_REDIRECT_URI } })).statusCode, 400);
  assert.equal((await request('GET', '/authorize', { query: { client_id: SECRET.bridgeClientId, redirect_uri: 'https://evil.example/cb' } })).statusCode, 400);
  assert.equal((await request('POST', '/token', { body: tokenBody(code, { client_secret: 'wrong' }) })).statusCode, 401);
  const [header, payload, signature] = code.split('.');
  const forged = `${header}.${Buffer.from(JSON.stringify({ ...decode(payload), sub: 'github:1' })).toString('base64url')}.${signature}`;
  assert.equal(JSON.parse((await request('POST', '/token', { body: tokenBody(forged) })).body).error, 'invalid_grant');
  assert.equal((await request('POST', '/token', { body: tokenBody(code, { grant_type: 'refresh_token' }) })).statusCode, 400);
  const denied = await request('GET', '/callback', { query: { error: 'access_denied', state: Buffer.from('{"s":"st"}').toString('base64url') } });
  assert.equal(new URL(denied.headers.location).searchParams.get('error'), 'access_denied');
});
