// Lyrcloud Storage: env bindings in the runtime -> platform function -> DynamoDB / S3 (faked).
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

Object.assign(process.env, { DATA_TABLE_NAME: 'data', OBJECTS_BUCKET: 'objects', PLATFORM_SECRET: 'test-secret' });
const { handler: platform } = await import('./platform.mjs');
const { cleanBindings, readToken, signToken } = await import('./storage.mjs');
const { makeEnv } = await import('./runtime.mjs');

let items; // "pk|sk" -> item
let objects; // key -> { body, type, meta }

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const { input } = command;
  const name = command.constructor.name;
  if (name === 'GetCommand') return { Item: structuredClone(items.get(`${input.Key.pk}|${input.Key.sk}`)) };
  if (name === 'PutCommand') { items.set(`${input.Item.pk}|${input.Item.sk}`, structuredClone(input.Item)); return {}; }
  if (name === 'DeleteCommand') { items.delete(`${input.Key.pk}|${input.Key.sk}`); return {}; }
  if (name === 'QueryCommand') {
    const pk = input.ExpressionAttributeValues[':pk'];
    const prefix = input.ExpressionAttributeValues[':p'] || '';
    let rows = [...items.values()].filter((item) => item.pk === pk && item.sk.startsWith(prefix)).sort((a, b) => a.sk.localeCompare(b.sk));
    if (input.ExclusiveStartKey) {
      assert.equal(input.ExclusiveStartKey.pk, pk);
      rows = rows.filter((item) => item.sk > input.ExclusiveStartKey.sk);
    }
    const page = rows.slice(0, input.Limit);
    return { Items: page, LastEvaluatedKey: rows.length > page.length ? { pk, sk: page.at(-1).sk } : undefined };
  }
  throw new Error(`unexpected ${name}`);
};

S3Client.prototype.send = async function send(command) {
  const { input } = command;
  assert.equal(input.Bucket, 'objects');
  const missing = () => Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  if (command instanceof PutObjectCommand) {
    objects.set(input.Key, { body: Buffer.from(input.Body), type: input.ContentType, meta: input.Metadata });
    return { ETag: '"etag1"' };
  }
  if (command instanceof GetObjectCommand) {
    const found = objects.get(input.Key);
    if (!found) throw missing();
    return { Body: { transformToByteArray: async () => new Uint8Array(found.body) }, ContentLength: found.body.length, ContentType: found.type, ETag: '"etag1"', LastModified: new Date(0), Metadata: found.meta };
  }
  if (command instanceof HeadObjectCommand) {
    const found = objects.get(input.Key);
    if (!found) throw Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    return { ContentLength: found.body.length, ContentType: found.type, ETag: '"etag1"', LastModified: new Date(0) };
  }
  if (command instanceof DeleteObjectCommand) { objects.delete(input.Key); return {}; }
  if (command instanceof DeleteObjectsCommand) { for (const { Key } of input.Delete.Objects) objects.delete(Key); return {}; }
  if (command instanceof ListObjectsV2Command) {
    const keys = [...objects.keys()].filter((key) => key.startsWith(input.Prefix)).sort();
    return { Contents: keys.map((Key) => ({ Key, Size: objects.get(Key).body.length, ETag: '"e"', LastModified: new Date(0) })), IsTruncated: false };
  }
  throw new Error(`unexpected ${command.constructor.name}`);
};

beforeEach(() => {
  items = new Map();
  objects = new Map();
});

// What a deployed function's env looks like, wired straight to the platform handler.
const envFor = (owner, bindings, token = signToken('test-secret', { fn: 'fn', owner })) => makeEnv({ GREETING: 'hi' }, bindings, async (request) => {
  const out = await platform({ ...request, token });
  if (!out.ok) throw new Error(out.error);
  return out.result;
});
const BINDINGS = [{ binding: 'CACHE', type: 'kv', name: 'cache' }, { binding: 'FILES', type: 'bucket', name: 'uploads' }];

test('tokens are signed and checked', () => {
  const token = signToken('s', { fn: 'a', owner: 'u1' });
  assert.deepEqual(readToken('s', token), { fn: 'a', owner: 'u1' });
  assert.equal(readToken('other', token), null);
  const [body] = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ f: 'a', o: 'u2' })).toString('base64url')}.${token.split('.')[1]}`;
  assert.equal(readToken('s', forged), null);
  assert.ok(body);
});

test('bindings from lyrcloud.json', () => {
  assert.deepEqual(cleanBindings({ kv: { CACHE: 'cache' }, buckets: { FILES: 'uploads' } }), [BINDINGS, null]);
  assert.match(cleanBindings({ kv: { GREETING: 'x' } }, { GREETING: 'hi' })[1], /used twice/);
  assert.match(cleanBindings({ kv: { A: 'Bad Name' } })[1], /lowercase/);
  assert.match(cleanBindings({ kv: ['x'] })[1], /must map/);
});

test('KV: put, get in every type, metadata, list with prefix and cursor, delete', async () => {
  const env = envFor('u1', BINDINGS);
  assert.equal(env.GREETING, 'hi');
  await env.CACHE.put('user:1', JSON.stringify({ name: 'Ada' }), { metadata: { v: 1 } });
  await env.CACHE.put('user:2', new TextEncoder().encode('bytes'));
  await env.CACHE.put('other', 'x');
  assert.deepEqual(await env.CACHE.get('user:1', 'json'), { name: 'Ada' });
  assert.deepEqual(await env.CACHE.get('user:1', { type: 'json' }), { name: 'Ada' });
  assert.equal(new TextDecoder().decode(await env.CACHE.get('user:2', 'arrayBuffer')), 'bytes');
  assert.deepEqual(await env.CACHE.getWithMetadata('user:1'), { value: '{"name":"Ada"}', metadata: { v: 1 } });
  assert.equal(await env.CACHE.get('missing'), null);
  const first = await env.CACHE.list({ prefix: 'user:', limit: 1 });
  assert.deepEqual(first.keys.map((k) => k.name), ['user:1']);
  assert.equal(first.list_complete, false);
  const second = await env.CACHE.list({ prefix: 'user:', cursor: first.cursor });
  assert.deepEqual(second.keys.map((k) => k.name), ['user:2']);
  assert.equal(second.list_complete, true);
  await env.CACHE.delete('user:1');
  assert.equal(await env.CACHE.get('user:1'), null);
});

test('KV: expired keys disappear and bad TTLs are refused', async () => {
  const env = envFor('u1', BINDINGS);
  await env.CACHE.put('session', 'x', { expirationTtl: 60 });
  assert.equal(await env.CACHE.get('session'), 'x');
  items.get(`kv#u1#cache|session`).expiresAt = Math.floor(Date.now() / 1000) - 1;
  assert.equal(await env.CACHE.get('session'), null);
  await assert.rejects(env.CACHE.put('k', 'v', { expirationTtl: 5 }), /at least 60/);
  await assert.rejects(env.CACHE.put('big', 'x'.repeat(300 * 1024)), /at most 256 KB/);
});

test('accounts never see each other’s data, and bad tokens get nothing', async () => {
  await envFor('u1', BINDINGS).CACHE.put('secret', 'mine');
  await envFor('u1', BINDINGS).FILES.put('a.txt', 'mine');
  const other = envFor('u2', BINDINGS);
  assert.equal(await other.CACHE.get('secret'), null);
  assert.equal(await other.FILES.get('a.txt'), null);
  assert.deepEqual((await other.CACHE.list()).keys, []);
  const forged = envFor('u1', BINDINGS, 'not.valid');
  await assert.rejects(forged.CACHE.get('secret'), /token isn’t valid/);
});

test('buckets: put, head, get as text/json/stream, list, delete', async () => {
  const env = envFor('u1', BINDINGS);
  const put = await env.FILES.put('notes/a.json', JSON.stringify({ ok: true }), { httpMetadata: { contentType: 'application/json' } });
  assert.equal(put.key, 'notes/a.json');
  assert.equal(put.size, 11);
  await env.FILES.put('notes/b.txt', 'hello');
  await env.FILES.put('img.bin', new Uint8Array([1, 2, 3]));
  assert.equal(objects.get('u1/uploads/notes/b.txt').type, 'text/plain; charset=utf-8');
  assert.equal(objects.get('u1/uploads/img.bin').type, 'application/octet-stream');
  const head = await env.FILES.head('notes/a.json');
  assert.equal(head.httpMetadata.contentType, 'application/json');
  const file = await env.FILES.get('notes/a.json');
  assert.deepEqual(await file.json(), { ok: true });
  assert.equal(await new Response(file.body).text(), '{"ok":true}');
  const headers = new Headers();
  file.writeHttpMetadata(headers);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual((await env.FILES.list({ prefix: 'notes/' })).objects.map((o) => o.key), ['notes/a.json', 'notes/b.txt']);
  await env.FILES.delete(['notes/a.json', 'notes/b.txt']);
  assert.deepEqual((await env.FILES.list()).objects.map((o) => o.key), ['img.bin']);
  assert.equal(await env.FILES.get('notes/a.json'), null);
  assert.equal(await env.FILES.head('nope'), null);
});
