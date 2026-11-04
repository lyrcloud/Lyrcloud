// The GitHub OIDC bridge against a fake GitHub.
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.SIGNING_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.COGNITO_REDIRECT_URI = 'https://auth.example.com/oauth2/idpresponse';
const { handler } = await import('./index.mjs');

const githubCalls = [];
globalThis.fetch = async (url, options = {}) => {
  githubCalls.push([String(url), options.body]);
  const path = new URL(url).pathname;
  if (path === '/login/oauth/access_token') {
    const { code, client_secret: secret } = JSON.parse(options.body);
    if (code !== 'gh-code' || secret !== 'shh') return Response.json({ error: 'bad_verification_code' });
    return Response.json({ access_token: 'gh-token', token_type: 'bearer' });
  }
  if (options.headers?.authorization !== 'Bearer gh-token') return new Response('{}', { status: 401 });
  if (path === '/user') return Response.json({ id: 42, login: 'octo', name: null, avatar_url: 'https://avatars/42', email: null });
  if (path === '/user/emails') return Response.json([{ email: 'Old@Example.com', primary: false, verified: true }, { email: 'Octo@Example.com', primary: true, verified: true }]);
  return new Response('{}', { status: 404 });
};

const request = (method, path, { query, body, headers } = {}) =>
  handler({ requestContext: { http: { method, path }, domainName: 'bridge.example.com' }, queryStringParameters: query, body, headers: headers || {} });

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('discovery points at the bridge itself', async () => {
  const doc = JSON.parse((await request('GET', '/.well-known/openid-configuration')).body);
  assert.equal(doc.issuer, 'https://bridge.example.com');
  assert.equal(doc.jwks_uri, 'https://bridge.example.com/jwks.json');
});

test('a full sign-in: authorize, callback, token and userinfo', async () => {
  const authorize = await request('GET', '/authorize', {
    query: { client_id: 'gh-client', redirect_uri: process.env.COGNITO_REDIRECT_URI, state: 'cognito-state', nonce: 'n-123', scope: 'openid email' },
  });
  assert.equal(authorize.statusCode, 302);
  const toGithub = new URL(authorize.headers.location);
  assert.equal(toGithub.origin + toGithub.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(toGithub.searchParams.get('redirect_uri'), 'https://bridge.example.com/callback');
  assert.equal(toGithub.searchParams.get('scope'), 'read:user user:email');

  const callback = await request('GET', '/callback', { query: { code: 'gh-code', state: toGithub.searchParams.get('state') } });
  const toCognito = new URL(callback.headers.location);
  assert.equal(toCognito.origin + toCognito.pathname, process.env.COGNITO_REDIRECT_URI);
  assert.equal(toCognito.searchParams.get('state'), 'cognito-state');

  const token = await request('POST', '/token', {
    body: new URLSearchParams({ grant_type: 'authorization_code', code: toCognito.searchParams.get('code'), client_id: 'gh-client', client_secret: 'shh' }).toString(),
  });
  assert.equal(token.statusCode, 200);
  const { access_token: accessToken, id_token: idToken } = JSON.parse(token.body);
  assert.equal(accessToken, 'gh-token');

  const [header, payload, signature] = idToken.split('.');
  const { keys } = JSON.parse((await request('GET', '/jwks.json')).body);
  assert.equal(decode(header).kid, keys[0].kid);
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: keys[0], format: 'jwk' }), Buffer.from(signature, 'base64url')));
  const claims = decode(payload);
  assert.equal(claims.iss, 'https://bridge.example.com');
  assert.equal(claims.aud, 'gh-client');
  assert.equal(claims.nonce, 'n-123');
  assert.equal(claims.sub, '42');
  assert.equal(claims.email, 'octo@example.com');
  assert.equal(claims.email_verified, true);
  assert.equal(claims.name, 'octo');

  const userinfo = await request('GET', '/userinfo', { headers: { authorization: 'Bearer gh-token' } });
  assert.equal(JSON.parse(userinfo.body).preferred_username, 'octo');
  assert.equal((await request('GET', '/userinfo', { headers: { authorization: 'Bearer stale' } })).statusCode, 401);
});

test('basic-auth client credentials work too', async () => {
  const res = await request('POST', '/token', {
    headers: { authorization: `Basic ${Buffer.from('gh-client:shh').toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'gh-code.' }).toString(),
  });
  assert.equal(res.statusCode, 200);
});

test('refuses foreign redirects, bad codes and other grants', async () => {
  assert.equal((await request('GET', '/authorize', { query: { client_id: 'c', redirect_uri: 'https://evil.example/cb' } })).statusCode, 400);
  const bad = await request('POST', '/token', { body: 'grant_type=authorization_code&code=nope&client_id=c&client_secret=shh' });
  assert.equal(bad.statusCode, 400);
  assert.equal(JSON.parse(bad.body).error, 'invalid_grant');
  assert.equal((await request('POST', '/token', { body: 'grant_type=refresh_token&client_id=c&client_secret=shh' })).statusCode, 400);
  const denied = await request('GET', '/callback', { query: { error: 'access_denied', state: Buffer.from('{"s":"st"}').toString('base64url') } });
  assert.equal(new URL(denied.headers.location).searchParams.get('error'), 'access_denied');
});
