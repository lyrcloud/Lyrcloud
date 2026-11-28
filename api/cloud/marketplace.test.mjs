// AWS Marketplace end to end: the fulfillment form, linking to a Lyrcloud account, plans from entitlements,
// hourly metering of Kubernetes clusters and cancellation, with DynamoDB and AWS Marketplace replaced by fakes.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { planFromEntitlements, profileChange, tokenFrom, usageRecord } from './marketplace.mjs';

process.env.TABLE_NAME = 'cloud';
process.env.USERS_TABLE_NAME = 'users';
process.env.LYRPAY_JSON = JSON.stringify({ secret_key: 'lpk_test', webhook_secret: 'lpwh_test' });
let lyrpayments;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  assert.equal(u.host, 'lyrpay.com');
  const respond = (body) => ({ ok: true, status: 200, json: async () => body });
  if (init.method === 'POST') {
    const body = JSON.parse(init.body);
    const id = `lpp_${String(lyrpayments.size + 1).padStart(24, '0')}`;
    lyrpayments.set(id, { id, status: 'pending', amount: body.amount, currency: body.currency });
    return respond({ ...lyrpayments.get(id), url: `https://lyrpay.com/pay/${id}` });
  }
  return respond(lyrpayments.get(u.pathname.split('/').pop()));
};
const { clients, handler } = await import('./index.mjs');

const ALICE = { userId: 'sub-alice', email: 'alice@example.com', provider: 'GoogleOIDC' };
const MALLORY = { userId: 'sub-mallory', email: 'mallory@example.com', provider: 'GoogleOIDC' };
const ISSUER = 'https://example.tokens.sts.global.api.aws';
const LAMBDA = 'arn:aws:iam::479664683751:role/lyrcloud-cloud';

let tables;
const keyOf = (table, key) => (table === 'users' ? key.userId : `${key.pk}|${key.sk}`);
DynamoDBDocumentClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const input = command.input;
  const table = tables[input.TableName] ??= new Map();
  if (name === 'GetCommand') return { Item: structuredClone(table.get(keyOf(input.TableName, input.Key))) };
  if (name === 'PutCommand') return table.set(keyOf(input.TableName, input.Item), structuredClone(input.Item)), {};
  if (name === 'DeleteCommand') return table.delete(keyOf(input.TableName, input.Key)), {};
  if (name === 'UpdateCommand') {
    const item = table.get(keyOf(input.TableName, input.Key));
    for (const part of input.UpdateExpression.replace(/^SET /, '').split(', ')) {
      const [field, value] = part.split(' = ');
      item[input.ExpressionAttributeNames[field]] = structuredClone(input.ExpressionAttributeValues[value]);
    }
    return { Attributes: structuredClone(item) };
  }
  if (name === 'QueryCommand') return { Items: structuredClone([...table.values()].filter((item) => item.ownerId === input.ExpressionAttributeValues[':o'])) };
  if (name === 'ScanCommand') return { Items: structuredClone([...table.values()]) };
  throw new Error(`unexpected ${name}`);
};

// AWS STS signs "tokens": base64url JSON, enough for the fakes below to read the claims.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
STSClient.prototype.send = async function send(command) {
  assert.equal(command.constructor.name, 'GetWebIdentityTokenCommand');
  const tags = Object.fromEntries(command.input.Tags.map(({ Key, Value }) => [Key, Value]));
  return { WebIdentityToken: `${b64({ alg: 'RS256' })}.${b64({ iss: ISSUER, sub: LAMBDA, aud: command.input.Audience[0], 'https://sts.amazonaws.com/': { request_tags: tags } })}.sig` };
};
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));


// ---- AWS Marketplace (this account is the seller)
let marketplace; // tokens -> customer; licenses -> entitlements; metered records
clients.metering = () => ({
  send: async (command) => {
    const name = command.constructor.name;
    if (name === 'ResolveCustomerCommand') {
      const customer = marketplace.tokens[command.input.RegistrationToken];
      if (!customer) throw Object.assign(new Error('Registration token is invalid'), { name: 'InvalidTokenException' });
      return customer;
    }
    assert.equal(name, 'BatchMeterUsageCommand');
    assert.equal(command.input.ProductCode, undefined, 'new-style integrations send no ProductCode');
    for (const record of command.input.UsageRecords) {
      assert.ok(record.LicenseArn && record.CustomerAWSAccountId && record.QuantityAsDecimal && record.Quantity === undefined);
      marketplace.metered.push(record);
    }
    return { Results: command.input.UsageRecords.map((UsageRecord) => ({ UsageRecord, Status: 'Success' })), UnprocessedRecords: [] };
  },
});
clients.entitlements = () => ({
  send: async (command) => {
    assert.equal(command.input.ProductCode, 'prod-lyrcloud');
    const [license] = command.input.Filter.LICENSE_ARN;
    return { Entitlements: marketplace.entitlements[license] || [] };
  },
});

const call = (person, method, path, body) => handler({
  requestContext: { http: { method, path }, authorizer: { jwt: { claims: { sub: person.userId } } } },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((response) => ({ status: response.statusCode, body: JSON.parse(response.body) }));
const fulfill = (form) => handler({ requestContext: { http: { method: 'POST', path: '/public/marketplace' } }, body: Buffer.from(form).toString('base64'), isBase64Encoded: true });

const LICENSE = 'arn:aws:license-manager::294406891311:license:l-abc123';
beforeEach(() => {
  tables = { users: new Map(), cloud: new Map() };
  for (const person of [ALICE, MALLORY]) tables.users.set(person.userId, { ...person, plan: 'launch' });
  lyrpayments = new Map();
  marketplace = {
    tokens: { 'tok-alice': { CustomerAWSAccountId: '111122223333', LicenseArn: LICENSE, ProductCode: 'prod-lyrcloud' } },
    entitlements: { [LICENSE]: [{ Dimension: 'scale', Value: { IntegerValue: 1 }, ExpirationDate: new Date(Date.now() + 30 * 864e5) }] },
    metered: [],
  };
});

test('rules: the best active contract dimension wins; Marketplace only takes away plans it gave', () => {
  const later = new Date(Date.now() + 864e5);
  assert.equal(planFromEntitlements([{ Dimension: 'scale', Value: { IntegerValue: 1 } }, { Dimension: 'enterprise', Value: { IntegerValue: 1 }, ExpirationDate: later }]).plan, 'enterprise');
  assert.equal(planFromEntitlements([{ Dimension: 'enterprise', Value: { IntegerValue: 0 } }, { Dimension: 'scale', Value: { IntegerValue: 1 } }]).plan, 'scale');
  assert.equal(planFromEntitlements([{ Dimension: 'scale', Value: { IntegerValue: 1 }, ExpirationDate: new Date(Date.now() - 1000) }]), null, 'expired');
  assert.equal(planFromEntitlements([]), null);
  assert.deepEqual(profileChange({ plan: 'launch' }, { plan: 'scale', expiresAt: null }), { plan: 'scale', planSource: 'marketplace', planPaidThrough: null });
  assert.equal(profileChange({ plan: 'enterprise' }, { plan: 'scale' }), null, 'a staff-set Enterprise stays');
  assert.equal(profileChange({ plan: 'scale', planSource: 'lyrpay' }, null), null, 'a Lyrpay plan is not Marketplace’s to end');
  assert.deepEqual(profileChange({ plan: 'scale', planSource: 'marketplace' }, null), { plan: 'launch', planSource: null, planPaidThrough: null });
  assert.equal(tokenFrom({ body: 'x-amzn-marketplace-token=abc%2B1' }), 'abc+1');
  assert.equal(tokenFrom({ body: '' }), null);
  const hour = new Date('2026-11-28T03:00:00Z');
  const clusters = [{ kind: 'kubernetes', billing: 'marketplace', status: 'ready' }, { kind: 'kubernetes', billing: 'marketplace', status: 'deleting' }, { kind: 'kubernetes', status: 'ready' }, { kind: 'serverless', status: 'ready' }];
  assert.deepEqual(usageRecord({ awsAccountId: '1', licenseArn: 'L' }, clusters, hour), { Timestamp: hour, CustomerAWSAccountId: '1', LicenseArn: 'L', Dimension: 'kubernetes_cluster_hours', QuantityAsDecimal: '1' });
  assert.equal(usageRecord({}, [], hour), null);
});

test('AWS Marketplace: sign-up, link, plan, hourly metering, then cancel', async () => {
  // AWS posts the buyer's browser to the fulfillment URL.
  const bad = await fulfill('x-amzn-marketplace-token=nope');
  assert.equal(bad.statusCode, 303);
  assert.match(bad.headers.location, /#\/marketplace\?error=token$/);
  const ok = await fulfill('x-amzn-marketplace-token=tok-alice');
  const code = ok.headers.location.match(/#\/marketplace\/([\w-]+)$/)[1];
  // Signed in, Alice links it: she gets Scale from the entitlement.
  assert.equal((await call(ALICE, 'POST', '/cloud/marketplace/link', { code: 'x'.repeat(24) })).status, 404);
  const linked = await call(ALICE, 'POST', '/cloud/marketplace/link', { code });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.marketplace.plan, 'scale');
  assert.equal(linked.body.marketplace.awsAccountId, '111122223333');
  assert.equal(tables.users.get(ALICE.userId).plan, 'scale');
  assert.equal(tables.users.get(ALICE.userId).planSource, 'marketplace');
  assert.equal((await call(ALICE, 'POST', '/cloud/marketplace/link', { code })).status, 404, 'the code is single-use');
  // The same license can't be linked to Mallory too.
  const again = (await fulfill('x-amzn-marketplace-token=tok-alice')).headers.location.match(/#\/marketplace\/([\w-]+)$/)[1];
  assert.equal((await call(MALLORY, 'POST', '/cloud/marketplace/link', { code: again })).status, 409);
  // A Kubernetes cluster is billed through Marketplace: no Lyrpay payment first.
  const connection = { pk: `conn#${ALICE.userId}`, sk: 'gcp', row: 'connection', ownerId: ALICE.userId, provider: 'gcp', connectionId: 'lyr0000000001', projectId: 'acme-prod', projectNumber: '123', connectedAt: '2026-11-01T00:00:00Z' };
  tables.cloud.set(`${connection.pk}|${connection.sk}`, connection);
  const cluster = { pk: 'cluster#aaaa0001', sk: 'cluster', row: 'cluster', id: 'aaaa0001', ownerId: ALICE.userId, provider: 'gcp', region: 'us-central1', name: 'kube', kind: 'kubernetes', status: 'ready', billing: 'marketplace', createdAt: '2026-11-01T00:00:00Z' };
  tables.cloud.set('cluster#aaaa0001|cluster', cluster);
  const overview = await call(ALICE, 'GET', '/cloud');
  assert.equal(overview.body.clusters[0].fee.needsFee, false);
  assert.equal(overview.body.clusters[0].billing, 'marketplace');
  // The hourly run meters the last full hour once.
  await handler({ lyrcloudTask: 'hosting-tick' });
  await handler({ lyrcloudTask: 'hosting-tick' });
  assert.equal(marketplace.metered.length, 1);
  assert.deepEqual([marketplace.metered[0].LicenseArn, marketplace.metered[0].QuantityAsDecimal, marketplace.metered[0].Dimension], [LICENSE, '1', 'kubernetes_cluster_hours']);
  assert.equal(marketplace.metered[0].Timestamp.getUTCMinutes(), 0);
  // Upgrades arrive as a Marketplace event.
  marketplace.entitlements[LICENSE] = [{ Dimension: 'enterprise', Value: { IntegerValue: 1 } }];
  await handler({ source: 'aws.agreement-marketplace', 'detail-type': 'License Updated', detail: {} });
  assert.equal(tables.users.get(ALICE.userId).plan, 'enterprise');
  // Cancelled: back to Launch, and the cluster returns to the Lyrpay fee, due now.
  marketplace.entitlements[LICENSE] = [];
  await handler({ source: 'aws.agreement-marketplace', 'detail-type': 'Agreement Ended', detail: {} });
  assert.equal(tables.users.get(ALICE.userId).plan, 'launch');
  const after = tables.cloud.get('cluster#aaaa0001|cluster');
  assert.equal(after.billing, null);
  assert.ok(Date.parse(after.paidThrough) <= Date.now());
  assert.equal((await call(ALICE, 'GET', '/cloud/marketplace')).body.marketplace.plan, null);
});
