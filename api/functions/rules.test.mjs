// Edge Functions: zip helper, rules, runtime and router.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import {
  archiveError, certNeedsRenewal, cleanVars, functionNameError, mainError, nameFromHost, parseSince,
} from './rules.mjs';
import { run, toRequest } from './runtime.mjs';
import { addZipEntry, createZip, crc32, listZip, ZipError } from './zip.mjs';

test('the CLI ships the same zip helper and runtime as the API', () => {
  for (const file of ['zip.mjs', 'runtime.mjs']) {
    const api = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const cli = readFileSync(new URL(`../../cli/lib/${file}`, import.meta.url), 'utf8');
    assert.equal(cli, api, `cli/lib/${file} must be a copy of api/functions/${file}`);
  }
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zips round-trip through the system unzip, including an appended entry', () => {
  const big = 'hello world\n'.repeat(500);
  let zip = createZip([{ name: 'index.js', data: 'export default {}' }, { name: 'lib/big.txt', data: big }, { name: 'tiny', data: '' }]);
  zip = addZipEntry(zip, '__lyrcloud/runtime.mjs', 'export const handler = 1;');
  assert.deepEqual(listZip(zip).map((e) => e.name), ['index.js', 'lib/big.txt', 'tiny', '__lyrcloud/runtime.mjs']);
  const dir = mkdtempSync(path.join(tmpdir(), 'lyrzip-'));
  const file = path.join(dir, 'a.zip');
  writeFileSync(file, zip);
  try {
    execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', file, path.join(dir, 'out')]);
  } catch (err) {
    if (err.code === 'ENOENT') return; // no python here; listZip above still checked the structure
    throw err;
  }
  assert.equal(readFileSync(path.join(dir, 'out/lib/big.txt'), 'utf8'), big);
  assert.equal(readFileSync(path.join(dir, 'out/__lyrcloud/runtime.mjs'), 'utf8'), 'export const handler = 1;');
});

test('listZip refuses things that are not zips', () => {
  assert.throws(() => listZip(Buffer.from('not a zip at all, sorry about that')), ZipError);
});

test('function names', () => {
  assert.equal(functionNameError('hello-edge'), null);
  assert.equal(functionNameError('a'), null);
  assert.match(functionNameError('Hello'), /lowercase/);
  assert.match(functionNameError('-x'), /lowercase/);
  assert.match(functionNameError('x'.repeat(41)), /1–40/);
  assert.match(functionNameError('ab--c'), /two hyphens/);
  assert.match(functionNameError('www'), /reserved/);
});

test('entry files and archives', () => {
  assert.equal(mainError('index.js'), null);
  assert.equal(mainError('src/worker.mjs'), null);
  assert.match(mainError('../x.js'), /inside your project/);
  assert.match(mainError('index.ts'), /JavaScript/);
  assert.equal(archiveError([{ name: 'index.js', size: 10 }], 'index.js'), null);
  assert.match(archiveError([{ name: 'other.js', size: 10 }], 'index.js'), /isn’t in the upload/);
  assert.match(archiveError([{ name: '../evil', size: 1 }, { name: 'index.js', size: 1 }], 'index.js'), /safe path/);
  assert.match(archiveError([{ name: '__lyrcloud/x', size: 1 }, { name: 'index.js', size: 1 }], 'index.js'), /kept for Lyrcloud/);
});

test('variables', () => {
  assert.deepEqual(cleanVars(undefined), [{}, null]);
  assert.deepEqual(cleanVars({ GREETING: 'hi' }), [{ GREETING: 'hi' }, null]);
  assert.match(cleanVars({ 'bad-name': 'x' })[1], /valid variable/);
  assert.match(cleanVars({ N: 1 })[1], /text/);
  assert.match(cleanVars({ BIG: 'x'.repeat(4000) })[1], /bytes/);
});

test('hosts, since and certificate renewal', () => {
  assert.equal(nameFromHost('hello.dev.lyr'), 'hello');
  assert.equal(nameFromHost('HELLO.dev.lyr.'), 'hello');
  assert.equal(nameFromHost('a.b.dev.lyr'), null);
  assert.equal(nameFromHost('dev.lyr'), null);
  assert.equal(nameFromHost('hello.example.com'), null);
  assert.equal(parseSince('2h', 10_000_000), 10_000_000 - 7_200_000);
  assert.equal(parseSince('nonsense'), null);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(certNeedsRenewal(null, now), true);
  assert.equal(certNeedsRenewal({ arn: 'a', notAfter: '2026-03-01T00:00:00Z' }, now), false);
  assert.equal(certNeedsRenewal({ arn: 'a', notAfter: '2026-01-20T00:00:00Z' }, now), true);
});

const event = (over = {}) => ({
  rawPath: '/greet',
  rawQueryString: 'who=you',
  headers: { host: 'hello.dev.lyr', 'content-type': 'text/plain' },
  cookies: ['a=1', 'b=2'],
  requestContext: { domainName: 'hello.dev.lyr', http: { method: 'POST', sourceIp: '203.0.113.9' } },
  body: Buffer.from('ping').toString('base64'),
  isBase64Encoded: true,
  ...over,
});

test('runtime builds a standard Request', async () => {
  const request = toRequest(event());
  assert.equal(request.url, 'https://hello.dev.lyr/greet?who=you');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('cookie'), 'a=1; b=2');
  assert.equal(await request.text(), 'ping');
  assert.equal(request.geo.ip, '203.0.113.9');
});

test('runtime runs fetch, passes vars and waits for waitUntil work', async () => {
  process.env.LYR_VARS = JSON.stringify({ GREETING: 'Hi' });
  let waited = false;
  const mod = {
    default: {
      async fetch(request, env, ctx) {
        ctx.waitUntil(new Promise((resolve) => setTimeout(() => { waited = true; resolve(); }, 10)));
        const headers = new Headers({ 'content-type': 'text/plain' });
        headers.append('set-cookie', 'x=1');
        headers.append('set-cookie', 'y=2');
        return new Response(`${env.GREETING} ${await request.text()}`, { status: 201, headers });
      },
    },
  };
  const result = await run(mod, event());
  assert.equal(result.statusCode, 201);
  assert.equal(Buffer.from(result.body, 'base64').toString(), 'Hi ping');
  assert.deepEqual(result.cookies, ['x=1', 'y=2']);
  assert.equal(result.headers['content-type'], 'text/plain');
  assert.equal(waited, true);
});

test('runtime turns mistakes into a 500 page', async () => {
  assert.equal((await run({ default: {} }, event())).statusCode, 500);
  assert.equal((await run({ default: { fetch() { throw new Error('boom'); } } }, event())).statusCode, 500);
  assert.equal((await run({ default: { fetch: () => 'text' } }, event())).statusCode, 500);
  assert.equal((await run({ default: () => new Response('bare') }, event())).statusCode, 200);
});

test('router invokes lyrfn-<name> and maps failures', async () => {
  const { handler } = await import('./router.mjs');
  const calls = [];
  let reply;
  LambdaClient.prototype.send = async function send(command) {
    calls.push(command.input.FunctionName);
    return reply();
  };
  reply = () => ({ Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: 'ok' })) });
  assert.deepEqual(await handler(event()), { statusCode: 200, body: 'ok' });
  assert.deepEqual(calls, ['lyrfn-hello']);
  reply = () => { throw Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }); };
  assert.equal((await handler(event())).statusCode, 404);
  reply = () => ({ FunctionError: 'Unhandled', Payload: Buffer.from('{"errorMessage":"Task timed out after 15.00 seconds"}') });
  assert.equal((await handler(event())).statusCode, 504);
  assert.equal((await handler(event({ requestContext: { domainName: 'x.example.com', http: { method: 'GET' } }, headers: {} }))).statusCode, 404);
});
