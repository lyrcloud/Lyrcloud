// The Lyrcloud Edge Functions runtime. The API copies this file into every function's package as
// __lyrcloud/runtime.mjs, and Lambda calls its handler with the request the router passes on (an API
// Gateway HTTP API event, payload format 2.0). It loads the customer's module (LYR_MAIN), which exports
//
//   export default { fetch(request, env, ctx) { return new Response('hi'); } }
//
// (or a bare function), hands it a standard Request and turns the Response it returns back into an
// API Gateway result. `env` holds the function's variables (LYR_VARS) and bindings (LYR_BINDINGS: KV
// namespaces, object buckets and the AI Gateway, which call the platform function with this function's token), and
// nothing from Lambda's own environment. ctx.waitUntil(promise) work finishes before the invocation ends.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let loaded;
function load() {
  const root = process.env.LAMBDA_TASK_ROOT || process.cwd();
  loaded ??= import(pathToFileURL(path.join(root, process.env.LYR_MAIN || 'index.js')).href);
  return loaded;
}

// ---------------------------------------------------------------- storage bindings

async function toBase64(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('base64');
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
  if (typeof Blob !== 'undefined' && value instanceof Blob) return Buffer.from(await value.arrayBuffer()).toString('base64');
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) return Buffer.from(await new Response(value).arrayBuffer()).toString('base64');
  throw new TypeError('Store text, an ArrayBuffer, a typed array, a Blob or a ReadableStream.');
}

function decode(base64, type = 'text') {
  const buf = Buffer.from(base64 || '', 'base64');
  if (type === 'text') return buf.toString('utf8');
  if (type === 'json') return JSON.parse(buf.toString('utf8'));
  if (type === 'arrayBuffer') return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (type === 'stream') return new Response(buf).body;
  throw new TypeError('type must be "text", "json", "arrayBuffer" or "stream".');
}

// env.MY_KV: get/getWithMetadata/put/delete/list, in the same shape as other edge platforms' KV.
export class KVNamespace {
  #call;
  #name;
  constructor(name, call) {
    this.#name = name;
    this.#call = call;
  }
  async get(key, options) {
    const found = await this.#call({ op: 'kv.get', store: this.#name, key: String(key) });
    return found ? decode(found.value, typeof options === 'string' ? options : options?.type) : null;
  }
  async getWithMetadata(key, options) {
    const found = await this.#call({ op: 'kv.get', store: this.#name, key: String(key) });
    return { value: found ? decode(found.value, typeof options === 'string' ? options : options?.type) : null, metadata: found?.metadata ?? null };
  }
  async put(key, value, options = {}) {
    const { expirationTtl, expiration, metadata } = options;
    await this.#call({ op: 'kv.put', store: this.#name, key: String(key), value: await toBase64(value), options: { expirationTtl, expiration, metadata } });
  }
  async delete(key) {
    await this.#call({ op: 'kv.delete', store: this.#name, key: String(key) });
  }
  list(options = {}) {
    const { prefix, limit, cursor } = options;
    return this.#call({ op: 'kv.list', store: this.#name, options: { prefix, limit, cursor } });
  }
}

function objectBody(found) {
  const { body, ...meta } = found;
  const bytes = () => Buffer.from(body || '', 'base64');
  return {
    ...meta,
    get body() { return new Response(bytes()).body; },
    async arrayBuffer() { const buf = bytes(); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
    async text() { return bytes().toString('utf8'); },
    async json() { return JSON.parse(bytes().toString('utf8')); },
    async blob() { return new Blob([bytes()], { type: meta.httpMetadata?.contentType }); },
    writeHttpMetadata(headers) {
      if (meta.httpMetadata?.contentType) headers.set('content-type', meta.httpMetadata.contentType);
      if (meta.etag) headers.set('etag', `"${meta.etag}"`);
    },
  };
}

// env.MY_BUCKET: head/get/put/delete/list for files (objects).
export class Bucket {
  #call;
  #name;
  constructor(name, call) {
    this.#name = name;
    this.#call = call;
  }
  head(key) {
    return this.#call({ op: 'object.head', store: this.#name, key: String(key) });
  }
  async get(key) {
    const found = await this.#call({ op: 'object.get', store: this.#name, key: String(key) });
    return found ? objectBody(found) : null;
  }
  async put(key, value, options = {}) {
    let contentType = options.httpMetadata?.contentType;
    if (typeof Headers !== 'undefined' && options.httpMetadata instanceof Headers) contentType = options.httpMetadata.get('content-type');
    if (!contentType && typeof Blob !== 'undefined' && value instanceof Blob && value.type) contentType = value.type;
    if (!contentType && typeof value === 'string') contentType = 'text/plain; charset=utf-8';
    return this.#call({ op: 'object.put', store: this.#name, key: String(key), value: await toBase64(value), options: { contentType, customMetadata: options.customMetadata } });
  }
  async delete(keys) {
    await this.#call({ op: 'object.delete', store: this.#name, keys: Array.isArray(keys) ? keys.map(String) : String(keys) });
  }
  list(options = {}) {
    const { prefix, limit, cursor, delimiter } = options;
    return this.#call({ op: 'object.list', store: this.#name, options: { prefix, limit, cursor, delimiter } });
  }
}

// env.AI: chat models and embeddings through the Lyrcloud AI Gateway.
//   await env.AI.run('claude-haiku-4.5', { prompt: 'Hi' })   -> { response, usage, model, cached }
//   await env.AI.run('claude-sonnet-4.6', { messages, system, max_tokens }, { cache: 3600 })
//   await env.AI.embed('titan-embed-v2', ['text', ...])      -> { data: [[...]], dimensions }
export class AI {
  #call;
  constructor(call) {
    this.#call = call;
  }
  run(model, input, options = {}) {
    if (typeof model === 'object' && model !== null) return this.#call({ op: 'ai.run', model: undefined, input: model, options: input || {} });
    return this.#call({ op: 'ai.run', model, input, options });
  }
  embed(model, input, options = {}) {
    if (Array.isArray(model) || (typeof model === 'string' && input === undefined)) return this.#call({ op: 'ai.embed', model: undefined, input: model, options: {} });
    return this.#call({ op: 'ai.embed', model, input, options });
  }
  models() {
    return this.#call({ op: 'ai.models' });
  }
}

// Builds `env`: the variables plus one binding object per entry in `bindings` ([{ binding, type, name }]).
export function makeEnv(vars, bindings, call) {
  const env = { ...vars };
  for (const { binding, type, name } of bindings || []) {
    env[binding] = type === 'kv' ? new KVNamespace(name, call) : type === 'ai' ? new AI(call) : new Bucket(name, call);
  }
  return Object.freeze(env);
}

// In Lambda, bindings invoke the platform function with this function's token.
let lambdaClient;
async function platformCall(request) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  lambdaClient ??= new LambdaClient({});
  const res = await lambdaClient.send(new InvokeCommand({
    FunctionName: process.env.LYR_PLATFORM,
    Payload: Buffer.from(JSON.stringify({ ...request, token: process.env.LYR_TOKEN })),
  }));
  const out = JSON.parse(Buffer.from(res.Payload || []).toString('utf8') || '{}');
  if (res.FunctionError || !out.ok) throw new Error(out.error || out.errorMessage || 'Lyrcloud Storage call failed.');
  return out.result;
}

let env;
const envOf = () => (env ??= makeEnv(JSON.parse(process.env.LYR_VARS || '{}'), JSON.parse(process.env.LYR_BINDINGS || '[]'), platformCall));

export function toRequest(event) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers || {})) {
    if (value !== undefined && value !== null) headers.set(name, String(value));
  }
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));
  const host = headers.get('host') || event.requestContext?.domainName || 'localhost';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const method = (event.requestContext?.http?.method || 'GET').toUpperCase();
  const hasBody = event.body !== undefined && event.body !== null && event.body !== '' && method !== 'GET' && method !== 'HEAD';
  const request = new Request(`https://${host}${event.rawPath || '/'}${query}`, {
    method,
    headers,
    body: hasBody ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined,
    duplex: 'half',
  });
  // Lyrcloud's .lyr addresses are served without a CDN in front, so only the visitor's IP is known.
  Object.defineProperty(request, 'geo', {
    value: Object.freeze({ ip: event.requestContext?.http?.sourceIp || null, city: null, region: null, country: null }),
    enumerable: true,
  });
  return request;
}

export async function toResult(response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const body = Buffer.from(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers,
    ...(cookies.length ? { cookies } : {}),
    body: body.toString('base64'),
    isBase64Encoded: true,
  };
}

const plain = (statusCode, text) => ({ statusCode, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text });

// `envOverride` lets `lyrcloud dev` pass bindings backed by local files.
export async function run(mod, event, envOverride) {
  const app = mod.default ?? mod;
  const fetch = typeof app === 'function' ? app : app?.fetch;
  if (typeof fetch !== 'function') {
    console.error('Your entry file must export default { fetch(request, env, ctx) { ... } }.');
    return plain(500, 'This function has no fetch handler. Export default { fetch(request) { ... } } from your entry file.');
  }
  const pending = [];
  const ctx = {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise).catch((err) => console.error('waitUntil task failed:', err)));
    },
    passThroughOnException() {},
  };
  let response;
  try {
    response = await fetch.call(app, toRequest(event), envOverride || envOf(), ctx);
  } catch (err) {
    console.error('Uncaught error in fetch:', err);
    response = null;
  }
  let result;
  if (response instanceof Response) {
    result = await toResult(response);
  } else {
    if (response !== null) console.error('fetch must return a Response, but it returned', typeof response);
    result = plain(500, 'This function failed. Its owner can see why with `lyrcloud logs`.');
  }
  await Promise.all(pending);
  return result;
}

export const handler = async (event) => {
  let mod;
  try {
    mod = await load();
  } catch (err) {
    loaded = undefined;
    console.error('Couldn’t load your entry file:', err);
    return plain(500, 'This function couldn’t start. Its owner can see why with `lyrcloud logs`.');
  }
  return run(mod, event);
};
