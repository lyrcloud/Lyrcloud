// Lyrcloud Cloud API: connect your own AWS account, then create container clusters (EKS or ECS
// Fargate) in any AWS region and run container services on them. Everything is built in the
// customer's account with CloudFormation, so they own it and their AWS bill pays for it; Lyrcloud
// keeps only the connection and what it created. Other providers are in the region catalog
// (src/clouds.js) and come later.
//
//   GET    /cloud                                 your connection, clusters and services
//   POST   /cloud/connections/aws                 start connecting: your ExternalId and the one-click setup link
//   PUT    /cloud/connections/aws                 { roleArn | accountId } finish connecting (Lyrcloud checks it can sign in)
//   DELETE /cloud/connections/aws                 forget the connection (no clusters left)
//   POST   /cloud/clusters                        { name, provider: "aws", region, kind, nodeType?, nodes?, adminArn? }
//   GET    /cloud/clusters/{id}                   a cluster, refreshed from CloudFormation
//   PUT    /cloud/clusters/{id}                   { nodes } resize a Kubernetes cluster
//   DELETE /cloud/clusters/{id}                   tear it down (its services first)
//   POST   /cloud/clusters/{id}/services          { name, image, port?, size?, count?, env?, healthPath? } (serverless clusters)
//   GET    /cloud/services/{id}                   a service, refreshed
//   PUT    /cloud/services/{id}                   { image?, port?, size?, count?, env?, healthPath? } redeploy with changes
//   DELETE /cloud/services/{id}                   remove it
//   GET    /admin/cloud                           every connection, cluster and service (staff)
import { randomBytes } from 'node:crypto';
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, UpdateStackCommand } from '@aws-sdk/client-cloudformation';
import { DescribeAvailabilityZonesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { CreateServiceLinkedRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isStaff, roleFor } from '../account/roles.mjs';
import { findRegion } from '../../src/clouds.js';
import {
  ACCESS_ROLE_NAME,
  cleanName,
  clusterError,
  clusterEstimate,
  clusterTemplate,
  EKS_UNSUPPORTED_ZONES,
  launchUrl,
  MAX_CLUSTERS,
  MAX_SERVICES_PER_CLUSTER,
  roleArnFrom,
  serviceError,
  serviceEstimate,
  serviceTemplate,
  stackState,
} from './rules.mjs';

const env = process.env;
const TABLE = env.TABLE_NAME;
const USERS_TABLE = env.USERS_TABLE_NAME;
const SUPER_ADMIN_EMAIL = env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com';
const ACCESS_TEMPLATE_URL = env.ACCESS_TEMPLATE_URL;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const sts = new STSClient({});
// Region-specific clients for the customer's account. Tests replace these factories.
export const clients = {
  cloudformation: (region, credentials) => new CloudFormationClient({ region, credentials }),
  ec2: (region, credentials) => new EC2Client({ region, credentials }),
  iam: (credentials) => new IAMClient({ region: 'us-east-1', credentials }),
};

// ---------------------------------------------------------------- helpers

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const error = (statusCode, message) => json(statusCode, { error: message });
const now = () => new Date().toISOString();
function parseJson(event) {
  try {
    return JSON.parse((event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body) || '{}');
  } catch {
    return null;
  }
}

const connectionKey = (userId) => ({ pk: `conn#${userId}`, sk: 'aws' });
const clusterKey = (id) => ({ pk: `cluster#${id}`, sk: 'cluster' });
const serviceKey = (id) => ({ pk: `service#${id}`, sk: 'service' });
const getItem = async (key) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: key }))).Item;
const put = (item) => ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
const remove = (key) => ddb.send(new DeleteCommand({ TableName: TABLE, Key: key }));
const shortId = () => randomBytes(4).toString('hex');

async function update(key, set) {
  const names = {};
  const values = {};
  const parts = Object.entries(set).map(([field, value], i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = value;
    return `#f${i} = :v${i}`;
  });
  const { Attributes } = await ddb.send(new UpdateCommand({ TableName: TABLE, Key: key, UpdateExpression: `SET ${parts.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW' }));
  return Attributes;
}

async function itemsOf(ownerId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ TableName: TABLE, IndexName: 'byOwner', KeyConditionExpression: 'ownerId = :o', ExpressionAttributeValues: { ':o': ownerId }, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function caller(event) {
  const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!userId) return null;
  const profile = (await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }))).Item || { userId };
  return { userId, profile, role: roleFor(profile, SUPER_ADMIN_EMAIL), email: profile.email || null };
}

export class CloudError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Signs in to the customer's account through their LyrcloudAccess role.
async function credentialsFor(connection) {
  if (!connection?.roleArn) throw new CloudError(409, 'Connect your AWS account first.');
  try {
    const { Credentials } = await sts.send(new AssumeRoleCommand({
      RoleArn: connection.roleArn,
      ExternalId: connection.externalId,
      RoleSessionName: `lyrcloud-${String(connection.ownerId).slice(0, 8)}`,
      DurationSeconds: 900,
    }));
    return { accessKeyId: Credentials.AccessKeyId, secretAccessKey: Credentials.SecretAccessKey, sessionToken: Credentials.SessionToken };
  } catch (err) {
    if (err.name === 'AccessDenied' || err.name === 'AccessDeniedException') {
      throw new CloudError(403, 'Lyrcloud can’t sign in to your AWS account. Check the lyrcloud-access stack still exists and uses your connection ID.');
    }
    throw err;
  }
}

// Turns AWS errors from the customer's account into messages they can act on.
function awsMessage(err) {
  if (err.name === 'OptInRequired' || /not opted in|OptInRequired/i.test(err.message)) return 'This region isn’t enabled in your AWS account. Enable it under Account → AWS Regions, then try again.';
  if (err.name === 'AlreadyExistsException') return 'A cluster or service with this name already exists in that region of your account.';
  if (err.name === 'AccessDenied' || err.name === 'AccessDeniedException' || err.name === 'UnauthorizedOperation') return 'Your LyrcloudAccess role isn’t allowed to do this. Update the lyrcloud-access stack to the latest template.';
  if (err.name === 'ValidationError') return err.message;
  return null;
}

const stackName = (item) => item.stackName;
async function describeStack(cf, name) {
  try {
    const { Stacks } = await cf.send(new DescribeStacksCommand({ StackName: name }));
    return Stacks?.[0] || null;
  } catch (err) {
    if (err.name === 'ValidationError' && /does not exist/.test(err.message)) return null;
    throw err;
  }
}

// The first thing that went wrong in a failed stack, in CloudFormation's words.
async function failureReason(cf, name) {
  try {
    const { StackEvents } = await cf.send(new DescribeStackEventsCommand({ StackName: name }));
    const failed = (StackEvents || []).filter((e) => /FAILED$/.test(e.ResourceStatus) && e.ResourceStatusReason && !/cancelled|Resource creation cancelled/i.test(e.ResourceStatusReason));
    const first = failed.at(-1);
    return first ? `${first.LogicalResourceId}: ${first.ResourceStatusReason}` : null;
  } catch {
    return null;
  }
}

const outputsOf = (stack) => Object.fromEntries((stack?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));

// ---------------------------------------------------------------- shapes

const publicConnection = (item) => item && ({
  provider: 'aws',
  status: item.roleArn ? 'connected' : 'pending',
  externalId: item.externalId,
  roleArn: item.roleArn || null,
  accountId: item.accountId || null,
  connectedAt: item.connectedAt || null,
  launchUrl: ACCESS_TEMPLATE_URL ? launchUrl(ACCESS_TEMPLATE_URL, item.externalId) : null,
  templateUrl: ACCESS_TEMPLATE_URL || null,
});

const publicCluster = (item) => ({
  id: item.id, name: item.name, provider: item.provider, region: item.region, kind: item.kind,
  nodeType: item.nodeType || null, nodes: item.nodes ?? null, adminArn: item.adminArn || null,
  status: item.status, failureReason: item.failureReason || null, outputs: item.outputs || {},
  estimate: clusterEstimate(item), createdAt: item.createdAt, updatedAt: item.updatedAt || null,
  stackName: item.stackName,
});

const publicService = (item) => ({
  id: item.id, clusterId: item.clusterId, name: item.name, image: item.image, port: item.port, size: item.size, count: item.count,
  env: item.env || {}, healthPath: item.healthPath, status: item.status, failureReason: item.failureReason || null,
  url: item.outputs?.Url || null, estimate: serviceEstimate(item), createdAt: item.createdAt, updatedAt: item.updatedAt || null,
});

// ---------------------------------------------------------------- refresh from CloudFormation

// Brings a cluster or service row up to date with its stack. Deleted stacks remove the row.
async function refresh(item, key, credentials) {
  if (['ready', 'failed', 'deleted'].includes(item.status) && Date.now() - Date.parse(item.checkedAt || 0) < 60_000) return item;
  const cf = clients.cloudformation(item.region, credentials);
  const stack = await describeStack(cf, stackName(item));
  const status = stackState(stack?.StackStatus);
  if (status === 'deleted') {
    if (item.status === 'deleting' || !stack) {
      await remove(key);
      return { ...item, status: 'deleted' };
    }
  }
  const set = { status, checkedAt: now(), outputs: outputsOf(stack) };
  if (status === 'failed' || status === 'delete_failed') set.failureReason = (await failureReason(cf, stackName(item))) || stack?.StackStatusReason || 'CloudFormation reported a failure.';
  else set.failureReason = null;
  if (stack?.StackStatus === 'UPDATE_ROLLBACK_COMPLETE') set.failureReason = `The last change didn’t work and was undone: ${(await failureReason(cf, stackName(item))) || 'see CloudFormation in your account.'}`;
  return update(key, set);
}

// ---------------------------------------------------------------- connection

async function connectionRoutes(event, method, who) {
  const key = connectionKey(who.userId);
  const existing = await getItem(key);
  if (method === 'POST') {
    if (existing) return json(200, { connection: publicConnection(existing) });
    // Shown to the customer and stored in their role's trust policy; it's what proves the role is meant for them.
    const item = { ...key, row: 'connection', ownerId: who.userId, ownerEmail: who.email, provider: 'aws', externalId: `lyr-${randomBytes(18).toString('base64url')}`, createdAt: now() };
    await put(item);
    return json(200, { connection: publicConnection(item) });
  }
  if (method === 'PUT') {
    if (!existing) return error(409, 'Start connecting first.');
    const body = parseJson(event);
    const roleArn = roleArnFrom(body?.roleArn || body?.accountId);
    if (!roleArn) return error(400, 'Paste the RoleArn from the lyrcloud-access stack’s Outputs, or your 12-digit AWS account ID.');
    const trial = { ...existing, roleArn };
    const credentials = await credentialsFor(trial);
    if (!credentials) return error(403, 'Lyrcloud couldn’t sign in to that account.');
    const saved = { ...existing, roleArn, accountId: roleArn.split(':')[4], connectedAt: now() };
    await put(saved);
    return json(200, { connection: publicConnection(saved) });
  }
  if (method === 'DELETE') {
    const clusters = (await itemsOf(who.userId)).filter((item) => item.row === 'cluster');
    if (clusters.length) return error(409, 'Delete your clusters first; Lyrcloud needs the connection to take them down.');
    await remove(key);
    return json(200, { disconnected: true });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- clusters

// AWS services act through "service-linked" roles that only exist once an account has used them. A fresh
// account has none, and ECS/EKS then fail with "Unable to assume the service linked role", so create
// them first (an existing one is fine).
const LINKED_ROLES = {
  kubernetes: ['eks.amazonaws.com', 'eks-nodegroup.amazonaws.com', 'autoscaling.amazonaws.com'],
  serverless: ['ecs.amazonaws.com'],
  service: ['ecs.amazonaws.com', 'elasticloadbalancing.amazonaws.com'],
};
async function ensureLinkedRoles(kind, credentials) {
  const iam = clients.iam(credentials);
  for (const AWSServiceName of LINKED_ROLES[kind]) {
    try {
      await iam.send(new CreateServiceLinkedRoleCommand({ AWSServiceName }));
    } catch (err) {
      if (err.name !== 'InvalidInputException' || !/has been taken|already exists/i.test(err.message)) throw err;
    }
  }
}

// Two or three zones in the region where the cluster kind can run.
async function zonesFor(region, kind, credentials) {
  const { AvailabilityZones } = await clients.ec2(region, credentials).send(new DescribeAvailabilityZonesCommand({
    Filters: [{ Name: 'zone-type', Values: ['availability-zone'] }, { Name: 'state', Values: ['available'] }],
  }));
  const zones = (AvailabilityZones || [])
    .filter((zone) => kind !== 'kubernetes' || !EKS_UNSUPPORTED_ZONES.includes(zone.ZoneId))
    .map((zone) => zone.ZoneName)
    .sort()
    .slice(0, 3);
  if (zones.length < 2) throw new CloudError(400, 'This region doesn’t have enough availability zones for a cluster.');
  return zones;
}

async function createCluster(event, who) {
  const body = parseJson(event);
  const region = findRegion(body?.provider, body?.region);
  const refused = clusterError(body, region);
  if (refused) return error(...refused);
  const name = cleanName(body.name);
  const items = await itemsOf(who.userId);
  const clusters = items.filter((item) => item.row === 'cluster');
  if (clusters.length >= MAX_CLUSTERS) return error(409, `You can have up to ${MAX_CLUSTERS} clusters.`);
  if (clusters.some((item) => item.name === name && item.region === region.code)) return error(409, `You already have a cluster called ${name} in ${region.city}.`);
  const connection = items.find((item) => item.row === 'connection');
  const credentials = await credentialsFor(connection);
  const config = {
    kind: body.kind,
    ...(body.kind === 'kubernetes' ? { nodeType: body.nodeType || 't3.medium', nodes: body.nodes ?? 2, adminArn: body.adminArn.trim() } : {}),
  };
  const id = shortId();
  await ensureLinkedRoles(body.kind, credentials);
  const zones = await zonesFor(region.code, body.kind, credentials);
  const template = clusterTemplate({ id, name, zones, ...config });
  const item = {
    ...clusterKey(id), row: 'cluster', id, ownerId: who.userId, ownerEmail: who.email, provider: 'aws', region: region.code, name, zones,
    ...config, stackName: `lyrcloud-cluster-${name}`, status: 'creating', createdAt: now(),
  };
  try {
    const { StackId } = await clients.cloudformation(region.code, credentials).send(new CreateStackCommand({
      StackName: item.stackName,
      TemplateBody: JSON.stringify(template),
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      OnFailure: 'ROLLBACK',
      Tags: [{ Key: 'lyrcloud', Value: 'managed' }, { Key: 'lyrcloud:cluster', Value: name }],
    }));
    item.stackId = StackId;
  } catch (err) {
    const message = awsMessage(err);
    if (message) return error(400, message);
    throw err;
  }
  await put(item);
  return json(200, { cluster: publicCluster(item) });
}

async function ownedCluster(id, who) {
  const item = /^[a-f0-9]{8}$/.test(id) && (await getItem(clusterKey(id)));
  if (!item || (item.ownerId !== who.userId && !isStaff(who.role))) return null;
  return item;
}

async function clusterRoutes(event, method, path, who) {
  if (path === '/cloud/clusters' && method === 'POST') return createCluster(event, who);
  const match = path.match(/^\/cloud\/clusters\/([^/]+)(\/services)?$/);
  if (!match) return error(404, 'not_found');
  const item = await ownedCluster(match[1], who);
  if (!item) return error(404, 'That cluster isn’t in your account.');
  if (item.ownerId !== who.userId && method !== 'GET') return error(403, 'Only the owner can change this cluster.');
  const connection = await getItem(connectionKey(item.ownerId));
  const credentials = await credentialsFor(connection);
  if (match[2]) return method === 'POST' ? createService(event, item, who, credentials) : error(404, 'not_found');

  if (method === 'GET') {
    const fresh = await refresh(item, clusterKey(item.id), credentials);
    const services = (await itemsOf(item.ownerId)).filter((row) => row.row === 'service' && row.clusterId === item.id).map(publicService);
    return json(200, { cluster: publicCluster(fresh), services });
  }
  if (method === 'PUT') {
    if (item.kind !== 'kubernetes') return error(400, 'Serverless clusters grow with their services; there’s nothing to resize.');
    const nodes = parseJson(event)?.nodes;
    if (!Number.isInteger(nodes) || nodes < 1 || nodes > 20) return error(400, 'Use 1 to 20 worker nodes.');
    if (item.status !== 'ready') return error(409, 'Wait until the cluster is ready.');
    const template = clusterTemplate({ ...item, nodes });
    try {
      await clients.cloudformation(item.region, credentials).send(new UpdateStackCommand({ StackName: item.stackName, TemplateBody: JSON.stringify(template), Capabilities: ['CAPABILITY_NAMED_IAM'] }));
    } catch (err) {
      if (err.name === 'ValidationError' && /No updates/.test(err.message)) return json(200, { cluster: publicCluster(item) });
      const message = awsMessage(err);
      if (message) return error(400, message);
      throw err;
    }
    return json(200, { cluster: publicCluster(await update(clusterKey(item.id), { nodes, status: 'updating', updatedAt: now() })) });
  }
  if (method === 'DELETE') {
    const services = (await itemsOf(item.ownerId)).filter((row) => row.row === 'service' && row.clusterId === item.id);
    if (services.length) return error(409, 'Remove this cluster’s services first.');
    await clients.cloudformation(item.region, credentials).send(new DeleteStackCommand({ StackName: item.stackName }));
    return json(200, { cluster: publicCluster(await update(clusterKey(item.id), { status: 'deleting', updatedAt: now() })) });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- services

const serviceConfig = (body, base = {}) => ({
  image: String(body.image ?? base.image).trim(),
  port: body.port ?? base.port ?? 80,
  size: body.size ?? base.size ?? 'small',
  count: body.count ?? base.count ?? 1,
  env: body.env ?? base.env ?? {},
  healthPath: body.healthPath ?? base.healthPath ?? '/',
});

const serviceTemplateFor = (cluster, service) => serviceTemplate({
  id: service.id, clusterName: cluster.outputs.ClusterName, vpcId: cluster.outputs.VpcId, subnetIds: String(cluster.outputs.SubnetIds).split(','),
  executionRoleArn: cluster.outputs.ExecutionRoleArn, name: service.name, ...serviceConfig(service),
});

async function createService(event, cluster, who, credentials) {
  if (cluster.kind !== 'serverless') return error(400, 'Lyrcloud deploys services to serverless clusters. On Kubernetes, deploy with kubectl (see the cluster page).');
  const fresh = await refresh(cluster, clusterKey(cluster.id), credentials);
  if (fresh.status !== 'ready') return error(409, 'Wait until the cluster is ready.');
  const body = parseJson(event);
  const refused = serviceError(body);
  if (refused) return error(...refused);
  const name = cleanName(body.name);
  const siblings = (await itemsOf(who.userId)).filter((row) => row.row === 'service' && row.clusterId === cluster.id);
  if (siblings.length >= MAX_SERVICES_PER_CLUSTER) return error(409, `A cluster can run up to ${MAX_SERVICES_PER_CLUSTER} services.`);
  if (siblings.some((row) => row.name === name)) return error(409, `This cluster already has a service called ${name}.`);
  const id = shortId();
  await ensureLinkedRoles('service', credentials);
  const item = {
    ...serviceKey(id), row: 'service', id, clusterId: cluster.id, ownerId: who.userId, region: cluster.region, name, ...serviceConfig(body),
    stackName: `lyrcloud-svc-${cluster.name}-${name}`.slice(0, 128), status: 'creating', createdAt: now(),
  };
  try {
    await clients.cloudformation(cluster.region, credentials).send(new CreateStackCommand({
      StackName: item.stackName, TemplateBody: JSON.stringify(serviceTemplateFor(fresh, item)), OnFailure: 'ROLLBACK',
      Tags: [{ Key: 'lyrcloud', Value: 'managed' }, { Key: 'lyrcloud:service', Value: name }],
    }));
  } catch (err) {
    const message = awsMessage(err);
    if (message) return error(400, message);
    throw err;
  }
  await put(item);
  return json(200, { service: publicService(item) });
}

async function serviceRoutes(event, method, path, who) {
  const id = path.match(/^\/cloud\/services\/([a-f0-9]{8})$/)?.[1];
  const item = id && (await getItem(serviceKey(id)));
  if (!item || (item.ownerId !== who.userId && !isStaff(who.role))) return error(404, 'That service isn’t in your account.');
  if (item.ownerId !== who.userId && method !== 'GET') return error(403, 'Only the owner can change this service.');
  const credentials = await credentialsFor(await getItem(connectionKey(item.ownerId)));
  if (method === 'GET') return json(200, { service: publicService(await refresh(item, serviceKey(item.id), credentials)) });
  if (method === 'PUT') {
    const body = parseJson(event);
    const refused = serviceError(body, { partial: true });
    if (refused) return error(...refused);
    if (!['ready', 'failed'].includes(item.status)) return error(409, 'Wait until the last change finishes.');
    const cluster = await getItem(clusterKey(item.clusterId));
    const next = { ...item, ...serviceConfig(body, item) };
    try {
      await clients.cloudformation(item.region, credentials).send(new UpdateStackCommand({ StackName: item.stackName, TemplateBody: JSON.stringify(serviceTemplateFor(cluster, next)) }));
    } catch (err) {
      if (err.name === 'ValidationError' && /No updates/.test(err.message)) return json(200, { service: publicService(item) });
      const message = awsMessage(err);
      if (message) return error(400, message);
      throw err;
    }
    const { image, port, size, count, env: vars, healthPath } = next;
    return json(200, { service: publicService(await update(serviceKey(item.id), { image, port, size, count, env: vars, healthPath, status: 'updating', updatedAt: now() })) });
  }
  if (method === 'DELETE') {
    await clients.cloudformation(item.region, credentials).send(new DeleteStackCommand({ StackName: item.stackName }));
    return json(200, { service: publicService(await update(serviceKey(item.id), { status: 'deleting', updatedAt: now() })) });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- overview and admin

async function overview(who) {
  const items = await itemsOf(who.userId);
  return json(200, {
    connection: publicConnection(items.find((item) => item.row === 'connection')) || null,
    clusters: items.filter((item) => item.row === 'cluster').map(publicCluster),
    services: items.filter((item) => item.row === 'service').map(publicService),
    accessRoleName: ACCESS_ROLE_NAME,
  });
}

async function admin(who) {
  if (!isStaff(who.role)) return error(403, 'Admins only.');
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const byKind = (row) => items.filter((item) => item.row === row);
  return json(200, {
    connections: byKind('connection').map((item) => ({ ownerEmail: item.ownerEmail || null, accountId: item.accountId || null, status: item.roleArn ? 'connected' : 'pending', createdAt: item.createdAt })),
    clusters: byKind('cluster').map((item) => ({ ...publicCluster(item), ownerEmail: item.ownerEmail || null })),
    services: byKind('service').map(publicService),
  });
}

// ---------------------------------------------------------------- entry

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  try {
    const who = await caller(event);
    if (!who) return error(401, 'unauthorized');
    if (who.profile.disabled === true && who.role !== 'superadmin') return error(403, 'This account has been disabled.');
    if (path === '/admin/cloud' && method === 'GET') return await admin(who);
    if (path === '/cloud' && method === 'GET') return await overview(who);
    if (path === '/cloud/connections/aws') return await connectionRoutes(event, method, who);
    if (path === '/cloud/clusters' || path.startsWith('/cloud/clusters/')) return await clusterRoutes(event, method, path, who);
    if (path.startsWith('/cloud/services/')) return await serviceRoutes(event, method, path, who);
    return error(404, 'not_found');
  } catch (err) {
    if (err instanceof CloudError) return error(err.status, err.message);
    const message = awsMessage(err);
    if (message) return error(400, message);
    console.error('Cloud API failed', err);
    return error(500, 'Something went wrong. Please try again.');
  }
};

