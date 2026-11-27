// Google Cloud and Azure clusters end to end, with DynamoDB, AWS STS (GetWebIdentityToken) and the customer's
// clouds replaced by fakes. The fakes enforce what the real setup scripts configure: Google only accepts tokens
// tagged with the project's own connection ID; Azure's app only has rights in its lyrcloud-<id> resource group.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { STSClient } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fullImage, remoteName, runBody } from './providers.mjs';

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

// ---- the customers' clouds
let gcpProjects; // projectNumber -> { projectId, connectionId (the provider's condition), services, clusters, public }
let azureApps; // clientId -> { tenantId, subscriptionId, group (where it has Contributor), resources }
let requests;
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
clients.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body;
  requests.push(`${init.method} ${u.host}${u.pathname}`);
  if (u.host === 'sts.googleapis.com') {
    const number = body.audience.match(/projects\/(\d+)\//)[1];
    const project = gcpProjects[number];
    const claims = claimsOf(body.subject_token);
    if (!project || claims.iss !== ISSUER || claims.aud !== `https:${body.audience}` || claims['https://sts.amazonaws.com/'].request_tags.lyrcloud_connection !== project.connectionId) {
      return reply(400, { error: 'invalid_grant', error_description: 'The given credential is rejected by the attribute condition.' });
    }
    return reply(200, { access_token: `fed-${number}` });
  }
  if (u.host === 'iamcredentials.googleapis.com') {
    const number = init.headers.authorization.replace('Bearer fed-', '');
    const project = gcpProjects[number];
    if (!project || !u.pathname.includes(`lyrcloud-access@${project.projectId}.iam`)) return reply(403, { error: { message: 'Permission iam.serviceAccounts.getAccessToken denied' } });
    return reply(200, { accessToken: `gcp-${project.projectId}` });
  }
  if (u.host === 'run.googleapis.com' || u.host === 'container.googleapis.com') {
    const projectId = u.pathname.match(/projects\/([^/]+)\//)[1];
    const project = Object.values(gcpProjects).find((p) => p.projectId === projectId);
    if (init.headers.authorization !== `Bearer gcp-${projectId}`) return reply(403, { error: { message: 'denied' } });
    if (u.host === 'container.googleapis.com') {
      const name = body?.cluster?.name || u.pathname.split('/').pop();
      if (init.method === 'POST') return project.clusters.set(name, { status: 'PROVISIONING', autopilot: body.cluster.autopilot }), reply(200, { name: 'op' });
      if (init.method === 'DELETE') return project.clusters.delete(name), reply(200, {});
      const cluster = project.clusters.get(name);
      return cluster ? reply(200, { ...cluster, endpoint: '34.1.2.3' }) : reply(404, {});
    }
    if (init.method === 'GET' && !u.pathname.match(/services\/[^/:]+$/)) return reply(200, { services: [] });
    const name = u.searchParams.get('serviceId') || u.pathname.split('/').pop().split(':')[0];
    if (u.pathname.endsWith(':setIamPolicy')) return project.public.add(name), reply(200, body.policy);
    if (init.method === 'POST' || init.method === 'PATCH') return project.services.set(name, { body, state: 'CONDITION_PENDING' }), reply(200, { name: 'op' });
    if (init.method === 'DELETE') return project.services.delete(name), reply(200, {});
    const service = project.services.get(name);
    return service ? reply(200, { uri: `https://${name}-abc.a.run.app`, terminalCondition: { state: service.state } }) : reply(404, {});
  }
  if (u.host === 'compute.googleapis.com') {
    const projectId = u.pathname.match(/projects\/([^/]+)\//)[1];
    const project = Object.values(gcpProjects).find((p) => p.projectId === projectId);
    if (init.headers.authorization !== `Bearer gcp-${projectId}`) return reply(403, { error: { message: 'denied' } });
    project.vms ??= new Map();
    project.firewalls ??= new Map();
    if (u.pathname.includes('/firewalls')) {
      if (init.method === 'GET') return project.firewalls.has('lyrcloud-ssh') ? reply(200, project.firewalls.get('lyrcloud-ssh')) : reply(404, {});
      return project.firewalls.set(body.name, body), reply(200, {});
    }
    if (init.method === 'POST') return project.vms.set(body.name, { ...body, zone: u.pathname.split('/zones/')[1].split('/')[0], status: 'PROVISIONING' }), reply(200, {});
    const name = u.pathname.split('/').pop();
    if (init.method === 'DELETE') return project.vms.delete(name), reply(200, {});
    const vm = project.vms.get(name);
    return vm ? reply(200, { status: vm.status, networkInterfaces: [{ accessConfigs: [{ natIP: '34.0.0.9' }] }] }) : reply(404, {});
  }
  if (u.host === 'login.microsoftonline.com') {
    const app = azureApps[body.client_id];
    const claims = claimsOf(body.client_assertion);
    if (!app || !u.pathname.startsWith(`/${app.tenantId}/`) || claims.iss !== ISSUER || claims.sub !== LAMBDA || claims.aud !== 'api://AzureADTokenExchange') {
      return reply(400, { error: 'invalid_client', error_description: 'AADSTS70021: No matching federated identity record found.' });
    }
    return reply(200, { access_token: `az-${body.client_id}` });
  }
  if (u.host === 'management.azure.com') {
    const app = azureApps[init.headers.authorization.replace('Bearer az-', '')];
    const group = u.pathname.match(/resourceGroups\/([^/]+)/)?.[1];
    if (!app || u.pathname.split('/')[2] !== app.subscriptionId || group !== app.group) return reply(403, { error: { message: 'AuthorizationFailed' } });
    const path = u.pathname.split('/providers/')[1];
    if (!path) return reply(200, { name: group });
    if (path.endsWith('/listSecrets')) return reply(200, { value: app.resources.get(path.replace('/listSecrets', '')).properties.configuration.secrets || [] });
    if (init.method === 'PUT') return app.resources.set(path, { ...body, properties: { ...body.properties, provisioningState: 'InProgress' } }), reply(200, { id: `/x/${path}` });
    if (init.method === 'DELETE') return app.resources.delete(path), reply(202, {});
    const resource = app.resources.get(path);
    return resource ? reply(200, resource) : reply(404, {});
  }
  throw new Error(`unexpected request ${url}`);
};

// Orders a Kubernetes cluster, "pays" its first month in Lyrpay, and returns the built cluster.
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

beforeEach(() => {
  tables = { users: new Map(), cloud: new Map() };
  for (const person of [ALICE, MALLORY]) tables.users.set(person.userId, { ...person, plan: 'scale' });
  lyrpayments = new Map();
  gcpProjects = {};
  azureApps = {};
  requests = [];
});

test('Google Cloud: the setup script trusts only this connection, and a stranger can’t claim the project', async () => {
  const started = await call(ALICE, 'POST', '/cloud/connections/gcp');
  const { connectionId, setupScript, status } = started.body.connection;
  assert.equal(status, 'pending');
  assert.match(connectionId, /^lyr[a-f0-9]{10}$/);
  assert.match(setupScript, new RegExp(`request_tags.lyrcloud_connection == '${connectionId}'`));
  assert.match(setupScript, new RegExp(`--issuer-uri="${ISSUER}"`));
  assert.equal((await call(ALICE, 'PUT', '/cloud/connections/gcp', { projectId: 'acme-prod', projectNumber: 'x' })).status, 400);
  assert.equal((await call(ALICE, 'PUT', '/cloud/connections/gcp', { projectId: 'acme-prod', projectNumber: '123456789' })).status, 403, 'script not run yet');

  gcpProjects['123456789'] = { projectId: 'acme-prod', connectionId, services: new Map(), clusters: new Map(), public: new Set() };
  const done = await call(ALICE, 'PUT', '/cloud/connections/gcp', { projectId: 'acme-prod', projectNumber: '123456789' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.connection.status, 'connected');
  assert.equal(done.body.connection.setupScript, null);

  // Mallory knows Alice's project ID and number, but her own connection ID isn't the one Alice's provider accepts.
  await call(MALLORY, 'POST', '/cloud/connections/gcp');
  assert.equal((await call(MALLORY, 'PUT', '/cloud/connections/gcp', { projectId: 'acme-prod', projectNumber: '123456789' })).status, 403);
});

test('Google Cloud: Cloud Run services go public once ready; Autopilot clusters have nothing to resize', async () => {
  const { connectionId } = (await call(ALICE, 'POST', '/cloud/connections/gcp')).body.connection;
  const project = gcpProjects['123456789'] = { projectId: 'acme-prod', connectionId, services: new Map(), clusters: new Map(), public: new Set() };
  await call(ALICE, 'PUT', '/cloud/connections/gcp', { projectId: 'acme-prod', projectNumber: '123456789' });

  const run = await call(ALICE, 'POST', '/cloud/clusters', { name: 'web', provider: 'gcp', region: 'us-central1', kind: 'serverless' });
  assert.equal(run.body.cluster.status, 'ready', 'a Cloud Run region needs nothing built');
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'web', provider: 'gcp', region: 'mars-1', kind: 'serverless' })).status, 400);
  const created = await call(ALICE, 'POST', `/cloud/clusters/${run.body.cluster.id}/services`, { name: 'site', image: 'nginx:latest', port: 80, count: 1 });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(project.services.get('web-site').body.template.containers[0].image, 'docker.io/library/nginx:latest');
  project.services.get('web-site').state = 'CONDITION_SUCCEEDED';
  const detail = await call(ALICE, 'GET', `/cloud/clusters/${run.body.cluster.id}`);
  assert.equal(detail.body.services[0].status, 'ready');
  assert.equal(detail.body.services[0].url, 'https://web-site-abc.a.run.app');
  assert.ok(project.public.has('web-site'), 'anyone can open it');
  assert.equal((await call(ALICE, 'DELETE', `/cloud/clusters/${run.body.cluster.id}`)).status, 409, 'services first');

  const gke = await orderPaid(ALICE, { name: 'kube', provider: 'gcp', region: 'europe-west1', kind: 'kubernetes' });
  assert.equal(gke.body.cluster.status, 'creating');
  assert.equal(project.clusters.get('lyrcloud-kube').autopilot.enabled, true);
  project.clusters.get('lyrcloud-kube').status = 'RUNNING';
  const kube = await call(ALICE, 'GET', `/cloud/clusters/${gke.body.cluster.id}`);
  assert.equal(kube.body.cluster.status, 'ready');
  assert.match(kube.body.kubectl, /gcloud container clusters get-credentials lyrcloud-kube --region europe-west1 --project acme-prod/);
  assert.equal((await call(ALICE, 'PUT', `/cloud/clusters/${gke.body.cluster.id}`, { nodes: 3 })).status, 400);
  assert.equal((await call(ALICE, 'DELETE', `/cloud/clusters/${gke.body.cluster.id}`)).body.cluster.status, 'deleting');
  assert.equal(project.clusters.size, 0);
});

test('Azure: Lyrcloud only works in the connection’s own resource group', async () => {
  const started = await call(ALICE, 'POST', '/cloud/connections/azure');
  const { connectionId, setupScript } = started.body.connection;
  assert.match(setupScript, new RegExp(`az group create --name lyrcloud-${connectionId}`));
  assert.ok(setupScript.includes(`"subject":"${LAMBDA}"`) && setupScript.includes('"audiences":["api://AzureADTokenExchange"]'));
  const ids = { tenantId: '11111111-1111-1111-1111-111111111111', subscriptionId: '22222222-2222-2222-2222-222222222222', clientId: '33333333-3333-3333-3333-333333333333' };
  const app = azureApps[ids.clientId] = { ...ids, group: `lyrcloud-${connectionId}`, resources: new Map() };
  assert.equal((await call(ALICE, 'PUT', '/cloud/connections/azure', { ...ids, clientId: 'nope' })).status, 400);
  assert.equal((await call(ALICE, 'PUT', '/cloud/connections/azure', ids)).status, 200);

  // Mallory pastes Alice's IDs: Azure signs her in (the app trusts Lyrcloud), but her resource group isn't there.
  await call(MALLORY, 'POST', '/cloud/connections/azure');
  assert.equal((await call(MALLORY, 'PUT', '/cloud/connections/azure', ids)).status, 403);
  requests = []; // from here on, only Alice's cluster work

  const aks = await orderPaid(ALICE, { name: 'kube', provider: 'azure', region: 'westeurope', kind: 'kubernetes', nodeType: 'Standard_B2s', nodes: 2 });
  assert.equal(aks.status, 200, JSON.stringify(aks.body));
  const resource = app.resources.get('Microsoft.ContainerService/managedClusters/lyrcloud-kube');
  assert.equal(resource.properties.agentPoolProfiles[0].count, 2);
  assert.ok(aks.body.cluster.estimate.monthly > 0);
  assert.equal((await call(ALICE, 'POST', '/cloud/clusters', { name: 'big', provider: 'azure', region: 'westeurope', kind: 'kubernetes', nodeType: 't3.medium' })).status, 400);
  resource.properties.provisioningState = 'Succeeded';
  assert.equal((await call(ALICE, 'GET', `/cloud/clusters/${aks.body.cluster.id}`)).body.cluster.status, 'ready');
  assert.equal((await call(ALICE, 'PUT', `/cloud/clusters/${aks.body.cluster.id}`, { nodes: 4 })).status, 200);
  assert.equal(app.resources.get('Microsoft.ContainerService/managedClusters/lyrcloud-kube/agentPools/system').properties.count, 4);

  const env = await call(ALICE, 'POST', '/cloud/clusters', { name: 'apps', provider: 'azure', region: 'eastus', kind: 'serverless' });
  app.resources.get('Microsoft.App/managedEnvironments/lyrcloud-apps').properties.provisioningState = 'Succeeded';
  const svc = await call(ALICE, 'POST', `/cloud/clusters/${env.body.cluster.id}/services`, { name: 'api', image: 'ghcr.io/acme/api:1.2', port: 8080, size: 'medium', count: 0 });
  assert.equal(svc.status, 200, JSON.stringify(svc.body));
  const containerApp = app.resources.get('Microsoft.App/containerApps/apps-api');
  assert.equal(containerApp.properties.template.containers[0].image, 'ghcr.io/acme/api:1.2');
  assert.equal(containerApp.properties.template.scale.minReplicas, 0);
  containerApp.properties.provisioningState = 'Succeeded';
  containerApp.properties.configuration.ingress.fqdn = 'apps-api.eastus.azurecontainerapps.io';
  assert.equal((await call(ALICE, 'GET', `/cloud/services/${svc.body.service.id}`)).body.service.url, 'https://apps-api.eastus.azurecontainerapps.io');
  assert.ok(requests.every((r) => !r.includes('management.azure.com') || r.includes(`lyrcloud-${connectionId}`)), 'never outside its resource group');
});

test('names and images for the other clouds', () => {
  assert.equal(fullImage('nginx'), 'docker.io/library/nginx');
  assert.equal(fullImage('acme/api:2'), 'docker.io/acme/api:2');
  assert.equal(fullImage('ghcr.io/acme/api:2'), 'ghcr.io/acme/api:2');
  assert.equal(fullImage('us-docker.pkg.dev/p/r/i@sha256:abc'), 'us-docker.pkg.dev/p/r/i@sha256:abc');
  assert.equal(remoteName(['a-very-long-cluster-name-here', 'and-a-long-service'], 32), 'a-very-long-cluster-name-here-an');
  const body = runBody({ image: 'nginx', port: 8080, size: 'large', count: 2, env: { A: 1 }, healthPath: '/health' });
  assert.deepEqual(body.template.scaling, { minInstanceCount: 2, maxInstanceCount: 3 });
  assert.deepEqual(body.template.containers[0].env, [{ name: 'A', value: '1' }]);
  assert.equal(body.template.containers[0].startupProbe.httpGet.path, '/health');
});

test('private images: Azure keeps the password with the app; Cloud Run points to Artifact Registry', async () => {
  const { connectionId } = (await call(ALICE, 'POST', '/cloud/connections/azure')).body.connection;
  const ids = { tenantId: '11111111-1111-1111-1111-111111111111', subscriptionId: '22222222-2222-2222-2222-222222222222', clientId: '33333333-3333-3333-3333-333333333333' };
  const app = azureApps[ids.clientId] = { ...ids, group: `lyrcloud-${connectionId}`, resources: new Map() };
  await call(ALICE, 'PUT', '/cloud/connections/azure', ids);
  const env = await call(ALICE, 'POST', '/cloud/clusters', { name: 'apps', provider: 'azure', region: 'eastus', kind: 'serverless' });
  app.resources.get('Microsoft.App/managedEnvironments/lyrcloud-apps').properties.provisioningState = 'Succeeded';
  const svc = await call(ALICE, 'POST', `/cloud/clusters/${env.body.cluster.id}/services`, { name: 'api', image: 'ghcr.io/acme/api:1', registry: { username: 'acme', password: 'ghp_secret' } });
  assert.equal(svc.status, 200, JSON.stringify(svc.body));
  const config = app.resources.get('Microsoft.App/containerApps/apps-api').properties.configuration;
  assert.deepEqual(config.registries, [{ server: 'ghcr.io', username: 'acme', passwordSecretRef: 'registry-password' }]);
  assert.deepEqual(config.secrets, [{ name: 'registry-password', value: 'ghp_secret' }]);
  app.resources.get('Microsoft.App/containerApps/apps-api').properties.provisioningState = 'Succeeded';
  tables.cloud.get(`service#${svc.body.service.id}|service`).status = 'ready';
  assert.equal((await call(ALICE, 'PUT', `/cloud/services/${svc.body.service.id}`, { image: 'ghcr.io/acme/api:2' })).status, 200);
  assert.deepEqual(app.resources.get('Microsoft.App/containerApps/apps-api').properties.configuration.secrets, [{ name: 'registry-password', value: 'ghp_secret' }], 'kept on redeploy');
  assert.equal(JSON.stringify([...tables.cloud.values()]).includes('ghp_secret'), false);

  const gcp = (await call(ALICE, 'POST', '/cloud/connections/gcp')).body.connection;
  gcpProjects['123456789'] = { projectId: 'acme-prod', connectionId: gcp.connectionId, services: new Map(), clusters: new Map(), public: new Set() };
  await call(ALICE, 'PUT', '/cloud/connections/gcp', { projectId: 'acme-prod', projectNumber: '123456789' });
  const run = await call(ALICE, 'POST', '/cloud/clusters', { name: 'web', provider: 'gcp', region: 'us-central1', kind: 'serverless' });
  const refused = await call(ALICE, 'POST', `/cloud/clusters/${run.body.cluster.id}/services`, { name: 'site', image: 'acme/private', registry: { username: 'a', password: 'b' } });
  assert.deepEqual([refused.status, /Artifact Registry/.test(refused.body.error)], [400, true]);
});

const KEY = `ssh-ed25519 ${'B'.repeat(68)} me`;

test('Linux servers on Google Cloud and Azure', async () => {
  const gcp = (await call(ALICE, 'POST', '/cloud/connections/gcp')).body.connection;
  assert.match(gcp.setupScript, /roles\/compute\.instanceAdmin\.v1/);
  const project = gcpProjects['123456789'] = { projectId: 'acme-prod', connectionId: gcp.connectionId, services: new Map(), clusters: new Map(), public: new Set() };
  await call(ALICE, 'PUT', '/cloud/connections/gcp', { projectId: 'acme-prod', projectNumber: '123456789' });
  assert.equal((await call(ALICE, 'POST', '/cloud/servers', { name: 'box', provider: 'gcp', region: 'us-central1', image: 'amazon-linux', sshKey: KEY })).status, 400, 'Amazon Linux is AWS only');
  const g = await call(ALICE, 'POST', '/cloud/servers', { name: 'box', provider: 'gcp', region: 'us-central1', image: 'debian', sshKey: KEY, sshFrom: '198.51.100.0/24' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const vm = project.vms.get('lyrcloud-box');
  assert.equal(vm.zone, 'us-central1-b');
  assert.match(vm.machineType, /e2-small$/);
  assert.deepEqual(vm.metadata.items, [{ key: 'ssh-keys', value: `admin:${KEY}` }]);
  assert.deepEqual(project.firewalls.get('lyrcloud-ssh').sourceRanges, ['198.51.100.0/24']);
  vm.status = 'RUNNING';
  assert.equal((await call(ALICE, 'GET', `/cloud/servers/${g.body.server.id}`)).body.server.ssh, 'ssh admin@34.0.0.9');
  await call(ALICE, 'DELETE', `/cloud/servers/${g.body.server.id}`);
  assert.equal(project.vms.size, 0);

  const az = (await call(ALICE, 'POST', '/cloud/connections/azure')).body.connection;
  const ids = { tenantId: '11111111-1111-1111-1111-111111111111', subscriptionId: '22222222-2222-2222-2222-222222222222', clientId: '33333333-3333-3333-3333-333333333333' };
  const app = azureApps[ids.clientId] = { ...ids, group: `lyrcloud-${az.connectionId}`, resources: new Map() };
  await call(ALICE, 'PUT', '/cloud/connections/azure', ids);
  const a = await call(ALICE, 'POST', '/cloud/servers', { name: 'web', provider: 'azure', region: 'westeurope', image: 'ubuntu', size: 'large', sshKey: KEY });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const deployment = app.resources.get('Microsoft.Resources/deployments/lyrcloud-web');
  const vmRes = deployment.properties.template.resources.find((r) => r.type === 'Microsoft.Compute/virtualMachines');
  assert.equal(vmRes.properties.hardwareProfile.vmSize, 'Standard_B2ms');
  assert.equal(vmRes.properties.osProfile.linuxConfiguration.disablePasswordAuthentication, true);
  assert.equal(vmRes.properties.networkProfile.networkInterfaceConfigurations[0].properties.deleteOption, 'Delete', 'card and IP go with the VM');
  deployment.properties.provisioningState = 'Succeeded';
  app.resources.set('Microsoft.Network/publicIPAddresses/lyrcloud-web-ip', { properties: { ipAddress: '20.0.0.5' } });
  assert.equal((await call(ALICE, 'GET', `/cloud/servers/${a.body.server.id}`)).body.server.ssh, 'ssh ubuntu@20.0.0.5');
  app.resources.set('Microsoft.Compute/virtualMachines/lyrcloud-web', { properties: {} });
  app.resources.set('Microsoft.Network/networkSecurityGroups/lyrcloud-web-nsg', { properties: {} });
  await call(ALICE, 'DELETE', `/cloud/servers/${a.body.server.id}`);
  assert.equal(app.resources.has('Microsoft.Compute/virtualMachines/lyrcloud-web'), false);
  tables.cloud.get(`server#${a.body.server.id}|server`).checkedAt = '2020-01-01T00:00:00.000Z';
  assert.equal((await call(ALICE, 'GET', `/cloud/servers/${a.body.server.id}`)).body.server.status, 'deleted');
  assert.equal(app.resources.has('Microsoft.Network/networkSecurityGroups/lyrcloud-web-nsg'), false, 'its firewall goes after it');
});
