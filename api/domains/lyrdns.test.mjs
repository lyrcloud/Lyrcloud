import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readResponse, wireQuery } from './dns-test-helpers.mjs';
import { answerLyr, buildResponse, cleanLyrName, DnsFormatError, ipv6Bytes, isReservedLyr, parseQuery, RCODE, registeredLyrName } from './lyrdns.mjs';

const SHOP = {
  name: 'shop.lyr',
  records: [
    { type: 'A', name: 'shop.lyr', values: ['203.0.113.10', '203.0.113.11'], ttl: 300 },
    { type: 'AAAA', name: 'shop.lyr', values: ['2001:db8::1'], ttl: 300 },
    { type: 'TXT', name: 'shop.lyr', values: ['hello from .lyr'], ttl: 120 },
    { type: 'MX', name: 'shop.lyr', values: ['10 mail.example.com'], ttl: 300 },
    { type: 'CNAME', name: 'www.shop.lyr', values: ['shop.example.net'], ttl: 300 },
    { type: 'CNAME', name: 'app.shop.lyr', values: ['shop.lyr'], ttl: 300 },
    { type: 'A', name: '*.shop.lyr', values: ['203.0.113.99'], ttl: 60 },
    { type: 'A', name: 'deep.api.shop.lyr', values: ['203.0.113.50'], ttl: 60 },
  ],
};
const chase = async (target, type) => (target === 'shop.example.net' && type === 'A' ? [{ name: target, type: 'A', ttl: 30, value: '198.51.100.7' }] : []);
const lookup = async (name) => (name === 'shop.lyr' ? SHOP : null);
const resolve = async (name, type = 'A') => {
  const query = parseQuery(wireQuery(name, type));
  return readResponse(buildResponse(query, await answerLyr(query, await lookup(registeredLyrName(query.qname)), chase, lookup)));
};

test('.lyr names are cleaned, and some are reserved', () => {
  assert.equal(cleanLyrName('Shop'), 'shop.lyr');
  assert.equal(cleanLyrName('shop.LYR.'), 'shop.lyr');
  assert.equal(cleanLyrName('a.b.lyr'), null);
  assert.equal(cleanLyrName('-x'), null);
  assert.equal(cleanLyrName('ab--c'), null);
  assert.equal(isReservedLyr('nic.lyr'), true);
  assert.equal(isReservedLyr('shop.lyr'), false);
  assert.equal(registeredLyrName('www.shop.lyr'), 'shop.lyr');
  assert.equal(registeredLyrName('lyr'), null);
  assert.equal(registeredLyrName('shop.com'), null);
});

test('queries are parsed, including the id, recursion flag and question', () => {
  const query = parseQuery(wireQuery('WWW.Shop.lyr', 'AAAA', 7));
  assert.deepEqual([query.id, query.rd, query.qname, query.qtype, query.qclass], [7, true, 'www.shop.lyr', 28, 1]);
  assert.throws(() => parseQuery(Buffer.from([1, 2, 3])), DnsFormatError);
  const response = Buffer.from(wireQuery('x.lyr'));
  response[2] |= 0x80;
  assert.throws(() => parseQuery(response), DnsFormatError);
  const loop = Buffer.concat([wireQuery('x.lyr').subarray(0, 12), Buffer.from([0xc0, 12, 0, 1, 0, 1])]);
  assert.throws(() => parseQuery(loop), DnsFormatError);
});

test('IPv6 addresses are encoded', () => {
  assert.equal(ipv6Bytes('2001:db8::1').toString('hex'), '20010db8000000000000000000000001');
  assert.equal(ipv6Bytes('::').toString('hex'), '0'.repeat(32));
  assert.throws(() => ipv6Bytes('1::2::3'));
  assert.throws(() => ipv6Bytes('12345::'));
});

test('registered names answer with their records, authoritatively', async () => {
  const a = await resolve('shop.lyr');
  assert.deepEqual([a.id, a.qr, a.aa, a.rd, a.ra, a.rcode], [0x1234, true, true, true, true, RCODE.NOERROR]);
  assert.deepEqual(a.answers.map((r) => r.value), ['203.0.113.10', '203.0.113.11']);
  assert.equal((await resolve('shop.lyr', 'AAAA')).answers[0].value, '20010db8000000000000000000000001');
  assert.equal((await resolve('shop.lyr', 'TXT')).answers[0].value, 'hello from .lyr');
  assert.equal((await resolve('shop.lyr', 'MX')).answers[0].value, '10 mail.example.com');
});

test('CNAMEs are followed inside .lyr and out to the public internet', async () => {
  const www = await resolve('www.shop.lyr');
  assert.deepEqual(www.answers.map((r) => [r.name, r.type, r.value]), [['www.shop.lyr', 'CNAME', 'shop.example.net'], ['shop.example.net', 'A', '198.51.100.7']]);
  const app = await resolve('app.shop.lyr');
  assert.deepEqual(app.answers.map((r) => [r.type, r.value]), [['CNAME', 'shop.lyr'], ['A', '203.0.113.10'], ['A', '203.0.113.11']]);
  assert.deepEqual((await resolve('www.shop.lyr', 'CNAME')).answers.map((r) => r.value), ['shop.example.net']);
});

test('wildcards, empty answers and unknown names behave like normal DNS', async () => {
  assert.deepEqual((await resolve('anything.shop.lyr')).answers.map((r) => r.value), ['203.0.113.99']);
  const nodata = await resolve('shop.lyr', 'CNAME');
  assert.deepEqual([nodata.rcode, nodata.answers.length, nodata.authority[0].type], [RCODE.NOERROR, 0, 'SOA']);
  const ent = await resolve('api.shop.lyr');
  assert.deepEqual([ent.rcode, ent.answers.length], [RCODE.NOERROR, 0], 'a name with records below it exists, and the wildcard skips it');
  assert.equal((await resolve('deep.api.shop.lyr')).answers[0].value, '203.0.113.50');
  const missing = await resolve('nobody.lyr');
  assert.deepEqual([missing.rcode, missing.aa, missing.authority[0].type], [RCODE.NXDOMAIN, true, 'SOA']);
  assert.equal((await resolve('lyr', 'SOA')).answers[0].type, 'SOA');
});
