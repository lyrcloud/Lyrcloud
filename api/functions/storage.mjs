// Lyrcloud Storage for Edge Functions: key-value namespaces (DynamoDB) and object buckets (S3).
// Everything is scoped to an owner (a Lyrcloud account): KV items live under pk "kv#<owner>#<namespace>",
// objects under "<owner>/<bucket>/<key>". Both the platform function (called by deployed functions'
// env bindings, see platform.mjs) and the CLI's /storage routes (index.mjs) go through here.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export const s3 = new S3Client({});
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const env = process.env;
const DATA_TABLE = () => env.DATA_TABLE_NAME;
const OBJECTS_BUCKET = () => env.OBJECTS_BUCKET;

// ---------------------------------------------------------------- limits and names

export const KV_MAX_KEY_BYTES = 512;
export const KV_MAX_VALUE_BYTES = 256 * 1024; // DynamoDB items stop at 400 KB
export const KV_MAX_METADATA_BYTES = 1024;
export const KV_MIN_TTL_SECONDS = 60;
export const OBJECT_MAX_BYTES = 4 * 1024 * 1024; // through Lambda's 6 MB payload as base64
export const OBJECT_MAX_KEY_BYTES = 1024;
export const LIST_MAX = 1000;

export class StorageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const STORE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const storeNameError = (name) => (typeof name === 'string' && STORE_NAME_RE.test(name)
  ? null
  : 'Namespace and bucket names use 1–63 lowercase letters, digits and hyphens.');
const BINDING_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// lyrcloud.json "kv": { BINDING: "namespace" } and "buckets": { BINDING: "bucket" } ->
// [{ binding, type, name }], or a problem. `vars` names can't be reused.
export function cleanBindings({ kv, buckets, ai } = {}, vars = {}) {
  const out = [];
  // "ai": "AI" puts the AI Gateway on env.AI.
  if (ai !== undefined && ai !== null) {
    if (typeof ai !== 'string' || !BINDING_RE.test(ai)) return [null, '"ai" must be a binding name, such as "AI".'];
    if (ai in vars) return [null, `${ai} is used twice. Each binding and variable needs its own name.`];
    out.push({ binding: ai, type: 'ai', name: 'ai' });
  }
  for (const [type, map] of [['kv', kv], ['bucket', buckets]]) {
    if (map === undefined || map === null) continue;
    if (typeof map !== 'object' || Array.isArray(map)) return [null, `"${type === 'kv' ? 'kv' : 'buckets'}" must map binding names to ${type === 'kv' ? 'namespace' : 'bucket'} names.`];
    for (const [binding, name] of Object.entries(map)) {
      if (!BINDING_RE.test(binding)) return [null, `“${binding}” isn’t a valid binding name. Use letters, digits and underscores.`];
      if (binding in vars || out.some((item) => item.binding === binding)) return [null, `${binding} is used twice. Each binding and variable needs its own name.`];
      const problem = storeNameError(name);
      if (problem) return [null, `${binding}: ${problem}`];
      out.push({ binding, type, name });
    }
  }
  if (out.length > 20) return [null, 'Functions can have at most 20 storage bindings.'];
  return [out, null];
}

// ---------------------------------------------------------------- function tokens

// A deployed function gets a token naming its owner, signed with the platform secret. Its env bindings
// send it with every call, so a function can only ever reach its own owner's data.
const b64url = (buf) => Buffer.from(buf).toString('base64url');
export function signToken(secret, { fn, owner }) {
  const body = b64url(JSON.stringify({ f: fn, o: owner }));
  return `${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`;
}
export function readToken(secret, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { f, o } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return f && o ? { fn: f, owner: o } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- key-value

const kvPk = (owner, ns) => `kv#${owner}#${ns}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function checkKey(key) {
  if (typeof key !== 'string' || !key) throw new StorageError(400, 'Keys must be non-empty text.');
  if (Buffer.byteLength(key) > KV_MAX_KEY_BYTES) throw new StorageError(400, `Keys can be at most ${KV_MAX_KEY_BYTES} bytes.`);
}

function checkStore(name) {
  const problem = storeNameError(name);
  if (problem) throw new StorageError(400, problem);
}

const live = (item) => item && (!item.expiresAt || item.expiresAt > nowSeconds());

// value: base64 of the bytes. Returns { value, metadata, expiration } or null.
export async function kvGet(owner, ns, key) {
  checkStore(ns);
  checkKey(key);
  const { Item } = await ddb.send(new GetCommand({ TableName: DATA_TABLE(), Key: { pk: kvPk(owner, ns), sk: key } }));
  if (!live(Item)) return null;
  return { value: Item.value, metadata: Item.metadata ?? null, expiration: Item.expiresAt || null };
}

export async function kvPut(owner, ns, key, value, { expirationTtl, expiration, metadata } = {}) {
  checkStore(ns);
  checkKey(key);
  if (typeof value !== 'string') throw new StorageError(400, 'Send the value as base64.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > KV_MAX_VALUE_BYTES) throw new StorageError(413, `Values can be at most ${KV_MAX_VALUE_BYTES / 1024} KB.`);
  let expiresAt;
  if (expirationTtl !== undefined && expirationTtl !== null) {
    const ttl = Number(expirationTtl);
    if (!Number.isFinite(ttl) || ttl < KV_MIN_TTL_SECONDS) throw new StorageError(400, `expirationTtl must be at least ${KV_MIN_TTL_SECONDS} seconds.`);
    expiresAt = nowSeconds() + Math.floor(ttl);
  } else if (expiration !== undefined && expiration !== null) {
    expiresAt = Math.floor(Number(expiration));
    if (!Number.isFinite(expiresAt) || expiresAt < nowSeconds() + KV_MIN_TTL_SECONDS) throw new StorageError(400, `expiration must be at least ${KV_MIN_TTL_SECONDS} seconds from now.`);
  }
  if (metadata !== undefined && metadata !== null && Buffer.byteLength(JSON.stringify(metadata)) > KV_MAX_METADATA_BYTES) {
    throw new StorageError(400, `Metadata can be at most ${KV_MAX_METADATA_BYTES} bytes as JSON.`);
  }
  await ddb.send(new PutCommand({
    TableName: DATA_TABLE(),
    Item: { pk: kvPk(owner, ns), sk: key, value: bytes.toString('base64'), size: bytes.length, metadata: metadata ?? undefined, expiresAt, updatedAt: new Date().toISOString() },
  }));
}

export async function kvDelete(owner, ns, key) {
  checkStore(ns);
  checkKey(key);
  await ddb.send(new DeleteCommand({ TableName: DATA_TABLE(), Key: { pk: kvPk(owner, ns), sk: key } }));
}

export async function kvList(owner, ns, { prefix = '', limit = LIST_MAX, cursor } = {}) {
  checkStore(ns);
  const max = Math.max(1, Math.min(LIST_MAX, Number(limit) || LIST_MAX));
  const keys = [];
  // The cursor carries only the last key, so it can't point at anyone else's namespace.
  let start = cursor ? { pk: kvPk(owner, ns), sk: Buffer.from(String(cursor), 'base64url').toString('utf8') } : undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: DATA_TABLE(),
      KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :p)' : 'pk = :pk',
      ExpressionAttributeValues: { ':pk': kvPk(owner, ns), ...(prefix ? { ':p': prefix } : {}) },
      ProjectionExpression: 'sk, expiresAt, metadata',
      Limit: max - keys.length,
      ExclusiveStartKey: start,
    }));
    for (const item of page.Items || []) {
      if (live(item)) keys.push({ name: item.sk, expiration: item.expiresAt || undefined, metadata: item.metadata ?? undefined });
    }
    start = page.LastEvaluatedKey;
  } while (start && keys.length < max);
  return { keys, list_complete: !start, cursor: start ? b64url(start.sk) : undefined };
}

// ---------------------------------------------------------------- objects

const objectPrefix = (owner, bucket) => `${owner}/${bucket}/`;
function objectKey(owner, bucket, key) {
  checkStore(bucket);
  if (typeof key !== 'string' || !key) throw new StorageError(400, 'Object keys must be non-empty text.');
  if (Buffer.byteLength(key) > OBJECT_MAX_KEY_BYTES) throw new StorageError(400, `Object keys can be at most ${OBJECT_MAX_KEY_BYTES} bytes.`);
  return objectPrefix(owner, bucket) + key;
}

const describe = (key, head) => ({
  key,
  size: Number(head.ContentLength ?? head.Size ?? 0),
  etag: String(head.ETag || '').replace(/"/g, ''),
  uploaded: (head.LastModified instanceof Date ? head.LastModified : new Date(head.LastModified || Date.now())).toISOString(),
  // S3 listings don't carry the content type, so listed objects leave it out rather than guess.
  httpMetadata: head.ContentType ? { contentType: head.ContentType } : {},
  customMetadata: head.Metadata || {},
});

export async function objectHead(owner, bucket, key) {
  try {
    return describe(key, await s3.send(new HeadObjectCommand({ Bucket: OBJECTS_BUCKET(), Key: objectKey(owner, bucket, key) })));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// Returns { ...object, body: base64 } or null.
export async function objectGet(owner, bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: OBJECTS_BUCKET(), Key: objectKey(owner, bucket, key) }));
    const bytes = Buffer.from(await res.Body.transformToByteArray());
    return { ...describe(key, res), body: bytes.toString('base64') };
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function objectPut(owner, bucket, key, body, { contentType, customMetadata } = {}) {
  const Key = objectKey(owner, bucket, key);
  if (typeof body !== 'string') throw new StorageError(400, 'Send the object body as base64.');
  const bytes = Buffer.from(body, 'base64');
  if (bytes.length > OBJECT_MAX_BYTES) throw new StorageError(413, `Objects can be at most ${OBJECT_MAX_BYTES / 1024 / 1024} MB.`);
  const meta = {};
  for (const [name, value] of Object.entries(customMetadata || {})) {
    if (!/^[a-z0-9-]{1,64}$/i.test(name) || typeof value !== 'string') throw new StorageError(400, 'customMetadata must map simple names to text.');
    meta[name] = value;
  }
  if (Buffer.byteLength(JSON.stringify(meta)) > 2000) throw new StorageError(400, 'customMetadata can be at most 2 KB.');
  const type = typeof contentType === 'string' && contentType.length < 200 ? contentType : 'application/octet-stream';
  const res = await s3.send(new PutObjectCommand({ Bucket: OBJECTS_BUCKET(), Key, Body: bytes, ContentType: type, Metadata: meta }));
  return describe(key, { ContentLength: bytes.length, ETag: res.ETag, LastModified: new Date(), ContentType: type, Metadata: meta });
}

export async function objectDelete(owner, bucket, keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).map((key) => objectKey(owner, bucket, key));
  if (list.length > 1000) throw new StorageError(400, 'Delete at most 1000 objects at a time.');
  if (list.length === 1) {
    await s3.send(new DeleteObjectCommand({ Bucket: OBJECTS_BUCKET(), Key: list[0] }));
    return;
  }
  await s3.send(new DeleteObjectsCommand({ Bucket: OBJECTS_BUCKET(), Delete: { Objects: list.map((Key) => ({ Key })), Quiet: true } }));
}

export async function objectList(owner, bucket, { prefix = '', limit = LIST_MAX, cursor, delimiter } = {}) {
  checkStore(bucket);
  const base = objectPrefix(owner, bucket);
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: OBJECTS_BUCKET(),
    Prefix: base + String(prefix || ''),
    MaxKeys: Math.max(1, Math.min(LIST_MAX, Number(limit) || LIST_MAX)),
    ContinuationToken: cursor || undefined,
    Delimiter: delimiter || undefined,
  }));
  return {
    objects: (res.Contents || []).map((item) => describe(item.Key.slice(base.length), item)),
    delimitedPrefixes: (res.CommonPrefixes || []).map((item) => item.Prefix.slice(base.length)),
    truncated: Boolean(res.IsTruncated),
    cursor: res.NextContinuationToken || undefined,
  };
}

// ---------------------------------------------------------------- one entry point for both callers

// op: kv.get | kv.put | kv.delete | kv.list | object.head | object.get | object.put | object.delete | object.list
export async function perform(owner, { op, store, key, value, keys, options = {} }) {
  switch (op) {
    case 'kv.get': return kvGet(owner, store, key);
    case 'kv.put': await kvPut(owner, store, key, value, options); return { ok: true };
    case 'kv.delete': await kvDelete(owner, store, key); return { ok: true };
    case 'kv.list': return kvList(owner, store, options);
    case 'object.head': return objectHead(owner, store, key);
    case 'object.get': return objectGet(owner, store, key);
    case 'object.put': return objectPut(owner, store, key, value, options);
    case 'object.delete': await objectDelete(owner, store, keys ?? key); return { ok: true };
    case 'object.list': return objectList(owner, store, options);
    default: throw new StorageError(400, `Unknown storage operation ${op}.`);
  }
}
