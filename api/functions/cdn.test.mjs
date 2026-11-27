// Lyrcloud CDN: static assets in the runtime, and the router's response cache with purges (AWS faked).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

Object.assign(process.env, {
  TABLE_NAME: 'functions', FUNCTIONS_TABLE: 'functions', USERS_TABLE_NAME: 'users', DATA_TABLE_NAME: 'data', FUNCTIONS_DOMAIN: 'dev.lyr', PLATFORM_SECRET: 'test-secret',
});
const { serveAsset, run } = await import('./runtime.mjs');
const { cleanAssets, archiveError } = await import('./rules.mjs');
const router = await import('./router.mjs');
const { handler: api } = await import('./index.mjs');

// ---------------------------------------------------------------- assets

const root = mkdtempSync(path.join(tmpdir(), 'lyr-assets-'));
mkdirSync(path.join(root, 'public/docs'), { recursive: true });
writeFileSync(path.join(root, 'public/index.html'), '<h1>home</h1>');
writeFileSync(path.join(root, 'public/about.html'), '<h1>about</h1>');
writeFileSync(path.join(root, 'public/docs/index.html'), '<h1>docs</h1>');
writeFileSync(path.join(root, 'public/app.js'), 'console.log(1)');
writeFileSync(path.join(root, 'secret.txt'), 'outside the assets folder');
process.env.LYR_ROOT = root;

const get = (rawPath, extra = {}) => ({ rawPath, headers: extra.headers || {}, requestContext: { http: { method: extra.method || 'GET' } } });
const text = (res) => Buffer.from(res.body, 'base64').toString();

test('assets settings', () => {
  assert.deepEqual(cleanAssets('public'), [{ dir: 'public', spa: false, maxAge: 3600, htmlMaxAge: 60 }, null]);
  assert.deepEqual(cleanAssets({ dir: './dist/', spa: true, maxAge: 86400 })[0], { dir: 'dist', spa: true, maxAge: 86400, htmlMaxAge: 60 });
  assert.match(cleanAssets('../up')[1], /inside your project/);
  assert.match(cleanAssets({ dir: 'x', maxAge: -1 })[1], /seconds/);
  assert.equal(archiveError([{ name: 'public/a.html', size: 1 }], null, 'public'), null);
  assert.match(archiveError([{ name: 'other/a.html', size: 1 }], null, 'public'), /has no files/);
});

test('files are served with types, cache headers, clean URLs and ETags', async () => {
  const assets = { dir: 'public', spa: false, maxAge: 3600, htmlMaxAge: 60 };
  const home = await serveAsset(get('/'), assets);
  assert.equal(text(home), '<h1>home</h1>');
  assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(home.headers['cache-control'], 'public, max-age=60');
  assert.equal(text(await serveAsset(get('/about'), assets)), '<h1>about</h1>');
  assert.equal(text(await serveAsset(get('/docs'), assets)), '<h1>docs</h1>');
  const js = await serveAsset(get('/app.js'), assets);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['cache-control'], 'public, max-age=3600');
  assert.equal((await serveAsset(get('/app.js', { headers: { 'if-none-match': js.headers.etag } }), assets)).statusCode, 304);
  assert.equal((await serveAsset(get('/app.js', { method: 'HEAD' }), assets)).body, '');
  assert.equal(await serveAsset(get('/missing'), assets), null);
  assert.equal(await serveAsset(get('/app.js', { method: 'POST' }), assets), null);
});

test('nothing outside the assets folder can be reached', async () => {
  const assets = { dir: 'public' };
  for (const attempt of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/docs/../../secret.txt']) {
    assert.equal(await serveAsset(get(attempt), assets), null, attempt);
  }
});

test('single-page apps get index.html for unknown routes, not for missing files', async () => {
  const assets = { dir: 'public', spa: true };
  assert.equal(text(await serveAsset(get('/settings/profile'), assets)), '<h1>home</h1>');
  assert.equal(await serveAsset(get('/missing.png'), assets), null);
});

test('assets come before fetch(), and a static-only project 404s the rest', async () => {
  process.env.LYR_ASSETS = JSON.stringify({ dir: 'public' });
  const mod = { default: { fetch: () => new Response('from code') } };
  assert.equal(text(await run(mod, get('/about'))), '<h1>about</h1>');
  assert.equal(Buffer.from((await run(mod, get('/api'))).body, 'base64').toString(), 'from code');
  assert.equal((await run(null, get('/api'))).statusCode, 404);
  delete process.env.LYR_ASSETS;
});

// ---------------------------------------------------------------- cache

let items;
let fn;
let invocations;
let answer;

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const { input } = command;
  const name = command.constructor.name;
  if (input.TableName === 'users') return { Item: { userId: input.Key.userId } };
  const k = (key) => `${input.TableName}|${key.pk}|${key.sk}`;
  if (name === 'GetCommand') {
    if (input.TableName === 'functions') return { Item: structuredClone(fn) };
    return { Item: structuredClone(items.get(k(input.Key))) };
  }
  if (name === 'PutCommand') {
    if (input.TableName === 'functions') { fn = structuredClone(input.Item); return {}; }
    items.set(k(input.Item), structuredClone(input.Item));
    return {};
  }
  if (name === 'DeleteCommand') { items.delete(k(input.Key)); return {}; }
  if (name === 'QueryCommand') {
    const pk = input.ExpressionAttributeValues[':pk'];
    const prefix = input.ExpressionAttributeValues[':p'] || '';
    return { Items: [...items.values()].filter((item) => item.pk === pk && item.sk.startsWith(prefix)) };
  }
  throw new Error(`unexpected ${name}`);
};
LambdaClient.prototype.send = async function send() {
  invocations += 1;
  return { Payload: Buffer.from(JSON.stringify(answer())) };
};

beforeEach(() => {
  items = new Map();
  fn = { pk: 'fn#blog', sk: 'fn', name: 'blog', ownerId: 'owner', deploys: 3 };
  invocations = 0;
  answer = () => ({ statusCode: 200, headers: { 'cache-control': 'public, max-age=300', 'content-type': 'text/html' }, body: `render #${invocations}` });
  router.clearPolicies();
});

const visit = (rawPath, { method = 'GET', headers = {}, query = '' } = {}) => router.handler({
  rawPath, rawQueryString: query, headers: { host: 'blog.dev.lyr', ...headers }, requestContext: { domainName: 'blog.dev.lyr', http: { method, sourceIp: '198.51.100.1' } },
});
const owner = (method, apiPath, body) => api({ requestContext: { http: { method, path: apiPath }, authorizer: { jwt: { claims: { sub: 'owner' } } } }, body: body ? JSON.stringify(body) : undefined });

test('public responses are cached: MISS, then HIT with Age, without running the function', async () => {
  const first = await visit('/post/1');
  assert.equal(first.headers['x-lyr-cache'], 'MISS');
  const second = await visit('/post/1');
  assert.equal(second.headers['x-lyr-cache'], 'HIT');
  assert.equal(second.body, 'render #1');
  assert.ok(second.headers.age >= 0);
  assert.equal(invocations, 1);
  // The query is part of the key; HEAD reads the GET entry.
  assert.equal((await visit('/post/1', { query: 'v=2' })).headers['x-lyr-cache'], 'MISS');
  const head = await visit('/post/1', { method: 'HEAD' });
  assert.equal(head.headers['x-lyr-cache'], 'HIT');
  assert.equal(head.body, '');
});

test('private, cookie-setting, Vary and uncacheable answers are never stored', async () => {
  for (const make of [
    () => ({ statusCode: 200, headers: { 'cache-control': 'private, max-age=300' }, body: 'x' }),
    () => ({ statusCode: 200, headers: { 'cache-control': 'public, max-age=300' }, cookies: ['a=1'], body: 'x' }),
    () => ({ statusCode: 200, headers: { 'cache-control': 'public, max-age=300', vary: 'Cookie' }, body: 'x' }),
    () => ({ statusCode: 200, headers: { 'cache-control': 'max-age=300' }, body: 'x' }),
    () => ({ statusCode: 500, headers: { 'cache-control': 'public, max-age=300' }, body: 'x' }),
    () => ({ statusCode: 200, headers: {}, body: 'x' }),
  ]) {
    answer = make;
    assert.equal((await visit('/p')).headers['x-lyr-cache'], 'BYPASS');
  }
  assert.equal([...items.keys()].filter((key) => key.includes('cache#')).length, 0);
  // s-maxage alone is enough.
  answer = () => ({ statusCode: 200, headers: { 'cache-control': 's-maxage=60' }, body: 'x' });
  assert.equal((await visit('/s')).headers['x-lyr-cache'], 'MISS');
});

test('requests with Authorization and POSTs skip the cache', async () => {
  await visit('/post/1');
  assert.equal((await visit('/post/1', { headers: { authorization: 'Bearer x' } })).headers['x-lyr-cache'], undefined);
  assert.equal((await visit('/post/1', { method: 'POST' })).headers['x-lyr-cache'], undefined);
  assert.equal(invocations, 3);
});

test('a new deploy starts a fresh cache', async () => {
  await visit('/post/1');
  fn.deploys = 4;
  router.clearPolicies();
  assert.equal((await visit('/post/1')).headers['x-lyr-cache'], 'MISS');
});

test('purges: one path, a prefix, or everything', async () => {
  await visit('/blog/a');
  await visit('/blog/b');
  await visit('/about');
  assert.equal(JSON.parse((await owner('POST', '/functions/blog/purge', { path: '/blog/a' })).body).purged, 'path');
  router.clearPolicies();
  assert.equal((await visit('/blog/a')).headers['x-lyr-cache'], 'MISS');
  assert.equal((await visit('/blog/b')).headers['x-lyr-cache'], 'HIT');
  assert.equal(JSON.parse((await owner('POST', '/functions/blog/purge', { prefix: '/blog/' })).body).count, 2);
  assert.equal((await visit('/blog/b')).headers['x-lyr-cache'], 'MISS');
  assert.equal((await visit('/about')).headers['x-lyr-cache'], 'HIT');
  assert.equal(JSON.parse((await owner('POST', '/functions/blog/purge', {})).body).purged, 'all');
  assert.equal(fn.cacheVersion, 1);
  router.clearPolicies();
  assert.equal((await visit('/about')).headers['x-lyr-cache'], 'MISS');
  // Only the owner may purge.
  assert.equal((await api({ requestContext: { http: { method: 'POST', path: '/functions/blog/purge' }, authorizer: { jwt: { claims: { sub: 'someone' } } } } })).statusCode, 404);
});

// ---------------------------------------------------------------- customer domains through the CDN

const { cdnOriginSecret, viewerIp } = await import('./rules.mjs');
const URL_HOST = 'abc123.lambda-url.us-east-1.on.aws';
const viaCdn = (rawPath, headers = {}) => router.handler({
  rawPath, rawQueryString: '', headers: { host: URL_HOST, ...headers }, requestContext: { domainName: URL_HOST, http: { method: 'GET', sourceIp: '130.176.0.1' } },
});

test('the router URL answers only CloudFront, and maps the origin path and host back', async () => {
  let seen;
  answer = () => ({ statusCode: 200, headers: {}, body: 'ok' });
  LambdaClient.prototype.send = async function send(command) {
    invocations += 1;
    seen = JSON.parse(Buffer.from(command.input.Payload).toString());
    return { Payload: Buffer.from(JSON.stringify(answer())) };
  };
  // No secret, a wrong one, or no function name: nothing runs.
  assert.equal((await viaCdn('/blog/about')).statusCode, 404);
  assert.equal((await viaCdn('/blog/about', { 'x-lyr-origin-secret': 'nope', 'x-lyr-host': 'shop.example.com' })).statusCode, 404);
  assert.equal((await viaCdn('/', { 'x-lyr-origin-secret': cdnOriginSecret('test-secret'), 'x-lyr-host': 'shop.example.com' })).statusCode, 404);
  assert.equal(invocations, 0);

  const res = await viaCdn('/blog/about', {
    'x-lyr-origin-secret': cdnOriginSecret('test-secret'), 'x-lyr-host': 'Shop.Example.com',
    'x-lyr-viewer-ip': '2001:db8::7', 'cloudfront-viewer-country': 'TR',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.rawPath, '/about');
  assert.equal(seen.headers.host, 'shop.example.com');
  assert.equal(seen.requestContext.domainName, 'shop.example.com');
  assert.equal(seen.requestContext.http.sourceIp, '2001:db8::7');
  assert.equal(seen.headers['cloudfront-viewer-country'], 'TR');
  assert.equal(seen.headers['x-lyr-origin-secret'], undefined);

  // On a .lyr address nobody may pretend to be CloudFront.
  await visit('/x', { headers: { 'cloudfront-viewer-country': 'US' } });
  assert.equal(seen.headers['cloudfront-viewer-country'], undefined);
  assert.equal(viewerIp('203.0.113.9:51234'), '203.0.113.9');
});
