// Lyrcloud Sites (sites.mjs) with DynamoDB, Route 53, ACM, CloudFront and public DNS replaced by fakes.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createSites, resolver, route53, cloudfront, acm } from './sites.mjs';

// ---------------------------------------------------------------- fakes

let table; // `${TableName}|${pk}|${sk}` -> item
let zones; // zoneId -> { name, sets: Map(`${name}|${type}`, set) }
let tenants; // id -> tenant
let certs; // arn -> { status, domain }
let invalidations;
let publicDns; // what public resolvers answer: { ns: { domain: [...] }, a: { host: [...] }, ... }
let calls;

const k = (TableName, key) => `${TableName}|${key.pk}|${key.sk}`;
const ddb = {
  async send(command) {
    const { input } = command;
    const name = command.constructor.name;
    if (name === 'GetCommand') return { Item: structuredClone(table.get(k(input.TableName, input.Key))) };
    if (name === 'PutCommand') {
      if (input.ConditionExpression === 'attribute_not_exists(pk)' && table.has(k(input.TableName, input.Item))) {
        throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      }
      table.set(k(input.TableName, input.Item), structuredClone(input.Item));
      return {};
    }
    if (name === 'DeleteCommand') { table.delete(k(input.TableName, input.Key)); return {}; }
    if (name === 'UpdateCommand') {
      const item = table.get(k(input.TableName, input.Key));
      item.cacheVersion = (item.cacheVersion || 0) + 1;
      return {};
    }
    throw new Error(`unexpected ${name}`);
  },
};

const fqdn = (name) => (String(name).endsWith('.') ? String(name) : `${name}.`);
route53.send = async function send(command) {
  const { input } = command;
  const name = command.constructor.name;
  calls.push(name);
  if (name === 'ListReusableDelegationSetsCommand') return { DelegationSets: [] };
  if (name === 'CreateReusableDelegationSetCommand') return { DelegationSet: { Id: '/delegationset/NDS1', NameServers: ['ns-1.awsdns-01.org', 'ns-2.awsdns-02.com', 'ns-3.awsdns-03.net', 'ns-4.awsdns-04.co.uk'] } };
  if (name === 'CreateHostedZoneCommand') {
    if ([...zones.values()].some((z) => z.name === input.Name)) throw Object.assign(new Error('exists'), { name: 'HostedZoneAlreadyExists' });
    const id = `Z${zones.size + 1}`;
    zones.set(id, { name: input.Name, sets: new Map([[`${fqdn(input.Name)}|NS`, { Name: fqdn(input.Name), Type: 'NS', TTL: 172800, ResourceRecords: [{ Value: 'ns-1.awsdns-01.org.' }] }], [`${fqdn(input.Name)}|SOA`, { Name: fqdn(input.Name), Type: 'SOA', TTL: 900, ResourceRecords: [{ Value: 'x' }] }]]) });
    return { HostedZone: { Id: `/hostedzone/${id}` } };
  }
  if (name === 'DeleteHostedZoneCommand') { zones.delete(input.Id); return {}; }
  if (name === 'ListResourceRecordSetsCommand') return { ResourceRecordSets: structuredClone([...zones.get(input.HostedZoneId).sets.values()]), IsTruncated: false };
  if (name === 'ChangeResourceRecordSetsCommand') {
    const z = zones.get(input.HostedZoneId);
    for (const { Action, ResourceRecordSet: set } of input.ChangeBatch.Changes) {
      const key = `${fqdn(set.Name)}|${set.Type}`;
      if (Action === 'DELETE') { assert.ok(z.sets.has(key), `delete of missing ${key}`); z.sets.delete(key); }
      else if (Action === 'CREATE') { assert.ok(!z.sets.has(key), `create of existing ${key}`); z.sets.set(key, { ...structuredClone(set), Name: fqdn(set.Name) }); }
      else z.sets.set(key, { ...structuredClone(set), Name: fqdn(set.Name) });
    }
    return {};
  }
  throw new Error(`unexpected ${name}`);
};

acm.send = async function send(command) {
  const { input } = command;
  const name = command.constructor.name;
  calls.push(name);
  if (name === 'RequestCertificateCommand') {
    const arn = `arn:aws:acm:us-east-1:1:certificate/${input.DomainName}`;
    certs.set(arn, { status: 'PENDING_VALIDATION', names: [input.DomainName, ...(input.SubjectAlternativeNames || [])] });
    return { CertificateArn: arn };
  }
  if (name === 'DescribeCertificateCommand') {
    const cert = certs.get(input.CertificateArn);
    return { Certificate: { Status: cert.status, DomainValidationOptions: cert.names.map((n) => ({ DomainName: n, ResourceRecord: { Name: `_abc.${n}.`, Type: 'CNAME', Value: `_xyz.acm-validations.aws.` } })) } };
  }
  if (name === 'DeleteCertificateCommand') { certs.delete(input.CertificateArn); return {}; }
  throw new Error(`unexpected ${name}`);
};

cloudfront.send = async function send(command) {
  const { input } = command;
  const name = command.constructor.name;
  calls.push(name);
  if (name === 'ListConnectionGroupsCommand') return { ConnectionGroups: [{ Id: 'cg_1', IsDefault: true, RoutingEndpoint: 'd111.cloudfront.net' }] };
  if (name === 'GetConnectionGroupCommand') return { ConnectionGroup: { Id: 'cg_1', RoutingEndpoint: 'd111.cloudfront.net' } };
  if (name === 'CreateDistributionTenantCommand') {
    const id = `dt_${tenants.size + 1}`;
    tenants.set(id, { Id: id, ...structuredClone(input), Status: 'InProgress', etag: 'E1' });
    return { DistributionTenant: { Id: id } };
  }
  if (name === 'GetDistributionTenantCommand') {
    const t = tenants.get(input.Identifier);
    if (!t) throw Object.assign(new Error('gone'), { name: 'EntityNotFound' });
    return { DistributionTenant: structuredClone(t), ETag: t.etag };
  }
  if (name === 'UpdateDistributionTenantCommand') {
    const t = tenants.get(input.Id);
    assert.equal(input.IfMatch, t.etag);
    Object.assign(t, structuredClone(input), { Status: 'InProgress', etag: `E${Number(t.etag.slice(1)) + 1}` });
    return {};
  }
  if (name === 'DeleteDistributionTenantCommand') {
    const t = tenants.get(input.Id);
    assert.equal(t.Enabled, false, 'only disabled tenants can be deleted');
    tenants.delete(input.Id);
    return {};
  }
  if (name === 'CreateInvalidationForDistributionTenantCommand') { invalidations.push(input); return {}; }
  throw new Error(`unexpected ${name}`);
};

const fail = () => { throw Object.assign(new Error('no data'), { code: 'ENODATA' }); };
resolver.current = {
  resolveNs: async (d) => publicDns.ns[d] || fail(),
  resolveCname: async (h) => publicDns.cname[h] || fail(),
  resolve4: async (h) => publicDns.a[h] || fail(),
  resolve6: async () => fail(),
  resolveMx: async (h) => publicDns.mx[h] || fail(),
  resolveTxt: async (h) => publicDns.txt[h] || fail(),
};

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const sites = createSites({
  ddb, TABLE: 'domains', FUNCTIONS_TABLE: 'functions', PROXY_DISTRIBUTION_ID: 'EPROXY', FUNCTION_DISTRIBUTION_ID: 'EFUNC', APP_DISTRIBUTION_ID: 'EAPP',
  itemsOf: async (ownerId) => [...table.values()].filter((item) => item.ownerId === ownerId),
  isStaff: (role) => role === 'admin', json, error: (status, message) => json(status, { error: message }),
  parseJson: (event) => JSON.parse(event.body || '{}'),
});

const ALICE = { userId: 'alice', email: 'alice@example.com', role: 'user', plan: 'launch' };
const BOB = { userId: 'bob', email: 'bob@example.com', role: 'user', plan: 'launch' };
const call = async (who, method, path, body, query) => {
  const res = await sites.routes({ body: body ? JSON.stringify(body) : undefined, queryStringParameters: query }, method, path, who);
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const setsOf = (domain) => [...[...zones.values()].find((z) => z.name === domain).sets.values()];
const find = (domain, name, type) => setsOf(domain).find((s) => s.Name === fqdn(name) && s.Type === type);

beforeEach(() => {
  table = new Map(); zones = new Map(); tenants = new Map(); certs = new Map(); invalidations = []; calls = [];
  publicDns = {
    ns: { 'shop.com': ['ns1.oldhost.net', 'ns2.oldhost.net'] },
    a: { 'shop.com': ['203.0.113.10'], 'api.shop.com': ['203.0.113.20'] },
    cname: { 'www.shop.com': ['shop.com'] },
    mx: { 'shop.com': [{ priority: 10, exchange: 'mx.mail.net' }] },
    txt: { 'shop.com': [['v=spf1 include:mail.net ~all']] },
  };
});

// ---------------------------------------------------------------- tests

test('adding a site makes a zone on the shared name servers, filled with today’s records', async () => {
  const res = await call(ALICE, 'POST', '/domains/sites', { domain: 'Shop.com' });
  assert.equal(res.status, 201);
  assert.equal(res.body.site.status, 'pending');
  assert.deepEqual(res.body.site.nameservers, ['ns-1.awsdns-01.org', 'ns-2.awsdns-02.com', 'ns-3.awsdns-03.net', 'ns-4.awsdns-04.co.uk']);
  assert.deepEqual(find('shop.com', 'shop.com', 'A').ResourceRecords, [{ Value: '203.0.113.10' }]);
  assert.equal(find('shop.com', 'www.shop.com', 'CNAME').ResourceRecords[0].Value, 'shop.com');
  assert.equal(find('shop.com', 'shop.com', 'MX').ResourceRecords[0].Value, '10 mx.mail.net');
  assert.equal(find('shop.com', 'shop.com', 'TXT').ResourceRecords[0].Value, '"v=spf1 include:mail.net ~all"');
  assert.ok(find('shop.com', 'api.shop.com', 'A'));

  // Once more, or by someone else: refused. A second site reuses the same delegation set.
  assert.equal((await call(BOB, 'POST', '/domains/sites', { domain: 'shop.com' })).status, 409);
  await call(ALICE, 'POST', '/domains/sites', { domain: 'two.com' });
  assert.equal(calls.filter((c) => c === 'CreateReusableDelegationSetCommand').length, 1);
  // Bob can't see Alice's site.
  assert.equal((await call(BOB, 'GET', '/domains/sites/shop.com')).status, 404);
  assert.equal((await call(ALICE, 'POST', '/domains/sites', { domain: 'not a domain' })).status, 400);
});

test('the Launch plan holds three sites; staff and registered domains don’t count against it', async () => {
  for (const d of ['a.com', 'b.com', 'c.com']) assert.equal((await call(ALICE, 'POST', '/domains/sites', { domain: d })).status, 201);
  const res = await call(ALICE, 'POST', '/domains/sites', { domain: 'd.com' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /3 sites/);
  assert.equal((await call({ ...ALICE, plan: 'scale' }, 'POST', '/domains/sites', { domain: 'd.com' })).status, 201);
  await sites.addSite({ domain: 'bought.com', ownerId: 'alice', source: 'registered', importRecords: false });
});

test('a site turns active once the domain uses our name servers', async () => {
  await call(ALICE, 'POST', '/domains/sites', { domain: 'shop.com' });
  assert.equal((await call(ALICE, 'GET', '/domains/sites/shop.com')).body.site.status, 'pending');
  publicDns.ns['shop.com'] = ['NS-1.awsdns-01.org.', 'ns-2.awsdns-02.com', 'ns-3.awsdns-03.net', 'ns-4.awsdns-04.co.uk'];
  const site = (await call(ALICE, 'GET', '/domains/sites/shop.com')).body.site;
  assert.equal(site.status, 'active');
  assert.ok(site.records.some((r) => r.type === 'MX'));
});

async function activeSite(domain = 'shop.com') {
  await call(ALICE, 'POST', '/domains/sites', { domain });
  publicDns.ns[domain] = ['ns-1.awsdns-01.org', 'ns-2.awsdns-02.com', 'ns-3.awsdns-03.net', 'ns-4.awsdns-04.co.uk'];
  await call(ALICE, 'GET', `/domains/sites/${domain}`);
}

test('records: edit, delete, CNAME conflicts', async () => {
  await activeSite();
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/records', { type: 'A', name: 'blog', values: ['198.51.100.4'] })).status, 200);
  assert.ok(find('shop.com', 'blog.shop.com', 'A'));
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/records', { type: 'CNAME', name: 'blog', values: ['x.net'] })).status, 400);
  assert.equal((await call(ALICE, 'DELETE', '/domains/sites/shop.com/records', null, { type: 'A', name: 'blog' })).status, 200);
  assert.equal(find('shop.com', 'blog.shop.com', 'A'), undefined);
  assert.equal((await call(ALICE, 'DELETE', '/domains/sites/shop.com/records', null, { type: 'A', name: 'nope' })).status, 404);
});

test('CDN in front of the customer’s server: certificate first, then tenant, then DNS; and back off', async () => {
  // Not before the name servers point here.
  await call(ALICE, 'POST', '/domains/sites', { domain: 'shop.com' });
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'proxy', origin: '203.0.113.10' })).status, 409);
  publicDns.ns['shop.com'] = ['ns-1.awsdns-01.org'];
  await call(ALICE, 'GET', '/domains/sites/shop.com');

  // The origin can't be the domain itself.
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'proxy', origin: 'www.shop.com' })).status, 400);

  let res = await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'proxy', origin: 'https://203.0.113.10/' });
  assert.equal(res.status, 200);
  assert.equal(res.body.site.cdn.status, 'certificate');
  assert.deepEqual(res.body.site.cdn.hosts, ['shop.com', 'www.shop.com']);
  // The certificate's validation CNAMEs and the origin's own name are in the zone; traffic hasn't moved.
  assert.ok(find('shop.com', '_abc.shop.com', 'CNAME'));
  assert.ok(find('shop.com', '_abc.www.shop.com', 'CNAME'));
  assert.deepEqual(find('shop.com', 'lyr-origin.shop.com', 'A').ResourceRecords, [{ Value: '203.0.113.10' }]);
  assert.equal(find('shop.com', 'shop.com', 'A').ResourceRecords[0].Value, '203.0.113.10');
  assert.equal(tenants.size, 0);

  // Issued: the tenant is made on the proxy distribution with that certificate.
  certs.get('arn:aws:acm:us-east-1:1:certificate/shop.com').status = 'ISSUED';
  res = await call(ALICE, 'GET', '/domains/sites/shop.com');
  assert.equal(res.body.site.cdn.status, 'deploying');
  const tenant = tenants.get('dt_1');
  assert.equal(tenant.DistributionId, 'EPROXY');
  assert.deepEqual(tenant.Domains, [{ Domain: 'shop.com' }, { Domain: 'www.shop.com' }]);
  assert.deepEqual(tenant.Parameters, [{ Name: 'origin', Value: 'lyr-origin.shop.com' }]);
  assert.equal(tenant.Customizations.Certificate.Arn, 'arn:aws:acm:us-east-1:1:certificate/shop.com');
  // The records the CDN will serve are locked meanwhile.
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/records', { type: 'A', name: '@', values: ['1.2.3.4'] })).status, 409);
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/records', { type: 'TXT', name: '_abc', values: ['x'] })).status, 409);

  // Deployed: apex and www become aliases of the routing endpoint; the old records are kept aside.
  tenant.Status = 'Deployed';
  res = await call(ALICE, 'GET', '/domains/sites/shop.com');
  assert.equal(res.body.site.cdn.status, 'live');
  for (const [host, type] of [['shop.com', 'A'], ['shop.com', 'AAAA'], ['www.shop.com', 'A'], ['www.shop.com', 'AAAA']]) {
    assert.deepEqual(find('shop.com', host, type).AliasTarget, { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd111.cloudfront.net', EvaluateTargetHealth: false });
  }
  assert.equal(find('shop.com', 'www.shop.com', 'CNAME'), undefined);
  assert.ok(res.body.site.records.some((r) => r.managed === 'cdn' && r.label === '@'));
  // MX and other records are untouched.
  assert.ok(find('shop.com', 'shop.com', 'MX'));

  // Purge: CloudFront invalidation for the tenant.
  res = await call(ALICE, 'POST', '/domains/sites/shop.com/purge', { paths: ['/index.html', '/blog/*'] });
  assert.deepEqual(invalidations[0].InvalidationBatch.Paths, { Quantity: 2, Items: ['/index.html', '/blog/*'] });
  assert.equal((await call(ALICE, 'POST', '/domains/sites/shop.com/purge', { paths: ['nope'] })).status, 400);

  // Change the origin in place.
  res = await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'proxy', origin: 'origin.example.net' });
  assert.equal(res.body.site.cdn.status, 'live');
  assert.deepEqual(tenants.get('dt_1').Parameters, [{ Name: 'origin', Value: 'origin.example.net' }]);
  // Switching to a function needs the CDN off first.
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'function', fn: 'blog' })).status, 409);
  // A site with the CDN on can't be removed.
  assert.equal((await call(ALICE, 'DELETE', '/domains/sites/shop.com')).status, 409);

  // Off: records come back at once, the tenant is disabled, then deleted with the certificate.
  res = await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'off' });
  assert.equal(res.body.site.cdn.status, 'removing');
  assert.equal(find('shop.com', 'shop.com', 'A').ResourceRecords[0].Value, '203.0.113.10');
  assert.equal(find('shop.com', 'www.shop.com', 'CNAME').ResourceRecords[0].Value, 'shop.com');
  assert.equal(find('shop.com', 'shop.com', 'AAAA'), undefined);
  assert.equal(tenants.get('dt_1').Enabled, false);
  tenants.get('dt_1').Status = 'Deployed';
  await sites.tickSite(await sites.getSite('shop.com'));
  assert.equal(tenants.size, 0);
  assert.equal(certs.size, 0);
  assert.equal(find('shop.com', '_abc.shop.com', 'CNAME'), undefined);
  assert.equal(find('shop.com', 'lyr-origin.shop.com', 'A'), undefined);
  assert.equal((await sites.getSite('shop.com')).cdn, undefined);

  // Now it can be removed, zone and all.
  assert.equal((await call(ALICE, 'DELETE', '/domains/sites/shop.com')).status, 200);
  assert.equal(zones.size, 0);
});

test('CDN for an Edge Function: only your own, on the function distribution, purging the router cache too', async () => {
  await activeSite();
  table.set('functions|fn#blog|fn', { pk: 'fn#blog', sk: 'fn', ownerId: 'alice' });
  table.set('functions|fn#other|fn', { pk: 'fn#other', sk: 'fn', ownerId: 'bob' });
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'function', fn: 'other' })).status, 404);
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'function', fn: 'Bad Name' })).status, 400);
  await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'function', fn: 'blog' });
  certs.get('arn:aws:acm:us-east-1:1:certificate/shop.com').status = 'ISSUED';
  await call(ALICE, 'GET', '/domains/sites/shop.com');
  const tenant = tenants.get('dt_1');
  assert.equal(tenant.DistributionId, 'EFUNC');
  assert.deepEqual(tenant.Parameters, [{ Name: 'fn', Value: 'blog' }]);
  tenant.Status = 'Deployed';
  await sites.tickSite(await sites.getSite('shop.com'));
  await call(ALICE, 'POST', '/domains/sites/shop.com/purge', {});
  assert.deepEqual(invalidations[0].InvalidationBatch.Paths.Items, ['/*']);
  assert.equal(table.get('functions|fn#blog|fn').cacheVersion, 1);
});

test('www pointing elsewhere stays out of the CDN', async () => {
  publicDns.cname['www.shop.com'] = ['shops.someplatform.com'];
  await activeSite();
  const res = await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'proxy', origin: '203.0.113.10' });
  assert.deepEqual(res.body.site.cdn.hosts, ['shop.com']);
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/records', { type: 'CNAME', name: 'www', values: ['elsewhere.net'] })).status, 200);
});

test('a domain registered here can’t be removed as a site', async () => {
  await sites.addSite({ domain: 'bought.com', ownerId: 'alice', source: 'registered', importRecords: false });
  assert.equal((await call(ALICE, 'DELETE', '/domains/sites/bought.com')).status, 409);
});

test('CDN in front of a cloud app: its own address, on the distribution that keeps the app’s Host', async () => {
  await activeSite();
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'app', origin: '203.0.113.10' })).status, 400, 'an app has a host name');
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'app', origin: 'shop.com' })).status, 400);
  const res = await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'app', origin: 'https://web-site-abc.a.run.app/' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.site.cdn.mode, res.body.site.cdn.origin], ['app', 'web-site-abc.a.run.app']);
  certs.get('arn:aws:acm:us-east-1:1:certificate/shop.com').status = 'ISSUED';
  await call(ALICE, 'GET', '/domains/sites/shop.com');
  const tenant = tenants.get('dt_1');
  assert.equal(tenant.DistributionId, 'EAPP');
  assert.deepEqual(tenant.Parameters, [{ Name: 'origin', Value: 'web-site-abc.a.run.app' }]);
  assert.equal((await call(ALICE, 'PUT', '/domains/sites/shop.com/cdn', { mode: 'proxy', origin: '203.0.113.10' })).status, 409, 'turn it off before switching');
});
