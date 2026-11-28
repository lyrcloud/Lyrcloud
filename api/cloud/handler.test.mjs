// Cloud API end to end, with DynamoDB, STS and the customer's CloudFormation/EC2 replaced by fakes.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

process.env.TABLE_NAME = 'cloud';
process.env.USERS_TABLE_NAME = 'users';
process.env.ACCESS_TEMPLATE_URL = 'https://lyrcloud-public.s3.amazonaws.com/cloud/access-role.json';
process.env.LYRPAY_JSON = JSON.stringify({ secret_key: 'lpk_test', webhook_secret: 'lpwh_test' });

// Lyrpay: payments the customer "approves" by setting their status.
let lyrpayments;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host !== 'lyrpay.com') return realFetch(url, init);
  const respond = (body) => ({ ok: true, status: 200, json: async () => body });
  if (init.method === 'POST' && u.pathname.endsWith('/refund')) {
    const p = lyrpayments.get(u.pathname.split('/').at(-2));
    p.status = 'refunded';
    return respond(p);
  }
  if (init.method === 'POST') {
    const body = JSON.parse(init.body);
    const id = `lpp_${String(lyrpayments.size + 1).padStart(24, '0')}`;
    lyrpayments.set(id, { id, status: 'pending', amount: body.amount, currency: body.currency, reference: body.reference });
    return respond({ ...lyrpayments.get(id), url: `https://lyrpay.com/pay/${id}` });
  }
  return respond(lyrpayments.get(u.pathname.split('/').pop()));
};
const payAll = () => lyrpayments.forEach((p) => { p.status = 'paid'; });
const { clients, handler } = await import('./index.mjs');

const SUPER = { userId: 'sub-super', email: 'lyrclouds@gmail.com', provider: 'GoogleOIDC' };
const ALICE = { userId: 'sub-alice', email: 'alice@example.com', provider: 'GoogleOIDC' };
const BOB = { userId: 'sub-bob', email: 'bob@example.com', provider: 'GoogleOIDC' };
const ADMIN_ARN = 'arn:aws:iam::111122223333:user/alice';

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
    // SET a = :x, b = :y; ADD n :x (numbers, creating the item); ConditionExpression "#f = :v".
    const k = keyOf(input.TableName, input.Key);
    const item = table.get(k) || { ...input.Key };
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};
    if (input.ConditionExpression) {
      const [field, value] = input.ConditionExpression.split(' = ');
      if (item[names[field] || field] !== values[value]) throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
    }
    for (const clause of input.UpdateExpression.split(/ (?=SET |ADD )/)) {
      const [verb, ...rest] = clause.split(' ');
      for (const part of rest.join(' ').split(', ')) {
        if (verb === 'SET') {
          const [field, value] = part.split(' = ');
          item[names[field] || field] = structuredClone(values[value]);
        } else {
          const [field, value] = part.split(' ');
          item[names[field] || field] = (item[names[field] || field] || 0) + values[value];
        }
      }
    }
    table.set(k, item);
    return { Attributes: structuredClone(item) };
  }
  if (name === 'QueryCommand') return { Items: structuredClone([...table.values()].filter((item) => item.ownerId === input.ExpressionAttributeValues[':o'])) };
  if (name === 'ScanCommand') return { Items: structuredClone([...table.values()]) };
  throw new Error(`unexpected ${name}`);
};

// The customer's AWS: accounts that trust Lyrcloud (with an ExternalId), and stacks per region.
let trusted;
let stacks;
let calls;
STSClient.prototype.send = async function send(command) {
  const { RoleArn, ExternalId } = command.input;
  if (trusted[RoleArn] !== ExternalId) throw Object.assign(new Error('not authorized'), { name: 'AccessDenied' });
  return { Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: `session-for-${RoleArn}` } };
};
clients.ec2 = (region) => ({
  send: async () => ({
    AvailabilityZones: region === 'us-east-1'
      ? [{ ZoneName: 'us-east-1a', ZoneId: 'use1-az3' }, { ZoneName: 'us-east-1b', ZoneId: 'use1-az1' }, { ZoneName: 'us-east-1c', ZoneId: 'use1-az2' }, { ZoneName: 'us-east-1d', ZoneId: 'use1-az4' }]
      : [{ ZoneName: `${region}a`, ZoneId: 'x1' }, { ZoneName: `${region}b`, ZoneId: 'x2' }],
  }),
});
let linked;
clients.iam = () => ({
  send: async (command) => {
    const name = command.input.AWSServiceName;
    if (linked.has(name)) throw Object.assign(new Error('Service role name AWSServiceRoleForECS has been taken in this account, please try a different suffix.'), { name: 'InvalidInputException' });
    linked.add(name);
    return {};
  },
});
clients.cloudformation = (region, credentials) => ({
  send: async (command) => {
    const name = command.constructor.name;
    const input = command.input;
    calls.push({ name, region, input, session: (credentials?.sessionToken ?? "lyrcloud-own-account") });
    const key = `${region}|${input.StackName}`;
    if (name === 'CreateStackCommand') {
      if (region === 'ap-east-1') throw Object.assign(new Error('The region is not opted in'), { name: 'OptInRequired' });
      if (stacks.has(key)) throw Object.assign(new Error('exists'), { name: 'AlreadyExistsException' });
      stacks.set(key, { StackStatus: 'CREATE_IN_PROGRESS', template: JSON.parse(input.TemplateBody), Outputs: [] });
      return { StackId: `arn:stack/${input.StackName}` };
    }
    if (name === 'DescribeStacksCommand') {
      const stack = stacks.get(key);
      if (!stack) throw Object.assign(new Error(`Stack with id ${input.StackName} does not exist`), { name: 'ValidationError' });
      return { Stacks: [{ StackStatus: stack.StackStatus, Outputs: stack.Outputs }] };
    }
    if (name === 'DescribeStackEventsCommand') return { StackEvents: [{ LogicalResourceId: 'Cluster', ResourceStatus: 'CREATE_FAILED', ResourceStatusReason: 'Insufficient capacity' }] };
    if (name === 'UpdateStackCommand') {
      const stack = stacks.get(key);
      stack.template = JSON.parse(input.TemplateBody);
      stack.StackStatus = 'UPDATE_IN_PROGRESS';
      return {};
    }
    if (name === 'DeleteStackCommand') {
      stacks.get(key).StackStatus = 'DELETE_IN_PROGRESS';
      return {};
    }
    throw new Error(`unexpected ${name}`);
  },
});

function call(person, method, path, body) {
  return handler({
    requestContext: { http: { method, path }, authorizer: { jwt: { claims: { sub: person.userId } } } },
    headers: {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((response) => ({ status: response.statusCode, body: JSON.parse(response.body) }));
}

// Connects `person`'s account 111122223333 the way the dashboard does: get an ExternalId, "create the stack", paste the ARN.
async function connect(person, account = '111122223333') {
  const started = await call(person, 'POST', '/cloud/connections/aws');
  trusted[`arn:aws:iam::${account}:role/LyrcloudAccess`] = started.body.connection.externalId;
  return call(person, 'PUT', '/cloud/connections/aws', { accountId: account });
}

const finish = (region, stack, outputs = {}) => {
  const item = stacks.get(`${region}|${stack}`);
  item.StackStatus = 'CREATE_COMPLETE';
  item.Outputs = Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
};
const cloudRows = () => [...tables.cloud.values()];

beforeEach(() => {
  tables = { users: new Map(), cloud: new Map() };
  for (const person of [SUPER, ALICE, BOB]) tables.users.set(person.userId, { ...person, plan: 'scale' });
  lyrpayments = new Map();
  trusted = {};
  stacks = new Map();
  calls = [];
  linked = new Set(['ecs.amazonaws.com']); // already there in this account
});

test('connecting needs the role to trust Lyrcloud with this customer’s ExternalId', async () => {
  const started = await call(ALICE, 'POST', '/cloud/connections/aws');
  const { externalId, launchUrl } = started.body.connection;
  assert.match(externalId, /^lyr-[\w-]{24}$/);
  assert.equal(new URL(launchUrl).hash.includes(`param_ExternalId=${externalId}`), true);
  assert.equal((await call(ALICE, 'POST', '/cloud/connections/aws')).body.connection.externalId, externalId, 'stable');
  assert.equal((await call(ALICE, 'PUT', '/cloud/connections/aws', { accountId: '111122223333' })).status, 403, 'the stack isn’t there yet');
  trusted['arn:aws:iam::111122223333:role/LyrcloudAccess'] = 'someone-elses-id';
  assert.equal((await call(ALICE, 'PUT', '/cloud/connections/aws', { accountId: '111122223333' })).status, 403, 'wrong ExternalId');
  assert.equal((await call(ALICE, 'PUT', '/cloud/connections/aws', { roleArn: 'nonsense' })).status, 400);
  trusted['arn:aws:iam::111122223333:role/LyrcloudAccess'] = externalId;
  const done = await call(ALICE, 'PUT', '/cloud/connections/aws', { roleArn: 'arn:aws:iam::111122223333:role/LyrcloudAccess' });
  assert.deepEqual([done.status, done.body.connection.status, done.body.connection.accountId], [200, 'connected', '111122223333']);
});

test('a Kubernetes cluster is built in the customer’s account, in EKS-capable zones', async () => {
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'aws', region: 'us-east-1', kind: 'kubernetes', adminArn: ADMIN_ARN })).status, 409, 'not connected');
  await connect(ALICE);
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'azure', region: 'eastus', kind: 'kubernetes' })).status, 409, 'Azure not connected');
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'aws', region: 'mars-1', kind: 'kubernetes' })).status, 400);
  assert.match((await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'aws', region: 'us-east-1', kind: 'kubernetes' })).body.error, /administer/);
  const ordered = await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'aws', region: 'us-east-1', kind: 'kubernetes', nodeType: 't3.large', nodes: 3, adminArn: ADMIN_ARN });
  assert.equal(ordered.body.cluster.status, 'awaiting_payment', 'Kubernetes management is paid first');
  assert.match(ordered.body.payUrl, /^https:\/\/lyrpay\.com\/pay\/lpp_/);
  assert.equal([...lyrpayments.values()][0].amount, '49.00');
  assert.equal(calls.some((c) => c.name === 'CreateStackCommand'), false, 'nothing built before paying');
  assert.equal((await call(ALICE, 'POST', `/cloud/clusters/${ordered.body.cluster.id}/payment`)).body.cluster.status, 'awaiting_payment');
  payAll();
  const res = { body: (await call(ALICE, 'POST', `/cloud/clusters/${ordered.body.cluster.id}/payment`)).body };
  assert.equal(res.body.cluster.status, 'creating');
  assert.equal(res.body.cluster.fee.active, true);
  assert.ok(Math.abs(res.body.cluster.estimate.monthly - (73 + 182.21 + 10.95)) < 0.01);
  const create = calls.find((c) => c.name === 'CreateStackCommand');
  assert.equal(create.session, 'session-for-arn:aws:iam::111122223333:role/LyrcloudAccess', 'runs as the customer’s role');
  assert.deepEqual(create.input.Capabilities, ['CAPABILITY_NAMED_IAM']);
  const template = stacks.get('us-east-1|lyrcloud-cluster-prod').template;
  assert.deepEqual(['Subnet0', 'Subnet1', 'Subnet2'].map((s) => template.Resources[s].Properties.AvailabilityZone), ['us-east-1b', 'us-east-1c', 'us-east-1d'], 'use1-az3 is skipped');
  assert.equal(template.Resources.Nodes.Properties.ScalingConfig.DesiredSize, 3);
  assert.deepEqual(template.Resources.Nodes.Properties.InstanceTypes, ['t3.large']);
  assert.equal(template.Resources.Admin.Properties.PrincipalArn, ADMIN_ARN);
  assert.match(template.Resources.ClusterRole.Properties.RoleName, /^lyrcloud-[a-f0-9]{8}-cluster$/, 'IAM names stay inside the role’s lyrcloud-* permission');
  assert.deepEqual([...linked].sort(), ['autoscaling.amazonaws.com', 'ecs.amazonaws.com', 'eks-nodegroup.amazonaws.com', 'eks.amazonaws.com'], 'service-linked roles are created first; existing ones are fine');
  assert.equal(template.Resources.Gateway.Type, 'AWS::EC2::InternetGateway');
  assert.equal(Object.values(template.Resources).some((r) => r.Type === 'AWS::EC2::NatGateway'), false, 'no NAT gateway billing while idle');

  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'aws', region: 'us-east-1', kind: 'kubernetes', adminArn: ADMIN_ARN })).status, 409, 'same name, same region');
  const { id } = res.body.cluster;
  assert.equal((await call(BOB, 'GET', `/cloud/clusters/${id}`)).status, 404);
  finish('us-east-1', 'lyrcloud-cluster-prod', { ClusterName: 'lyrcloud-prod', Endpoint: 'https://eks.example' });
  const ready = await call(ALICE, 'GET', `/cloud/clusters/${id}`);
  assert.deepEqual([ready.body.cluster.status, ready.body.cluster.outputs.ClusterName], ['ready', 'lyrcloud-prod']);

  const resized = await call(ALICE, 'PUT', `/cloud/clusters/${id}`, { nodes: 5 });
  assert.equal(resized.body.cluster.status, 'updating');
  assert.equal(stacks.get('us-east-1|lyrcloud-cluster-prod').template.Resources.Nodes.Properties.ScalingConfig.DesiredSize, 5);
  assert.equal((await call(ALICE, 'POST', `/cloud/clusters/${id}/services`, { name: 'web', image: 'nginx' })).status, 400, 'kubectl on Kubernetes');
});

test('failures explain themselves, and opt-in regions say what to do', async () => {
  await connect(ALICE);
  const optIn = await call(ALICE, 'POST', '/cloud/clusters', { name: 'hongkong', provider: 'aws', region: 'ap-east-1', kind: 'serverless' });
  assert.deepEqual([optIn.status, /enable it/i.test(optIn.body.error)], [400, true], optIn.body.error);
  const res = await call(ALICE, 'POST', '/cloud/clusters', { name: 'europe', provider: 'aws', region: 'eu-west-1', kind: 'serverless' });
  stacks.get('eu-west-1|lyrcloud-cluster-europe').StackStatus = 'ROLLBACK_COMPLETE';
  const failed = await call(ALICE, 'GET', `/cloud/clusters/${res.body.cluster.id}`);
  assert.deepEqual([failed.body.cluster.status, failed.body.cluster.failureReason], ['failed', 'Cluster: Insufficient capacity']);
});

test('serverless clusters run container services behind a load balancer, and changes redeploy', async () => {
  await connect(ALICE);
  const res = await call(ALICE, 'POST', '/cloud/clusters', { name: 'apps', provider: 'aws', region: 'eu-west-1', kind: 'serverless' });
  const { id } = res.body.cluster;
  assert.equal(res.body.cluster.estimate.monthly, 0);
  const cluster = stacks.get('eu-west-1|lyrcloud-cluster-apps').template;
  assert.deepEqual(cluster.Resources.Cluster.Properties.CapacityProviders, ['FARGATE', 'FARGATE_SPOT']);
  assert.equal((await call(ALICE, 'POST', `/cloud/clusters/${id}/services`, { name: 'web', image: 'nginx' })).status, 409, 'not ready yet');
  finish('eu-west-1', 'lyrcloud-cluster-apps', { ClusterName: 'lyrcloud-apps', VpcId: 'vpc-1', SubnetIds: 'subnet-a,subnet-b', ExecutionRoleArn: 'arn:aws:iam::111122223333:role/lyrcloud-x-exec' });
  assert.equal((await call(ALICE, 'POST', `/cloud/clusters/${id}/services`, { name: 'web', image: 'not an image!' })).status, 400);
  assert.equal((await call(ALICE, 'POST', `/cloud/clusters/${id}/services`, { name: 'web', image: 'nginx', env: { 'BAD-KEY': 'x' } })).status, 400);
  const svc = await call(ALICE, 'POST', `/cloud/clusters/${id}/services`, { name: 'web', image: 'ghcr.io/acme/web:1.2', port: 8080, size: 'medium', count: 2, env: { NODE_ENV: 'production' }, healthPath: '/health' });
  assert.equal(svc.status, 200);
  const template = stacks.get('eu-west-1|lyrcloud-svc-apps-web').template;
  const container = template.Resources.Task.Properties.ContainerDefinitions[0];
  assert.deepEqual([container.Image, container.PortMappings[0].ContainerPort, container.Environment], ['ghcr.io/acme/web:1.2', 8080, [{ Name: 'NODE_ENV', Value: 'production' }]]);
  assert.deepEqual([template.Resources.Task.Properties.Cpu, template.Resources.Task.Properties.Memory], ['512', '1024']);
  assert.deepEqual(template.Resources.Service.Properties.NetworkConfiguration.AwsvpcConfiguration.Subnets, ['subnet-a', 'subnet-b']);
  assert.equal(template.Resources.Targets.Properties.HealthCheckPath, '/health');
  assert.ok(template.Resources.Balancer.Properties.Name.length <= 32);
  assert.equal(template.Resources.TaskSecurity.Properties.SecurityGroupIngress[0].SourceSecurityGroupId.Ref, 'BalancerSecurity', 'containers only take traffic from the load balancer');

  const serviceId = svc.body.service.id;
  finish('eu-west-1', 'lyrcloud-svc-apps-web', { Url: 'http://lb.example' });
  assert.equal((await call(ALICE, 'GET', `/cloud/services/${serviceId}`)).body.service.url, 'http://lb.example');
  const changed = await call(ALICE, 'PUT', `/cloud/services/${serviceId}`, { image: 'ghcr.io/acme/web:1.3', count: 4 });
  assert.equal(changed.body.service.status, 'updating');
  const next = stacks.get('eu-west-1|lyrcloud-svc-apps-web').template;
  assert.deepEqual([next.Resources.Task.Properties.ContainerDefinitions[0].Image, next.Resources.Service.Properties.DesiredCount, next.Resources.Task.Properties.Cpu], ['ghcr.io/acme/web:1.3', 4, '512']);
  assert.equal((await call(BOB, 'PUT', `/cloud/services/${serviceId}`, { count: 0 })).status, 404);

  assert.equal((await call(ALICE, 'DELETE', `/cloud/clusters/${id}`)).status, 409, 'services first');
  assert.equal((await call(ALICE, 'DELETE', '/cloud/connections/aws')).status, 409, 'clusters first');
  await call(ALICE, 'DELETE', `/cloud/services/${serviceId}`);
  stacks.delete('eu-west-1|lyrcloud-svc-apps-web');
  assert.equal((await call(ALICE, 'GET', `/cloud/services/${serviceId}`)).body.service.status, 'deleted');
  assert.equal(cloudRows().some((row) => row.row === 'service'), false);
  assert.equal((await call(ALICE, 'DELETE', `/cloud/clusters/${id}`)).body.cluster.status, 'deleting');
  stacks.delete('eu-west-1|lyrcloud-cluster-apps');
  await call(ALICE, 'GET', `/cloud/clusters/${id}`);
  assert.equal((await call(ALICE, 'DELETE', '/cloud/connections/aws')).status, 200);
});

test('staff see everyone’s clusters; customers only their own', async () => {
  await connect(ALICE);
  await call(ALICE, 'POST', '/cloud/clusters', { name: 'apps', provider: 'aws', region: 'eu-west-1', kind: 'serverless' });
  assert.equal((await call(BOB, 'GET', '/admin/cloud')).status, 403);
  assert.equal((await call(BOB, 'GET', '/cloud')).body.clusters.length, 0);
  const admin = await call(SUPER, 'GET', '/admin/cloud');
  assert.deepEqual([admin.body.clusters.length, admin.body.clusters[0].ownerEmail, admin.body.connections[0].status], [1, ALICE.email, 'connected']);
});

test('plans limit what Lyrcloud manages; Kubernetes needs its monthly fee, but can always be deleted', async () => {
  tables.users.get(ALICE.userId).plan = 'launch';
  await connect(ALICE);
  const kube = { name: 'kube', provider: 'aws', region: 'us-east-1', kind: 'kubernetes', adminArn: ADMIN_ARN };
  const refused = await call(ALICE, 'POST', '/cloud/clusters', kube);
  assert.deepEqual([refused.status, /Scale plan/.test(refused.body.error)], [402, true]);
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'one', provider: 'aws', region: 'us-east-1', kind: 'serverless' })).status, 200);
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'two', provider: 'aws', region: 'us-east-2', kind: 'serverless' })).status, 402, 'Launch manages one cluster');
  assert.equal((await call(ALICE, 'GET', '/cloud')).body.limits.clusters, 1);

  // Staff are exempt: no payment, built at once.
  await connect(SUPER, '444455556666');
  const staff = await call(SUPER, 'POST', '/cloud/clusters', { ...kube, name: 'staffkube' });
  assert.equal(staff.body.cluster.status, 'creating');
  assert.equal(staff.body.cluster.fee.needsFee, false);

  // Scale: paid, then the month runs out: changes stop, deleting still works.
  tables.users.get(ALICE.userId).plan = 'scale';
  const ordered = await call(ALICE, 'POST', '/cloud/clusters', kube);
  const { id } = ordered.body.cluster;
  payAll();
  await call(ALICE, 'POST', `/cloud/clusters/${id}/payment`);
  finish('us-east-1', 'lyrcloud-cluster-kube', { ClusterName: 'lyrcloud-kube' });
  tables.cloud.get(`cluster#${id}|cluster`).paidThrough = '2020-01-01T00:00:00.000Z';
  tables.cloud.get(`cluster#${id}|cluster`).checkedAt = '2020-01-01T00:00:00.000Z';
  assert.equal((await call(ALICE, 'GET', `/cloud/clusters/${id}`)).body.cluster.fee.active, false);
  assert.equal((await call(ALICE, 'PUT', `/cloud/clusters/${id}`, { nodes: 3 })).status, 402);
  const renew = await call(ALICE, 'POST', `/cloud/clusters/${id}/pay`);
  assert.match(renew.body.payUrl, /lyrpay\.com\/pay\//);
  payAll();
  const renewed = await call(ALICE, 'POST', `/cloud/clusters/${id}/payment`);
  assert.ok(Date.parse(renewed.body.cluster.fee.paidThrough) > Date.now() + 25 * 864e5, 'a month from now');
  assert.equal((await call(ALICE, 'PUT', `/cloud/clusters/${id}`, { nodes: 3 })).status, 200);
  tables.cloud.get(`cluster#${id}|cluster`).paidThrough = '2020-01-01T00:00:00.000Z';
  tables.cloud.get(`cluster#${id}|cluster`).status = 'ready';
  assert.equal((await call(ALICE, 'DELETE', `/cloud/clusters/${id}`)).status, 200, 'deleting is never blocked');
});

test('an unpaid cluster order is dropped when its payment expires', async () => {
  await connect(ALICE);
  const ordered = await call(ALICE, 'POST', '/cloud/clusters', { name: 'kube', provider: 'aws', region: 'us-east-1', kind: 'kubernetes', adminArn: ADMIN_ARN });
  lyrpayments.forEach((p) => { p.status = 'expired'; });
  const list = await call(ALICE, 'GET', '/cloud');
  assert.equal(list.body.clusters.length, 0);
  assert.equal(calls.some((c) => c.name === 'CreateStackCommand'), false);
  assert.equal((await call(ALICE, 'GET', `/cloud/clusters/${ordered.body.cluster.id}`)).status, 404);
});

test('if a paid cluster can’t be built, the fee goes back to the customer', async () => {
  await connect(ALICE);
  stacks.set('us-east-1|lyrcloud-cluster-kube', { StackStatus: 'CREATE_COMPLETE' }); // taken in their account
  const ordered = await call(ALICE, 'POST', '/cloud/clusters', { name: 'kube', provider: 'aws', region: 'us-east-1', kind: 'kubernetes', adminArn: ADMIN_ARN });
  payAll();
  const result = await call(ALICE, 'POST', `/cloud/clusters/${ordered.body.cluster.id}/payment`);
  assert.equal(result.body.cluster.status, 'failed');
  assert.match(result.body.cluster.failureReason, /refunded/);
  assert.equal([...lyrpayments.values()][0].status, 'refunded');
  assert.equal(result.body.cluster.fee.active, false);
});

test('only the super admin switches cloud features, and customers see them', async () => {
  assert.deepEqual((await call(ALICE, 'GET', '/cloud')).body.features, { upsell: false, hosting: false, alibaba: false }, 'off until switched on');
  assert.equal((await call(ALICE, 'PUT', '/admin/cloud/settings', { upsell: true })).status, 403);
  assert.deepEqual((await call(SUPER, 'PUT', '/admin/cloud/settings', { upsell: true, hosting: 'yes' })).body.features, { upsell: true, hosting: false, alibaba: false });
  assert.equal((await call(ALICE, 'GET', '/cloud')).body.features.upsell, true);
});

test('private registry images: the login goes into the customer’s account, never into Lyrcloud', async () => {
  await connect(ALICE);
  const { id } = (await call(ALICE, 'POST', '/cloud/clusters', { name: 'apps', provider: 'aws', region: 'eu-west-1', kind: 'serverless' })).body.cluster;
  finish('eu-west-1', 'lyrcloud-cluster-apps', { ClusterName: 'lyrcloud-apps', VpcId: 'vpc-1', SubnetIds: 'subnet-a,subnet-b', ExecutionRoleArn: 'arn:aws:iam::111122223333:role/lyrcloud-x-exec' });
  assert.equal((await call(ALICE, 'POST', `/cloud/clusters/${id}/services`, { name: 'web', image: 'acme/private:1', registry: { username: 'acme' } })).status, 400, 'password needed');
  const svc = await call(ALICE, 'POST', `/cloud/clusters/${id}/services`, { name: 'web', image: 'acme/private:1', registry: { username: ' acme ', password: 'p"a\\ss' } });
  assert.equal(svc.status, 200);
  assert.deepEqual([svc.body.service.privateRegistry, svc.body.service.registryUser, svc.body.service.registryServer], [true, 'acme', 'index.docker.io']);
  const create = calls.filter((c) => c.name === 'CreateStackCommand').at(-1);
  assert.deepEqual(create.input.Parameters, [{ ParameterKey: 'RegistryLogin', ParameterValue: '{"username":"acme","password":"p\\"a\\\\ss"}' }]);
  const template = stacks.get('eu-west-1|lyrcloud-svc-apps-web').template;
  assert.equal(template.Parameters.RegistryLogin.NoEcho, true);
  assert.equal(template.Resources.RegistrySecret.Properties.Name, `lyrcloud-${svc.body.service.id}-registry`, 'inside the role’s lyrcloud-* secrets');
  assert.deepEqual(template.Resources.RegistryAccess.Properties.Roles, ['lyrcloud-x-exec']);
  assert.deepEqual(template.Resources.Task.Properties.ContainerDefinitions[0].RepositoryCredentials, { CredentialsParameter: { Ref: 'RegistrySecret' } });
  assert.equal(JSON.stringify([...tables.cloud.values()]).includes('p\\"a'), false, 'the password isn’t stored');

  finish('eu-west-1', 'lyrcloud-svc-apps-web', { Url: 'http://lb' });
  const row = tables.cloud.get(`service#${svc.body.service.id}|service`);
  row.status = 'ready';
  await call(ALICE, 'PUT', `/cloud/services/${row.id}`, { image: 'acme/private:2' });
  assert.deepEqual(calls.filter((c) => c.name === 'UpdateStackCommand').at(-1).input.Parameters, [{ ParameterKey: 'RegistryLogin', UsePreviousValue: true }], 'keeps the stored login');
  tables.cloud.get(`service#${row.id}|service`).status = 'ready';
  await call(ALICE, 'PUT', `/cloud/services/${row.id}`, { image: 'nginx', registry: null });
  const update = calls.filter((c) => c.name === 'UpdateStackCommand').at(-1);
  assert.deepEqual(update.input.Parameters, []);
  assert.equal(JSON.parse(update.input.TemplateBody).Resources.RegistrySecret, undefined, 'public again: the secret goes');
});

test('the access role may manage only lyrcloud-* secrets', async () => {
  const { accessRoleTemplate } = await import('./rules.mjs');
  const statement = accessRoleTemplate('479664683751').Resources.Role.Properties.Policies[0].PolicyDocument.Statement.find((s) => s.Sid === 'OwnSecrets');
  assert.deepEqual(statement.Resource, { 'Fn::Sub': 'arn:aws:secretsmanager:*:${AWS::AccountId}:secret:lyrcloud-*' });
  assert.equal(statement.Action.includes('secretsmanager:GetSecretValue'), false, 'Lyrcloud can write logins but never read them back');
});

const SSH_KEY = `ssh-ed25519 ${'A'.repeat(68)} alice@laptop`;

test('Linux servers on AWS: their key, SSH only from where they say, web open; plan limits apply', async () => {
  tables.users.get(ALICE.userId).plan = 'launch';
  await connect(ALICE);
  assert.equal((await call(ALICE, 'POST', '/cloud/servers', { name: 'box', provider: 'aws', region: 'eu-west-1', sshKey: 'not a key' })).status, 400);
  assert.equal((await call(ALICE, 'POST', '/cloud/servers', { name: 'box', provider: 'aws', region: 'eu-west-1', sshKey: SSH_KEY, sshFrom: '300.1.1.1/32' })).status, 400);
  const res = await call(ALICE, 'POST', '/cloud/servers', { name: 'box', provider: 'aws', region: 'eu-west-1', image: 'amazon-linux', size: 'medium', sshKey: SSH_KEY, sshFrom: '203.0.113.7/32' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const template = stacks.get('eu-west-1|lyrcloud-server-box').template;
  assert.equal(template.Resources.Server.Properties.InstanceType, 't3.medium');
  assert.equal(template.Parameters.Image.Default, '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64');
  assert.equal(template.Resources.Key.Properties.PublicKeyMaterial, SSH_KEY);
  assert.deepEqual(template.Resources.Firewall.Properties.SecurityGroupIngress.map((r) => [r.FromPort, r.CidrIp]), [[22, '203.0.113.7/32'], [80, '0.0.0.0/0'], [443, '0.0.0.0/0']]);
  assert.equal(template.Resources.Server.Properties.MetadataOptions.HttpTokens, 'required');
  assert.equal((await call(ALICE, 'POST', '/cloud/servers', { name: 'box2', provider: 'aws', region: 'eu-west-1', sshKey: SSH_KEY })).status, 402, 'Launch manages one server');
  finish('eu-west-1', 'lyrcloud-server-box', { PublicIp: '198.51.100.4', InstanceId: 'i-1' });
  const { id } = res.body.server;
  const ready = await call(ALICE, 'GET', `/cloud/servers/${id}`);
  assert.deepEqual([ready.body.server.status, ready.body.server.ssh], ['ready', 'ssh ec2-user@198.51.100.4']);
  assert.equal((await call(ALICE, 'DELETE', '/cloud/connections/aws')).status, 409, 'servers first');
  assert.equal((await call(BOB, 'GET', `/cloud/servers/${id}`)).status, 404);
  assert.equal((await call(ALICE, 'DELETE', `/cloud/servers/${id}`)).body.server.status, 'deleting');
});

const HOSTING_BASE = {
  pk: '#settings', sk: 'hosting', Region: 'us-east-1', ClusterName: 'lyrcloud-hosting', VpcId: 'vpc-h', SubnetIds: 'subnet-1,subnet-2',
  ExecutionRoleArn: 'arn:aws:iam::479664683751:role/lyrcloud-hosting-exec', ListenerArn: 'arn:listener', BalancerSecurityGroup: 'sg-lb', BalancerDns: 'lb.example.com',
};
const hostingOn = async () => {
  tables.cloud.set('#settings|hosting', { ...HOSTING_BASE });
  await call(SUPER, 'PUT', '/admin/cloud/settings', { hosting: true });
};

test('managed hosting stays hidden until it is built and switched on', async () => {
  assert.equal((await call(ALICE, 'GET', '/cloud/hosting')).status, 404);
  tables.cloud.set('#settings|hosting', { ...HOSTING_BASE });
  assert.equal((await call(ALICE, 'GET', '/cloud/hosting')).status, 404, 'built but off');
  await call(SUPER, 'PUT', '/admin/cloud/settings', { hosting: true });
  const res = await call(ALICE, 'GET', '/cloud/hosting');
  assert.deepEqual([res.status, res.body.credit, res.body.apps], [200, 0, []]);
});

test('hosting, monthly: paid first, built behind CloudFront with a secret header, stopped when unpaid', async () => {
  await hostingOn();
  const ordered = await call(ALICE, 'POST', '/cloud/hosting/apps', { name: 'site', image: 'nginx', size: 'medium', billing: 'monthly' });
  assert.equal(ordered.body.app.status, 'awaiting_payment');
  assert.equal([...lyrpayments.values()][0].amount, '24.00');
  payAll();
  const paid = await call(ALICE, 'POST', `/cloud/hosting/apps/${ordered.body.app.id}/payment`);
  assert.equal(paid.body.app.status, 'creating');
  const template = stacks.get(`us-east-1|lyrcloud-app-${ordered.body.app.id}`).template;
  const token = template.Resources.Rule.Properties.Conditions[0].HttpHeaderConfig.Values[0];
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.deepEqual(template.Resources.Distribution.Properties.DistributionConfig.Origins[0].OriginCustomHeaders, [{ HeaderName: 'x-lyr-app', HeaderValue: token }]);
  assert.equal(template.Resources.TaskSecurity.Properties.SecurityGroupIngress[0].SourceSecurityGroupId, 'sg-lb', 'only the load balancer reaches the containers');
  assert.equal(template.Resources.Service.Properties.DesiredCount, 1);
  assert.equal((await call(BOB, 'GET', `/cloud/hosting/apps/${ordered.body.app.id}`)).status, 404);

  finish('us-east-1', `lyrcloud-app-${ordered.body.app.id}`, { Url: 'https://d123.cloudfront.net' });
  const row = tables.cloud.get(`app#${ordered.body.app.id}|app`);
  assert.equal((await call(ALICE, 'GET', `/cloud/hosting/apps/${row.id}`)).body.app.url, 'https://d123.cloudfront.net');
  const { hostingTick } = await import('./index.mjs');
  assert.deepEqual(await hostingTick(new Date(Date.now() + 20 * 864e5)), { charged: 0, stopped: 0 }, 'inside the month');
  assert.deepEqual(await hostingTick(new Date(Date.now() + 40 * 864e5)), { charged: 0, stopped: 1 }, 'a month and the grace days later');
  assert.equal(stacks.get(`us-east-1|lyrcloud-app-${row.id}`).template.Resources.Service.Properties.DesiredCount, 0, 'stopped, not deleted');
  assert.equal(tables.cloud.get(`app#${row.id}|app`).status, 'stopped');
});

test('hosting, plan and pay as you go: one small app with Scale; credit is charged hourly and stops at zero', async () => {
  await hostingOn();
  tables.users.get(ALICE.userId).plan = 'launch';
  assert.equal((await call(ALICE, 'POST', '/cloud/hosting/apps', { name: 'free', image: 'nginx', billing: 'plan' })).status, 402);
  tables.users.get(ALICE.userId).plan = 'scale';
  assert.equal((await call(ALICE, 'POST', '/cloud/hosting/apps', { name: 'free', image: 'nginx', size: 'large', billing: 'plan' })).status, 400, 'the included app is small');
  assert.equal((await call(ALICE, 'POST', '/cloud/hosting/apps', { name: 'free', image: 'nginx', billing: 'plan' })).body.app.status, 'creating');
  assert.equal((await call(ALICE, 'POST', '/cloud/hosting/apps', { name: 'free2', image: 'nginx', billing: 'plan' })).status, 409, 'one per plan');

  assert.equal((await call(ALICE, 'POST', '/cloud/hosting/apps', { name: 'api', image: 'nginx', size: 'small', billing: 'payg' })).status, 402, 'credit first');
  assert.equal((await call(ALICE, 'POST', '/cloud/hosting/credit', { cents: 123 })).status, 400);
  const buy = await call(ALICE, 'POST', '/cloud/hosting/credit', { cents: 1000 });
  assert.match(buy.body.payUrl, /lyrpay/);
  payAll();
  assert.equal((await call(ALICE, 'POST', '/cloud/hosting/credit/check')).body.credit, 1000);
  assert.equal((await call(ALICE, 'POST', '/cloud/hosting/credit/check')).body.credit, 1000, 'counted once');
  const api = await call(ALICE, 'POST', '/cloud/hosting/apps', { name: 'api', image: 'nginx', size: 'small', count: 2, billing: 'payg' });
  assert.equal(api.status, 200, JSON.stringify(api.body));
  const { hostingTick } = await import('./index.mjs');
  assert.equal((await hostingTick()).charged, 4, '2 copies × 2¢ an hour');
  assert.equal(tables.cloud.get(`credit#${ALICE.userId}|credit`).cents, 996);
  tables.cloud.get(`credit#${ALICE.userId}|credit`).cents = 3;
  assert.equal((await hostingTick()).stopped, 1, 'credit gone');
  assert.equal(tables.cloud.get(`app#${api.body.app.id}|app`).status, 'stopped');
  tables.users.get(ALICE.userId).plan = 'launch';
  const free = [...tables.cloud.values()].find((r) => r.row === 'app' && r.billing === 'plan');
  free.status = 'ready';
  assert.equal((await hostingTick()).stopped, 1, 'plan downgraded: the included app stops');
});
