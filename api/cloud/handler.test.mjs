// Cloud API end to end, with DynamoDB, STS and the customer's CloudFormation/EC2 replaced by fakes.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

process.env.TABLE_NAME = 'cloud';
process.env.USERS_TABLE_NAME = 'users';
process.env.ACCESS_TEMPLATE_URL = 'https://lyrcloud-public.s3.amazonaws.com/cloud/access-role.json';
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
    calls.push({ name, region, input, session: credentials.sessionToken });
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
  for (const person of [SUPER, ALICE, BOB]) tables.users.set(person.userId, { ...person });
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
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'azure', region: 'eastus', kind: 'kubernetes' })).status, 400);
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'aws', region: 'mars-1', kind: 'kubernetes' })).status, 400);
  assert.match((await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'aws', region: 'us-east-1', kind: 'kubernetes' })).body.error, /administer/);
  const res = await call(ALICE, 'POST', '/cloud/clusters', { name: 'prod', provider: 'aws', region: 'us-east-1', kind: 'kubernetes', nodeType: 't3.large', nodes: 3, adminArn: ADMIN_ARN });
  assert.equal(res.status, 200);
  assert.equal(res.body.cluster.status, 'creating');
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
