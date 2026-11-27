// Lyrcloud Application Security: rules, and enforcement in the router with AWS faked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

Object.assign(process.env, { FUNCTIONS_TABLE: 'functions', DATA_TABLE_NAME: 'data', FUNCTIONS_DOMAIN: 'dev.lyr', PLATFORM_SECRET: 'test-secret' });
const sec = await import('./security.mjs');
const router = await import('./router.mjs');

let items;
let invoked;
let security;

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const { input } = command;
  const name = command.constructor.name;
  const k = (key) => `${input.TableName}|${key.pk}|${key.sk}`;
  if (name === 'GetCommand') return { Item: input.TableName === 'functions' ? { ownerId: 'owner', security } : structuredClone(items.get(k(input.Key))) };
  if (name === 'PutCommand') { items.set(k(input.Item), structuredClone(input.Item)); return {}; }
  if (name === 'UpdateCommand') {
    const item = items.get(k(input.Key)) || { ...input.Key, count: 0 };
    item.count += 1;
    items.set(k(input.Key), item);
    return { Attributes: { count: item.count } };
  }
  throw new Error(`unexpected ${name}`);
};
LambdaClient.prototype.send = async function send(command) {
  invoked.push(JSON.parse(Buffer.from(command.input.Payload).toString()));
  return { Payload: Buffer.from(JSON.stringify({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'ran' })) };
};

beforeEach(() => {
  items = new Map();
  invoked = [];
  router.clearPolicies();
});

const set = (config) => {
  const [clean, problem] = sec.cleanSecurity(config);
  assert.equal(problem, null);
  security = clean;
  router.clearPolicies();
};
const visit = (path, { ip = '198.51.100.10', ua = 'Mozilla/5.0', method = 'GET', query = '', cookies, body, type } = {}) => router.handler({
  rawPath: path, rawQueryString: query, cookies, body,
  headers: { host: 'shop.dev.lyr', 'user-agent': ua, ...(type ? { 'content-type': type } : {}) },
  requestContext: { domainName: 'shop.dev.lyr', http: { method, sourceIp: ip } },
});
const events = () => [...items.values()].filter((item) => item.pk === 'sec#owner#shop').map((item) => `${item.action}:${item.rule}`).sort();

test('settings from lyrcloud.json', () => {
  const [clean] = sec.cleanSecurity({ rateLimits: [{ path: '/api/*', requests: 5, per: '10s' }], blockIps: ['203.0.113.0/24', '2001:db8::/32'], waf: 'log', bots: 'challenge', headers: true });
  assert.deepEqual(clean.rateLimits, [{ path: '/api/', requests: 5, seconds: 10 }]);
  assert.deepEqual(clean.bots, { mode: 'challenge', paths: [] });
  assert.match(sec.cleanSecurity({ blockIps: ['999.1.1.1'] })[1], /isn’t an IP/);
  assert.match(sec.cleanSecurity({ rateLimits: [{ requests: 0 }] })[1], /whole number/);
  assert.match(sec.cleanSecurity({ rateLimits: [{ requests: 5, per: '1d' }] })[1], /per must be/);
  assert.match(sec.cleanSecurity({ waf: 'yes' })[1], /waf must be/);
  assert.match(sec.cleanSecurity({ countries: ['XX'] })[1], /aren’t available yet/);
});

test('IP matching handles single addresses and CIDR ranges in both families', () => {
  assert.equal(sec.ipMatches(['203.0.113.0/24'], '203.0.113.77'), true);
  assert.equal(sec.ipMatches(['203.0.113.0/24'], '203.0.114.1'), false);
  assert.equal(sec.ipMatches(['198.51.100.7'], '198.51.100.7'), true);
  assert.equal(sec.ipMatches(['2001:db8::/32'], '2001:db8:1::5'), true);
  assert.equal(sec.ipMatches(['2001:db8::/32'], '2001:db9::5'), false);
  assert.equal(sec.ipMatches([], '1.2.3.4'), false);
});

test('WAF patterns catch attacks and leave ordinary requests alone', () => {
  const hit = (rawPath, rawQueryString = '', body, type) => sec.wafMatch({ rawPath, rawQueryString, body, headers: type ? { 'content-type': type } : {} });
  assert.equal(hit('/products', 'q=red+shoes&page=2'), null);
  assert.equal(hit('/blog/union-station-review'), null);
  assert.equal(hit('/search', 'q=select%20a%20size'), null);
  assert.equal(hit('/files/../../etc/passwd'), 'path-traversal');
  assert.equal(hit('/x', 'file=%2e%2e%2f%2e%2e%2fetc%2fpasswd'), 'path-traversal');
  assert.equal(hit('/.env'), 'sensitive-file');
  assert.equal(hit('/item', "id=1%27%20UNION%20SELECT%20password%20FROM%20users"), 'sql-injection');
  assert.equal(hit('/login', '', 'user=admin&pass=%27+or+%271%27%3D%271', 'application/x-www-form-urlencoded'), 'sql-injection');
  assert.equal(hit('/c', 'msg=%3Cscript%3Ealert(1)%3C/script%3E'), 'xss');
  assert.equal(hit('/c', '', JSON.stringify({ name: '${jndi:ldap://x/a}' }), 'application/json'), 'log4shell');
  assert.equal(hit('/ping', 'host=1.1.1.1;cat%20/etc/hosts'), 'command-injection');
});

test('automation user agents and the proof of work', () => {
  assert.equal(sec.looksAutomated('curl/8.5.0'), true);
  assert.equal(sec.looksAutomated('python-requests/2.31'), true);
  assert.equal(sec.looksAutomated(''), true);
  assert.equal(sec.looksAutomated('Mozilla/5.0 (Macintosh) Safari/605.1.15'), false);
  assert.equal(sec.leadingZeroBits(Buffer.from([0, 0x0f])), 12);
  assert.equal(sec.solves('n', 'not-a-solution', 30), false);
});

test('block and allow lists', async () => {
  set({ blockIps: ['203.0.113.0/24'] });
  assert.equal((await visit('/', { ip: '203.0.113.9' })).statusCode, 403);
  assert.equal((await visit('/', { ip: '198.51.100.1' })).body, 'ran');
  set({ allowIps: ['198.51.100.0/28'] });
  assert.equal((await visit('/', { ip: '198.51.100.20' })).statusCode, 403);
  assert.equal((await visit('/', { ip: '198.51.100.3' })).statusCode, 200);
  assert.deepEqual(events(), ['block:ip-allow-list', 'block:ip-block-list']);
});

test('WAF in block mode stops the request; in log mode it only records it', async () => {
  set({ waf: 'block' });
  assert.equal((await visit('/item', { query: 'id=1%20union%20select%201' })).statusCode, 403);
  assert.equal(invoked.length, 0);
  set({ waf: 'log' });
  assert.equal((await visit('/item', { query: 'id=1%20union%20select%201' })).statusCode, 200);
  assert.deepEqual(events(), ['block:waf:sql-injection', 'log:waf:sql-injection']);
});

test('rate limits count per IP and path, and answer 429 with Retry-After', async () => {
  set({ rateLimits: [{ path: '/api', requests: 2, per: '1m' }] });
  assert.equal((await visit('/api/a')).statusCode, 200);
  assert.equal((await visit('/api/b')).statusCode, 200);
  const third = await visit('/api/c');
  assert.equal(third.statusCode, 429);
  assert.ok(Number(third.headers['retry-after']) >= 1);
  assert.equal((await visit('/api/a', { ip: '198.51.100.99' })).statusCode, 200); // another visitor
  assert.equal((await visit('/home')).statusCode, 200); // another path
});

test('bot blocking refuses automation tools on chosen paths', async () => {
  set({ bots: { mode: 'block', paths: ['/login'] } });
  assert.equal((await visit('/login', { ua: 'python-requests/2.31' })).statusCode, 403);
  assert.equal((await visit('/login')).statusCode, 200);
  assert.equal((await visit('/', { ua: 'curl/8' })).statusCode, 200);
});

test('the browser challenge: page, solved answer, cookie, then through', async () => {
  set({ bots: 'challenge' });
  const first = await visit('/shop', { query: 'a=1' });
  assert.equal(first.statusCode, 403);
  assert.match(first.body, /Checking your browser/);
  assert.equal(invoked.length, 0);
  const { token, nonce, bits } = JSON.parse(first.body.match(/const c = (\{.*?\});/)[1]);
  let answer = 0;
  while (sec.leadingZeroBits(createHash('sha256').update(`${nonce}:${answer}`).digest()) < bits) answer += 1;
  assert.equal((await visit('/__lyrcloud/challenge', { query: `token=${encodeURIComponent(token)}&answer=${answer + 1}0000` })).statusCode, 403);
  const passed = await visit('/__lyrcloud/challenge', { query: `token=${encodeURIComponent(token)}&answer=${answer}` });
  assert.equal(passed.statusCode, 302);
  assert.equal(passed.headers.location, '/shop?a=1');
  const cookie = passed.cookies[0].split(';')[0];
  assert.equal((await visit('/shop', { cookies: [cookie] })).body, 'ran');
  assert.equal((await visit('/api', { method: 'POST' })).statusCode, 403);
});

test('secure headers are added without overriding the function’s own', async () => {
  set({ headers: true });
  const res = await visit('/');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['strict-transport-security'], /max-age=31536000/);
  assert.equal(res.headers['content-type'], 'text/plain');
  set({});
  assert.equal((await visit('/')).headers['x-frame-options'], undefined);
});
