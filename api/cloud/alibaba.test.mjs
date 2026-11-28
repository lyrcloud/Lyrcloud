// Alibaba Cloud end to end, with DynamoDB, AWS STS (GetWebIdentityToken) and the customer's Alibaba account
// replaced by fakes. The fake enforces what the real setup script configures: AssumeRoleWithOIDC only works with
// a token whose audience is the connection's own OIDC provider, and every other call must carry its STS keys.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { encode, flatten, sign } from './alibaba-api.mjs';

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
clients.fingerprints = async () => ['AA11', 'BB22'];

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


// ---- the customer's Alibaba Cloud: what the setup script made (OIDC provider, role) and what Lyrcloud built
let accounts; // accountId -> { connectionId, vpcs, vswitches, groups, instances, clusters, functions, triggers, warm }
let requests;
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
let seq = 0;
const nextId = (prefix) => `${prefix}-${(seq += 1)}`;

function alibabaCloud(u, init) {
  if (u.host === 'sts.aliyuncs.com') {
    const form = Object.fromEntries(init.body);
    const [, accountId, providerName] = form.OIDCProviderArn.match(/^acs:ram::(\d+):oidc-provider\/(.+)$/);
    const account = accounts[accountId];
    const claims = claimsOf(form.OIDCToken);
    // The provider's only client ID is lyrcloud-<connection ID>, and the role trusts only that provider.
    if (!account || providerName !== `lyrcloud-${account.connectionId}` || claims.aud !== providerName || claims.iss !== ISSUER || form.RoleArn !== `acs:ram::${accountId}:role/${providerName}`) {
      return reply(400, { Code: 'AuthenticationFail.OIDCToken.Invalid', Message: 'The OIDC token is invalid.' });
    }
    return reply(200, { Credentials: { AccessKeyId: 'STS.key', AccessKeySecret: 'secret', SecurityToken: `sts-${accountId}` } });
  }
  const accountId = String(init.headers['x-acs-security-token'] || '').replace('sts-', '');
  const account = accounts[accountId];
  assert.ok(init.headers.authorization.startsWith('ACS3-HMAC-SHA256 Credential=STS.key,'), 'signed with the STS keys');
  if (!account) return reply(403, { Code: 'InvalidSecurityToken.Expired', Message: 'denied' });
  const action = init.headers['x-acs-action'];
  const p = Object.fromEntries(u.searchParams);
  const body = init.body ? JSON.parse(init.body) : null;
  requests.push(action);
  const region = u.host.split('.')[1];
  switch (action) {
    case 'DescribeRegions': return reply(200, { Regions: { Region: [] } });
    case 'DescribeAvailableResource': return reply(200, { AvailableZones: { AvailableZone: [{ ZoneId: `${region}-b`, Status: 'Available', StatusCategory: 'WithStock' }, { ZoneId: `${region}-a`, Status: 'Available', StatusCategory: 'WithStock' }] } });
    case 'DescribeVpcs': return reply(200, { Vpcs: { Vpc: account.vpcs.filter((v) => (!p.VpcName || v.VpcName === p.VpcName) && (!p.VpcId || v.VpcId === p.VpcId)) } });
    case 'CreateVpc': { const vpc = { VpcId: nextId('vpc'), VpcName: p.VpcName, CidrBlock: p.CidrBlock, Status: 'Available' }; account.vpcs.push(vpc); return reply(200, { VpcId: vpc.VpcId }); }
    case 'DescribeVSwitches': return reply(200, { VSwitches: { VSwitch: account.vswitches.filter((v) => (!p.VpcId || v.VpcId === p.VpcId) && (!p.VSwitchId || v.VSwitchId === p.VSwitchId)) } });
    case 'CreateVSwitch': { const vs = { VSwitchId: nextId('vsw'), VpcId: p.VpcId, ZoneId: p.ZoneId, CidrBlock: p.CidrBlock, VSwitchName: p.VSwitchName, Status: 'Available' }; account.vswitches.push(vs); return reply(200, { VSwitchId: vs.VSwitchId }); }
    case 'CreateSecurityGroup': { const id = nextId('sg'); account.groups.set(id, { VpcId: p.VpcId, rules: [] }); return reply(200, { SecurityGroupId: id }); }
    case 'AuthorizeSecurityGroup': account.groups.get(p.SecurityGroupId).rules.push(p); return reply(200, {});
    case 'DeleteSecurityGroup': account.groups.delete(p.SecurityGroupId); return reply(200, {});
    case 'DescribeImages': return reply(200, { Images: { Image: [{ ImageId: 'ubuntu_old', CreationTime: '2025-01-01T00:00Z' }, { ImageId: 'ubuntu_24_04_x64_new', CreationTime: '2026-10-16T00:00Z' }] } });
    case 'RunInstances': { const id = nextId('i'); account.instances.set(id, { ...p, Status: 'Pending' }); return reply(200, { InstanceIdSets: { InstanceIdSet: [id] } }); }
    case 'DescribeInstances': { const id = JSON.parse(p.InstanceIds)[0]; const i = account.instances.get(id); return reply(200, { Instances: { Instance: i ? [{ InstanceId: id, Status: i.Status, PublicIpAddress: { IpAddress: ['47.1.2.3'] } }] : [] } }); }
    case 'DeleteInstance': account.instances.delete(p.InstanceId); return reply(200, {});
    case 'CreateCluster': { const id = nextId('c'); account.clusters.set(id, { ...body, state: 'initial', pools: [{ nodepool_info: { name: 'system', nodepool_id: 'np-1' }, desired: body.nodepools[0].scaling_group.desired_size }] }); return reply(200, { cluster_id: id }); }
    case 'DescribeClusterDetail': { const c = account.clusters.get(u.pathname.split('/')[2]); return c ? reply(200, { state: c.state, master_url: JSON.stringify({ api_server_endpoint: 'https://47.9.9.9:6443' }) }) : reply(404, { code: 'ErrorClusterNotFound' }); }
    case 'DescribeClusterNodePools': return reply(200, { nodepools: account.clusters.get(u.pathname.split('/')[2]).pools });
    case 'ModifyClusterNodePool': account.clusters.get(u.pathname.split('/')[2]).pools[0].desired = body.scaling_group.desired_size; return reply(200, {});
    case 'DeleteCluster': account.clusters.delete(u.pathname.split('/')[2]); return reply(202, { task_id: 't' });
    case 'DescribeClusterUserKubeconfig': return reply(200, { config: 'apiVersion: v1\nclusters:\n- cluster:\n    server: https://47.9.9.9:6443\n    certificate-authority-data: Q0E=\nusers:\n- user:\n    client-certificate-data: Q0VSVA==\n    client-key-data: S0VZ\n' });
  }
  // Function Compute 3.0: <account>.<region>.fc.aliyuncs.com
  assert.equal(u.host, `${accountId}.${region}.fc.aliyuncs.com`);
  const [, , , name, sub, subName] = u.pathname.split('/');
  switch (action) {
    case 'CreateFunction': account.functions.set(body.functionName, { ...body, state: 'Pending' }); return reply(200, body);
    case 'UpdateFunction': Object.assign(account.functions.get(name), body, { lastUpdateStatus: 'InProgress' }); return reply(200, {});
    case 'GetFunction': { const f = account.functions.get(name); return f ? reply(200, f) : reply(404, { code: 'FunctionNotFound' }); }
    case 'DeleteFunction': assert.ok(!account.triggers.has(name), 'triggers go first'); account.functions.delete(name); return reply(204, {});
    case 'CreateTrigger': account.triggers.set(name, JSON.parse(body.triggerConfig)); return reply(200, {});
    case 'GetTrigger': return account.triggers.has(name) ? reply(200, { httpTrigger: { urlInternet: `https://${name}-x.us-east-1.fcapp.run` } }) : reply(404, { code: 'TriggerNotFound' });
    case 'DeleteTrigger': account.triggers.delete(name); return reply(204, {});
    case 'PutProvisionConfig': assert.equal(u.searchParams.get('qualifier'), 'LATEST'); account.warm.set(name, body.target); return reply(200, {});
    case 'DeleteProvisionConfig': account.warm.delete(name); return reply(204, {});
  }
  throw new Error(`unexpected Alibaba action ${action} (${sub} ${subName})`);
}

clients.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host.endsWith('.aliyuncs.com')) return alibabaCloud(u, init);
  throw new Error(`unexpected request ${url}`);
};

async function orderPaid(person, body) {
  const ordered = await call(person, 'POST', '/cloud/clusters', body);
  assert.equal(ordered.body.cluster.status, 'awaiting_payment', JSON.stringify(ordered.body));
  lyrpayments.forEach((p) => { p.status = 'paid'; });
  return call(person, 'POST', `/cloud/clusters/${ordered.body.cluster.id}/payment`);
}

const call = (person, method, path, body) => handler({
  requestContext: { http: { method, path }, authorizer: { jwt: { claims: { sub: person.userId } } } },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((response) => ({ status: response.statusCode, body: JSON.parse(response.body) }));

const newAccount = (connectionId) => ({ connectionId, vpcs: [], vswitches: [], groups: new Map(), instances: new Map(), clusters: new Map(), functions: new Map(), triggers: new Map(), warm: new Map() });
async function connected(person, accountId) {
  const { connectionId } = (await call(person, 'POST', '/cloud/connections/alibaba')).body.connection;
  const account = accounts[accountId] = newAccount(connectionId);
  const done = await call(person, 'PUT', '/cloud/connections/alibaba', { accountId });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return account;
}

beforeEach(() => {
  tables = { users: new Map(), cloud: new Map() };
  for (const person of [ALICE, MALLORY]) tables.users.set(person.userId, { ...person, plan: 'scale' });
  lyrpayments = new Map();
  accounts = {};
  requests = [];
});

test('signing: canonical query and nested RPC parameters', () => {
  assert.equal(encode("a b*~!'()"), "a%20b%2A~%21%27%28%29");
  assert.deepEqual(flatten({ Permissions: [{ PortRange: '22/22' }], Tag: [{ Key: 'k' }], SystemDisk: { Size: 30 }, Skip: undefined }), { 'Permissions.1.PortRange': '22/22', 'Tag.1.Key': 'k', 'SystemDisk.Size': '30' });
  const headers = sign({ method: 'GET', host: 'ecs.us-east-1.aliyuncs.com', query: { B: '2', A: '1' }, action: 'DescribeRegions', version: '2014-05-26', credentials: { accessKeyId: 'id', accessKeySecret: 's', securityToken: 't' }, date: '2026-01-01T00:00:00Z', nonce: 'n' });
  assert.match(headers.authorization, /^ACS3-HMAC-SHA256 Credential=id,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-security-token;x-acs-signature-nonce;x-acs-version,Signature=[a-f0-9]{64}$/);
  const again = sign({ method: 'GET', host: 'ecs.us-east-1.aliyuncs.com', query: { A: '1', B: '2' }, action: 'DescribeRegions', version: '2014-05-26', credentials: { accessKeyId: 'id', accessKeySecret: 's', securityToken: 't' }, date: '2026-01-01T00:00:00Z', nonce: 'n' });
  assert.equal(again.authorization, headers.authorization, 'parameter order doesn’t matter');
});

test('Alibaba Cloud: the setup script trusts only this connection, and a stranger can’t claim the account', async () => {
  const started = await call(ALICE, 'POST', '/cloud/connections/alibaba');
  const { connectionId, setupScript, status } = started.body.connection;
  assert.equal(status, 'pending');
  const name = `lyrcloud-${connectionId}`;
  assert.ok(setupScript.includes(`CreateOIDCProvider --OIDCProviderName ${name} --IssuerUrl "${ISSUER}"`));
  assert.ok(setupScript.includes('--Fingerprints "AA11,BB22"') && setupScript.includes(`--ClientIds ${name}`));
  assert.ok(setupScript.includes(`"oidc:aud":"${name}"`) && setupScript.includes(`"oidc:iss":"${ISSUER}"`));
  assert.equal((await call(ALICE, 'PUT', '/cloud/connections/alibaba', { accountId: 'abc' })).status, 400);
  assert.equal((await call(ALICE, 'PUT', '/cloud/connections/alibaba', { accountId: '5172216138938687' })).status, 403, 'script not run yet');
  accounts['5172216138938687'] = newAccount(connectionId);
  const done = await call(ALICE, 'PUT', '/cloud/connections/alibaba', { accountId: '5172216138938687' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.connection.accountId, '5172216138938687');
  assert.equal(done.body.connection.setupScript, null);
  // Mallory pastes Alice's account ID: her token's audience is her own connection, which Alice's provider doesn't accept.
  await call(MALLORY, 'POST', '/cloud/connections/alibaba');
  assert.equal((await call(MALLORY, 'PUT', '/cloud/connections/alibaba', { accountId: '5172216138938687' })).status, 403);
  assert.equal((await call(MALLORY, 'POST', '/cloud/clusters', { name: 'web', provider: 'alibaba', region: 'us-east-1', kind: 'serverless' })).status, 409);
});

test('Alibaba Cloud: Function Compute services get a public address and warm copies', async () => {
  const account = await connected(ALICE, '5172216138938687');
  const fcRegion = await call(ALICE, 'POST', '/cloud/clusters', { name: 'web', provider: 'alibaba', region: 'ap-southeast-1', kind: 'serverless' });
  assert.equal(fcRegion.body.cluster.status, 'ready', 'a Function Compute region needs nothing built');
  const created = await call(ALICE, 'POST', `/cloud/clusters/${fcRegion.body.cluster.id}/services`, { name: 'site', image: 'nginx:latest', port: 8080, size: 'medium', count: 2, env: { MODE: 'prod' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const f = account.functions.get('lyrcloud-web-site');
  assert.equal(f.runtime, 'custom-container');
  assert.deepEqual([f.cpu, f.memorySize, f.customContainerConfig.port, f.environmentVariables.MODE], [0.5, 1024, 8080, 'prod']);
  assert.equal(account.triggers.get('lyrcloud-web-site').authType, 'anonymous');
  assert.equal(account.warm.get('lyrcloud-web-site'), 2);
  f.state = 'Active';
  f.lastUpdateStatus = 'Successful';
  const detail = await call(ALICE, 'GET', `/cloud/clusters/${fcRegion.body.cluster.id}`);
  assert.equal(detail.body.services[0].status, 'ready');
  assert.equal(detail.body.services[0].url, 'https://lyrcloud-web-site-x.us-east-1.fcapp.run');
  // Scale to zero, then remove.
  const id = created.body.service.id;
  assert.equal((await call(ALICE, 'PUT', `/cloud/services/${id}`, { count: 0 })).body.service.status, 'updating');
  assert.ok(!account.warm.has('lyrcloud-web-site'));
  f.lastUpdateStatus = 'Failed';
  f.lastUpdateStatusReason = 'image pull failed';
  tables.cloud.get(`service#${id}|service`).checkedAt = '2000-01-01T00:00:00Z';
  const failed = await call(ALICE, 'GET', `/cloud/services/${id}`);
  assert.equal(failed.body.service.status, 'failed');
  assert.equal((await call(ALICE, 'DELETE', `/cloud/services/${id}`)).status, 200);
  assert.equal(account.functions.size, 0);
  assert.equal(account.triggers.size, 0);
});

test('Alibaba Cloud: ACK clusters in the region’s lyrcloud VPC, resized through the node pool', async () => {
  const account = await connected(ALICE, '5172216138938687');
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'kube', provider: 'alibaba', region: 'us-east-1', kind: 'kubernetes', nodeType: 't3.medium' })).status, 400);
  const ordered = await orderPaid(ALICE, { name: 'kube', provider: 'alibaba', region: 'us-east-1', kind: 'kubernetes', nodeType: 'ecs.g7.large', nodes: 3 });
  assert.equal(ordered.status, 200, JSON.stringify(ordered.body));
  assert.equal(ordered.body.cluster.status, 'creating');
  assert.ok(ordered.body.cluster.estimate.monthly > 200);
  const [clusterId, cluster] = [...account.clusters][0];
  assert.equal(cluster.cluster_type, 'ManagedKubernetes');
  assert.equal(cluster.snat_entry, false);
  assert.deepEqual(cluster.nodepools[0].scaling_group.instance_types, ['ecs.g7.large']);
  assert.equal(cluster.nodepools[0].scaling_group.desired_size, 3);
  assert.equal(cluster.vswitch_ids.length, 2, 'two zones');
  assert.equal(account.vpcs.length, 1);
  assert.deepEqual(account.vswitches.map((v) => v.CidrBlock), ['10.82.0.0/24', '10.82.1.0/24']);
  cluster.state = 'running';
  const id = ordered.body.cluster.id;
  const ready = await call(ALICE, 'GET', `/cloud/clusters/${id}`);
  assert.equal(ready.body.cluster.status, 'ready');
  assert.ok(ready.body.kubectl.includes(`/k8s/${clusterId}/user_config`));
  assert.equal((await call(ALICE, 'PUT', `/cloud/clusters/${id}`, { nodes: 5 })).body.cluster.status, 'updating');
  assert.equal(cluster.pools[0].desired, 5);
  assert.equal((await call(ALICE, 'DELETE', `/cloud/clusters/${id}`)).body.cluster.status, 'deleting');
  assert.equal(account.clusters.size, 0);
  assert.equal(account.vpcs.length, 1, 'the shared VPC stays (free)');
});

test('Alibaba Cloud: Linux servers with the customer’s key, their own firewall, and cleanup', async () => {
  const account = await connected(ALICE, '5172216138938687');
  const key = `ssh-ed25519 ${'A'.repeat(68)} alice@laptop`;
  const made = await call(ALICE, 'POST', '/cloud/servers', { name: 'box', provider: 'alibaba', region: 'eu-central-1', image: 'ubuntu', size: 'medium', sshKey: key, sshFrom: '203.0.113.7/32' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const [instanceId, instance] = [...account.instances][0];
  assert.equal(instance.InstanceType, 'ecs.t6-c1m2.large');
  assert.equal(instance.ImageId, 'ubuntu_24_04_x64_new', 'the newest image');
  assert.equal(instance.ZoneId, undefined);
  assert.equal(instance.VSwitchId, account.vswitches[0].VSwitchId);
  assert.equal(account.vswitches[0].ZoneId, 'eu-central-1-a', 'first zone in stock');
  const cloudInit = Buffer.from(instance.UserData, 'base64').toString('utf8');
  assert.ok(cloudInit.includes('- name: ubuntu') && cloudInit.includes(key));
  const [groupId, group] = [...account.groups][0];
  assert.deepEqual(group.rules[0]['Permissions.1.SourceCidrIp'], '203.0.113.7/32');
  assert.deepEqual(group.rules[0]['Permissions.2.PortRange'], '80/80');
  instance.Status = 'Running';
  const id = made.body.server.id;
  const ready = await call(ALICE, 'GET', `/cloud/servers/${id}`);
  assert.equal(ready.body.server.status, 'ready');
  assert.equal(ready.body.server.ssh, 'ssh ubuntu@47.1.2.3');
  assert.equal(ready.body.server.estimate.monthly, 32.4);
  assert.equal((await call(ALICE, 'DELETE', '/cloud/connections/alibaba')).status, 409, 'servers first');
  assert.equal((await call(ALICE, 'DELETE', `/cloud/servers/${id}`)).body.server.status, 'deleting');
  assert.ok(!account.instances.has(instanceId));
  assert.equal((await call(ALICE, 'GET', `/cloud/servers/${id}`)).body.server.status, 'deleted');
  assert.ok(!account.groups.has(groupId), 'its firewall went too');
  assert.equal((await call(ALICE, 'DELETE', '/cloud/connections/alibaba')).status, 200);
});
