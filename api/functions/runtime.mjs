// The Lyrcloud Edge Functions runtime. The API copies this file into every function's package as
// __lyrcloud/runtime.mjs, and Lambda calls its handler with the request the router passes on (an API
// Gateway HTTP API event, payload format 2.0). It loads the customer's module (LYR_MAIN), which exports
//
//   export default { fetch(request, env, ctx) { return new Response('hi'); } }
//
// (or a bare function), hands it a standard Request and turns the Response it returns back into an
// API Gateway result. `env` holds the function's variables (LYR_VARS) and nothing from Lambda's own
// environment, and ctx.waitUntil(promise) work finishes before the invocation ends.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let loaded;
function load() {
  const root = process.env.LAMBDA_TASK_ROOT || process.cwd();
  loaded ??= import(pathToFileURL(path.join(root, process.env.LYR_MAIN || 'index.js')).href);
  return loaded;
}

let vars;
const varsOf = () => (vars ??= Object.freeze(JSON.parse(process.env.LYR_VARS || '{}')));

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

export async function run(mod, event) {
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
    response = await fetch.call(app, toRequest(event), varsOf(), ctx);
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
