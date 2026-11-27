// `lyrcloud dev` runs this in a child process (restarted when files change). It serves the project on
// localhost through runtime.mjs, the same runtime deployed functions use (an identical copy of
// api/functions/runtime.mjs), by turning each request into the event API Gateway would send.
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProject } from './project.mjs';
import { api } from './api.mjs';
import { bindingsOf, localStorage } from './local-storage.mjs';
import { makeEnv, run } from './runtime.mjs';

// Same rule as api/functions/access.mjs isProtected: every path, or paths under the listed prefixes.
function isProtected(access, path) {
  if (!access) return false;
  const paths = (access.paths || []).map((p) => String(p).replace(/\*+$/, ''));
  if (!paths.length) return true;
  return paths.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || (prefix.endsWith('/') && path === prefix.slice(0, -1)));
}

const [root, portText] = process.argv.slice(2);
const { config } = loadProject(root);
// Static assets are served by the runtime from LYR_ROOT, as in production.
process.env.LYR_ROOT = root;
if (config.assets) process.env.LYR_ASSETS = JSON.stringify(typeof config.assets === 'string' ? { dir: config.assets } : config.assets);
// KV namespaces and buckets are kept in .lyrcloud/storage/ while developing. AI calls go to the real
// Lyrcloud AI Gateway as you (there's no local model), and count against your plan.
const local = localStorage(root);
const call = (request) => {
  if (request.op === 'ai.models') return api('GET', '/ai/models').then((out) => out.models);
  if (request.op === 'ai.run' || request.op === 'ai.embed') {
    return api('POST', request.op === 'ai.run' ? '/ai/run' : '/ai/embed', { body: { model: request.model, input: request.input, options: request.options } });
  }
  return local(request);
};
const env = makeEnv(config.vars || {}, bindingsOf(config), call);

let mod;
let loadError = null;
try {
  mod = config.main ? await import(pathToFileURL(path.join(root, config.main)).href) : null;
} catch (err) {
  loadError = err;
  console.error(`Couldn’t load ${config.main}:`, err);
}

function toEvent(req, body, port) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  const cookies = headers.cookie ? headers.cookie.split(/;\s*/) : undefined;
  delete headers.cookie;
  headers.host = `${config.name || 'localhost'}.dev.lyr`;
  // Lyrcloud Access: locally, protected paths act as if you'd signed in (LYRCLOUD_DEV_EMAIL, or dev@localhost).
  for (const name of Object.keys(headers)) if (name.startsWith('lyr-access-')) delete headers[name];
  if (isProtected(config.access, url.pathname)) headers['lyr-access-email'] = process.env.LYRCLOUD_DEV_EMAIL || 'dev@localhost';
  return {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    cookies,
    requestContext: { domainName: headers.host, http: { method: req.method, path: url.pathname, sourceIp: req.socket.remoteAddress } },
    body: body.length ? body.toString('base64') : undefined,
    isBase64Encoded: body.length > 0,
  };
}

const port = Number(portText);
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const started = Date.now();
  let result;
  if (loadError) {
    result = { statusCode: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `Couldn’t load ${config.main}:\n\n${loadError.stack || loadError}` };
  } else {
    result = await run(mod, toEvent(req, Buffer.concat(chunks), port), env);
  }
  const headers = { ...result.headers };
  if (result.cookies?.length) headers['set-cookie'] = result.cookies;
  res.writeHead(result.statusCode, headers);
  res.end(result.isBase64Encoded ? Buffer.from(result.body || '', 'base64') : result.body || '');
  const status = result.statusCode >= 500 ? `\x1b[31m${result.statusCode}\x1b[0m` : result.statusCode >= 400 ? `\x1b[33m${result.statusCode}\x1b[0m` : result.statusCode;
  console.log(`${req.method} ${req.url} ${status} ${Date.now() - started}ms`);
});
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Try lyrcloud dev --port ${port + 1}.` : err.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => process.send?.({ ready: true }));
