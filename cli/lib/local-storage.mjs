// Storage for `lyrcloud dev`: the same operations as Lyrcloud Storage (api/functions/storage.mjs), kept in
// files under .lyrcloud/storage/ in your project, so env.MY_KV and env.MY_BUCKET work offline.
//   .lyrcloud/storage/kv/<namespace>.json          { key: { value: base64, metadata, expiresAt } }
//   .lyrcloud/storage/buckets/<bucket>/<key>       the object's bytes
//   .lyrcloud/storage/buckets/<bucket>.meta.json   { key: { contentType, customMetadata, uploaded } }
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KV_MAX_VALUE_BYTES = 256 * 1024;
const OBJECT_MAX_BYTES = 4 * 1024 * 1024;

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const writeJson = (file, data) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};
const safeName = (name) => {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error('Namespace and bucket names use 1–63 lowercase letters, digits and hyphens.');
  return name;
};
const now = () => Math.floor(Date.now() / 1000);

export function localStorage(root) {
  const base = path.join(root, '.lyrcloud', 'storage');
  const kvFile = (ns) => path.join(base, 'kv', `${safeName(ns)}.json`);
  const bucketDir = (b) => path.join(base, 'buckets', safeName(b));
  const metaFile = (b) => path.join(base, 'buckets', `${safeName(b)}.meta.json`);
  const objectFile = (b, key) => {
    const file = path.resolve(bucketDir(b), key);
    if (!file.startsWith(path.resolve(bucketDir(b)) + path.sep)) throw new Error(`“${key}” isn’t a safe object key here.`);
    return file;
  };
  const describe = (b, key, meta = {}) => {
    const file = objectFile(b, key);
    const bytes = readFileSync(file);
    return {
      key,
      size: bytes.length,
      etag: createHash('md5').update(bytes).digest('hex'),
      uploaded: meta.uploaded || statSync(file).mtime.toISOString(),
      httpMetadata: { contentType: meta.contentType || 'application/octet-stream' },
      customMetadata: meta.customMetadata || {},
    };
  };
  const allKeys = (b) => Object.keys(readJson(metaFile(b))).filter((key) => existsSync(objectFile(b, key))).sort();

  return async function call({ op, store, key, keys, value, options = {} }) {
    switch (op) {
      case 'kv.get': {
        const item = readJson(kvFile(store))[key];
        if (!item || (item.expiresAt && item.expiresAt <= now())) return null;
        return { value: item.value, metadata: item.metadata ?? null, expiration: item.expiresAt || null };
      }
      case 'kv.put': {
        if (Buffer.from(value, 'base64').length > KV_MAX_VALUE_BYTES) throw new Error('Values can be at most 256 KB.');
        if (options.expirationTtl !== undefined && options.expirationTtl !== null && Number(options.expirationTtl) < 60) throw new Error('expirationTtl must be at least 60 seconds.');
        const data = readJson(kvFile(store));
        const expiresAt = options.expirationTtl ? now() + Math.floor(Number(options.expirationTtl)) : options.expiration ? Math.floor(Number(options.expiration)) : undefined;
        data[key] = { value, metadata: options.metadata ?? undefined, expiresAt };
        writeJson(kvFile(store), data);
        return { ok: true };
      }
      case 'kv.delete': {
        const data = readJson(kvFile(store));
        delete data[key];
        writeJson(kvFile(store), data);
        return { ok: true };
      }
      case 'kv.list': {
        const data = readJson(kvFile(store));
        const names = Object.keys(data).filter((name) => name.startsWith(options.prefix || '') && !(data[name].expiresAt && data[name].expiresAt <= now())).sort();
        const start = options.cursor ? Number(Buffer.from(options.cursor, 'base64url').toString()) : 0;
        const limit = Math.min(1000, Number(options.limit) || 1000);
        const page = names.slice(start, start + limit);
        const more = start + limit < names.length;
        return {
          keys: page.map((name) => ({ name, expiration: data[name].expiresAt, metadata: data[name].metadata })),
          list_complete: !more,
          cursor: more ? Buffer.from(String(start + limit)).toString('base64url') : undefined,
        };
      }
      case 'object.head': {
        const meta = readJson(metaFile(store))[key];
        return meta && existsSync(objectFile(store, key)) ? describe(store, key, meta) : null;
      }
      case 'object.get': {
        const meta = readJson(metaFile(store))[key];
        if (!meta || !existsSync(objectFile(store, key))) return null;
        return { ...describe(store, key, meta), body: readFileSync(objectFile(store, key)).toString('base64') };
      }
      case 'object.put': {
        const bytes = Buffer.from(value, 'base64');
        if (bytes.length > OBJECT_MAX_BYTES) throw new Error('Objects can be at most 4 MB.');
        const file = objectFile(store, key);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        const all = readJson(metaFile(store));
        all[key] = { contentType: options.contentType || 'application/octet-stream', customMetadata: options.customMetadata || {}, uploaded: new Date().toISOString() };
        writeJson(metaFile(store), all);
        return describe(store, key, all[key]);
      }
      case 'object.delete': {
        const all = readJson(metaFile(store));
        for (const one of Array.isArray(keys ?? key) ? keys : [keys ?? key]) {
          rmSync(objectFile(store, one), { force: true });
          delete all[one];
        }
        writeJson(metaFile(store), all);
        return { ok: true };
      }
      case 'object.list': {
        const meta = readJson(metaFile(store));
        const prefix = options.prefix || '';
        const matching = allKeys(store).filter((name) => name.startsWith(prefix));
        const objects = [];
        const prefixes = new Set();
        for (const name of matching) {
          const rest = name.slice(prefix.length);
          const cut = options.delimiter ? rest.indexOf(options.delimiter) : -1;
          if (cut !== -1) prefixes.add(prefix + rest.slice(0, cut + options.delimiter.length));
          else objects.push(describe(store, name, meta[name]));
        }
        return { objects, delimitedPrefixes: [...prefixes], truncated: false, cursor: undefined };
      }
      default:
        throw new Error(`Unknown storage operation ${op}.`);
    }
  };
}

// lyrcloud.json "ai" / "kv" / "buckets" -> [{ binding, type, name }].
export function bindingsOf(config) {
  const out = [];
  if (typeof config.ai === 'string') out.push({ binding: config.ai, type: 'ai', name: 'ai' });
  for (const [binding, name] of Object.entries(config.kv || {})) out.push({ binding, type: 'kv', name });
  for (const [binding, name] of Object.entries(config.buckets || {})) out.push({ binding, type: 'bucket', name });
  return out;
}
