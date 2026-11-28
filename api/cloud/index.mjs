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
//   POST   /cloud/connections/{gcp|azure|alibaba} start connecting: connection ID and the Cloud Shell setup script
//   PUT    /cloud/connections/gcp                 { projectId, projectNumber }        finish (Lyrcloud signs in to check)
//   PUT    /cloud/connections/azure               { tenantId, subscriptionId, clientId }
//   PUT    /cloud/connections/alibaba             { accountId }
//   DELETE /cloud/connections/{gcp|azure|alibaba} forget it (no clusters left on that cloud)
// Google Cloud, Azure and Alibaba Cloud are keyless (federation.mjs) and built over their APIs (providers.mjs, alibaba.mjs).
//   POST   /cloud/clusters                        { name, provider: "aws", region, kind, nodeType?, nodes?, adminArn? }
//   GET    /cloud/clusters/{id}                   a cluster, refreshed from CloudFormation
//   PUT    /cloud/clusters/{id}                   { nodes } resize a Kubernetes cluster
//   DELETE /cloud/clusters/{id}                   tear it down (its services first)
//   POST   /cloud/clusters/{id}/services          { name, image, port?, size?, count?, env?, healthPath? } (serverless clusters)
//   GET    /cloud/services/{id}                   a service, refreshed
//   PUT    /cloud/services/{id}                   { image?, port?, size?, count?, env?, healthPath? } redeploy with changes
//   DELETE /cloud/services/{id}                   remove it
//   POST   /cloud/clusters/{id}/apply             { manifests } apply Kubernetes YAML or JSON (server-side apply, kube.mjs)
//   GET    /cloud/clusters/{id}/workloads         deployments and services running on a Kubernetes cluster
//   POST   /cloud/clusters/{id}/pay               open a Lyrpay payment for a month of Kubernetes management (fees.mjs)
//   POST   /cloud/clusters/{id}/payment           check that payment; a paid new cluster gets built
//   POST   /cloud/servers                         { name, provider, region, image, size, sshKey, sshFrom? } a Linux server (servers.mjs)
//   GET    /cloud/servers/{id}                    a server, refreshed (public IP, ssh command)
//   DELETE /cloud/servers/{id}                    delete it and everything made for it
//   POST   /public/marketplace                    AWS Marketplace sign-up (form with x-amzn-marketplace-token, no login)
//   GET    /cloud/marketplace                     your AWS Marketplace subscription, if linked (marketplace.mjs)
//   POST   /cloud/marketplace/link                { code } link a Marketplace subscription to this account
//   GET    /admin/cloud                           every connection, cluster and service (staff)
//   PUT    /admin/cloud/settings                  { upsell?, hosting? } switch features on or off (super admin)
import { randomBytes } from 'node:crypto';
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, UpdateStackCommand } from '@aws-sdk/client-cloudformation';
import { DescribeAvailabilityZonesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { CreateServiceLinkedRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchMeterUsageCommand, MarketplaceMeteringClient, ResolveCustomerCommand } from '@aws-sdk/client-marketplace-metering';
import { GetEntitlementsCommand, MarketplaceEntitlementServiceClient } from '@aws-sdk/client-marketplace-entitlement-service';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isStaff, planFor, roleFor } from '../account/roles.mjs';
import * as lyrpay from '../domains/lyrpay.mjs';
import { addMonth, clusterLimitError, feeReference, feeState, KUBERNETES_FEE_CENTS, serviceLimitError } from './fees.mjs';
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
  registryLogin,
  registryServer,
  roleArnFrom,
  serviceError,
  serviceEstimate,
  serviceTemplate,
  stackState,
} from './rules.mjs';
import { alibabaCredentials, alibabaSetupScript, azureAccessToken, azureSetupScript, CONNECTION_RE, FederationError, gcpAccessToken, gcpSetupScript, identity, issuerFingerprints } from './federation.mjs';
import { PROVIDER_OPS as REST_OPS, ProviderError } from './providers.mjs';
import { alibaba } from './alibaba.mjs';
import { AlibabaError } from './alibaba-api.mjs';

const PROVIDER_OPS = { ...REST_OPS, alibaba };
const FEDERATED = ['gcp', 'azure', 'alibaba'];
const ACCOUNT_NAMES = { gcp: 'Google Cloud project', azure: 'Azure subscription', alibaba: 'Alibaba Cloud account' };
import { applyManifests, eksToken, KubeError, parseManifests, workloads } from './kube.mjs';
import { billingError, CREDIT_PACKS, GRACE_DAYS, HOSTING_SIZES, hostingAppTemplate, hourlyCents, monthlyCents, PLAN_INCLUDED } from './hosting.mjs';
import { newCode, planFromEntitlements, profileChange, REGISTRATION_HOURS, startOfHour, tokenFrom, usageRecord } from './marketplace.mjs';
import { awsServerTemplate, IMAGES, SERVER_OPS, SERVER_SIZES, serverError, serverEstimate, SERVERS_LIMIT, sshCommand } from './servers.mjs';

const env = process.env;
const TABLE = env.TABLE_NAME;
const USERS_TABLE = env.USERS_TABLE_NAME;
const SUPER_ADMIN_EMAIL = env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com';
const SITE_URL = env.SITE_URL || 'https://www.lyrcloud.com';
const ACCESS_TEMPLATE_URL = env.ACCESS_TEMPLATE_URL;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const sts = new STSClient({});
// Region-specific clients for the customer's account. Tests replace these factories.
export const clients = {
  cloudformation: (region, credentials) => new CloudFormationClient({ region, credentials }),
  ec2: (region, credentials) => new EC2Client({ region, credentials }),
  iam: (credentials) => new IAMClient({ region: 'us-east-1', credentials }),
  fetch: (...args) => fetch(...args),
  fingerprints: (issuer) => issuerFingerprints(issuer),
  secrets: () => new SecretsManagerClient({}),
  // AWS Marketplace runs in us-east-1 (the seller account is this one).
  metering: () => new MarketplaceMeteringClient({ region: 'us-east-1' }),
  entitlements: () => new MarketplaceEntitlementServiceClient({ region: 'us-east-1' }),
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

const connectionKey = (userId, provider = 'aws') => ({ pk: `conn#${userId}`, sk: provider });
const clusterKey = (id) => ({ pk: `cluster#${id}`, sk: 'cluster' });
const serviceKey = (id) => ({ pk: `service#${id}`, sk: 'service' });
const serverKey = (id) => ({ pk: `server#${id}`, sk: 'server' });
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
  const role = roleFor(profile, SUPER_ADMIN_EMAIL);
  return { userId, profile, role, staff: isStaff(role), plan: planFor(profile), email: profile.email || null };
}

export class CloudError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Pay with Lyrpay keys (the lyrcloud/lyrpay secret, shared with the domains API). Re-read every minute.
let lyrpayCache = { value: null, at: 0 };
async function getLyrpay() {
  if (env.LYRPAY_JSON) return JSON.parse(env.LYRPAY_JSON);
  if (!env.LYRPAY_SECRET_NAME) return {};
  if (!lyrpayCache.value || Date.now() - lyrpayCache.at > 60_000) {
    let value = {};
    try {
      value = JSON.parse((await clients.secrets().send(new GetSecretValueCommand({ SecretId: env.LYRPAY_SECRET_NAME }))).SecretString || '{}');
    } catch (err) {
      if (err.name !== 'ResourceNotFoundException') console.error('Lyrpay keys unreadable', err.name);
    }
    lyrpayCache = { value, at: Date.now() };
  }
  return lyrpayCache.value;
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

const publicConnection = (item) => item && item.provider && item.provider !== 'aws' ? ({
  provider: item.provider,
  status: item.connectedAt ? 'connected' : 'pending',
  connectionId: item.connectionId,
  projectId: item.projectId || null,
  subscriptionId: item.subscriptionId || null,
  tenantId: item.tenantId || null,
  clientId: item.clientId || null,
  accountId: item.accountId || null,
  connectedAt: item.connectedAt || null,
  setupScript: item.connectedAt ? null : item.setupScript || null,
}) : item && ({
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
  stackName: item.stackName || null,
  fee: feeState(item),
  billing: item.billing || null,
  payUrl: item.pendingPayment?.url || null,
});

const publicService = (item) => ({
  provider: item.provider || 'aws',
  id: item.id, clusterId: item.clusterId, name: item.name, image: item.image, port: item.port, size: item.size, count: item.count,
  env: item.env || {}, healthPath: item.healthPath, status: item.status, failureReason: item.failureReason || null,
  url: item.outputs?.Url || null, estimate: serviceEstimate(item), createdAt: item.createdAt, updatedAt: item.updatedAt || null,
  privateRegistry: Boolean(item.privateRegistry), registryUser: item.registryUser || null, registryServer: item.privateRegistry ? registryServer(item.image) : null,
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

// ---------------------------------------------------------------- Google Cloud, Azure and Alibaba Cloud

// Short-lived access to the customer's Google Cloud, Azure or Alibaba Cloud account, and that provider's operations.
async function providerContext(connection) {
  if (!connection?.connectedAt) throw new CloudError(409, `Connect your ${ACCOUNT_NAMES[connection?.provider] || 'cloud account'} first.`);
  const deps = { sts, fetchImpl: clients.fetch };
  const ops = PROVIDER_OPS[connection.provider];
  if (connection.provider === 'alibaba') return { credentials: await alibabaCredentials(deps, connection), connection, fetchImpl: clients.fetch, ops };
  const token = connection.provider === 'gcp' ? await gcpAccessToken(deps, connection) : await azureAccessToken(deps, connection);
  return { token, connection, fetchImpl: clients.fetch, ops };
}

// Brings a Google Cloud / Azure cluster or service row up to date. Gone resources remove the row.
async function refreshRemote(item, key, ctx, cluster) {
  if (['ready', 'failed'].includes(item.status) && Date.now() - Date.parse(item.checkedAt || 0) < 60_000) return item;
  const state = cluster ? await ctx.ops.refreshService(ctx, cluster, item) : await ctx.ops.refreshCluster(ctx, item);
  if (state.status === 'deleted') {
    await remove(key);
    return { ...item, status: 'deleted' };
  }
  return update(key, {
    status: state.status, checkedAt: now(), outputs: state.outputs || item.outputs || {}, failureReason: state.failureReason ?? null,
    ...(state.public ? { public: true } : {}),
  });
}

let ourIdentity;
const setupScriptFor = async (provider, connectionId) => {
  ourIdentity ||= await identity(sts);
  if (provider === 'alibaba') return alibabaSetupScript({ connectionId, issuer: ourIdentity.issuer, fingerprints: await clients.fingerprints(ourIdentity.issuer) });
  return provider === 'gcp' ? gcpSetupScript({ connectionId, issuer: ourIdentity.issuer }) : azureSetupScript({ connectionId, ...ourIdentity });
};

const GCP_PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function federatedConnectionRoutes(event, method, who, provider) {
  const key = connectionKey(who.userId, provider);
  const existing = await getItem(key);
  if (method === 'POST') {
    if (existing) return json(200, { connection: publicConnection(existing) });
    const connectionId = `lyr${randomBytes(5).toString('hex')}`;
    const item = { ...key, row: 'connection', ownerId: who.userId, ownerEmail: who.email, provider, connectionId, setupScript: await setupScriptFor(provider, connectionId), createdAt: now() };
    await put(item);
    return json(200, { connection: publicConnection(item) });
  }
  if (method === 'PUT') {
    if (!existing) return error(409, 'Start connecting first.');
    const body = parseJson(event) || {};
    let fields;
    if (provider === 'gcp') {
      const projectId = String(body.projectId || '').trim().toLowerCase();
      const projectNumber = String(body.projectNumber || '').trim();
      if (!GCP_PROJECT_RE.test(projectId) || !/^\d{6,20}$/.test(projectNumber)) return error(400, 'Paste the project ID and project number the setup script printed.');
      fields = { projectId, projectNumber };
    } else if (provider === 'alibaba') {
      const accountId = String(body.accountId || '').trim();
      if (!/^\d{10,20}$/.test(accountId)) return error(400, 'Paste the account ID the setup script printed (only digits).');
      fields = { accountId };
    } else {
      const ids = Object.fromEntries(['tenantId', 'subscriptionId', 'clientId'].map((name) => [name, String(body[name] || '').trim().toLowerCase()]));
      if (!Object.values(ids).every((id) => UUID_RE.test(id))) return error(400, 'Paste the tenant, subscription and client IDs the setup script printed.');
      fields = ids;
    }
    const trial = { ...existing, ...fields, connectedAt: 'checking' };
    const ctx = await providerContext(trial);
    await ctx.ops.verify(ctx);
    const saved = { ...existing, ...fields, connectedAt: now() };
    await put(saved);
    return json(200, { connection: publicConnection(saved) });
  }
  if (method === 'DELETE') {
    const clusters = (await itemsOf(who.userId)).filter((item) => ['cluster', 'server'].includes(item.row) && item.provider === provider);
    if (clusters.length) return error(409, 'Delete your clusters and servers on this cloud first; Lyrcloud needs the connection to take them down.');
    await remove(key);
    return json(200, { disconnected: true });
  }
  return error(404, 'not_found');
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
    const clusters = (await itemsOf(who.userId)).filter((item) => ['cluster', 'server'].includes(item.row) && (item.provider || 'aws') === 'aws');
    if (clusters.length) return error(409, 'Delete your clusters and servers first; Lyrcloud needs the connection to take them down.');
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
  const overLimit = clusterLimitError(who.plan, clusters, body.kind, who.staff);
  if (overLimit) return error(...overLimit);
  const connection = items.find((item) => item.row === 'connection' && (item.provider || 'aws') === body.provider);
  if (body.provider === 'aws') await credentialsFor(connection); // fail now, not after payment
  else await providerContext(connection);
  const id = shortId();
  // A Marketplace buyer's Kubernetes clusters are metered on their AWS bill instead of the Lyrpay fee.
  const billing = body.kind === 'kubernetes' && who.profile.planSource === 'marketplace' && (await getItem(marketplaceKey(who.userId))) ? { billing: 'marketplace' } : {};
  const config = body.kind !== 'kubernetes' ? {}
    : body.provider === 'aws' ? { nodeType: body.nodeType || 't3.medium', nodes: body.nodes ?? 2, adminArn: body.adminArn.trim() }
    : body.provider === 'azure' ? { nodeType: body.nodeType || 'Standard_B2s', nodes: body.nodes ?? 2 }
    : body.provider === 'alibaba' ? { nodeType: body.nodeType || 'ecs.c7.large', nodes: body.nodes ?? 2 } : {};
  const item = {
    ...clusterKey(id), row: 'cluster', id, ownerId: who.userId, ownerEmail: who.email, provider: body.provider, region: region.code, name, kind: body.kind, ...config,
    status: 'creating', createdAt: now(), ...(who.staff ? { feeExempt: true } : {}), ...billing,
  };
  // Kubernetes is built once its first month of management is paid.
  if (feeState(item).needsFee) {
    const pendingPayment = await openFeePayment(item, who);
    const saved = { ...item, status: 'awaiting_payment', pendingPayment };
    await put(saved);
    return json(200, { cluster: publicCluster(saved), payUrl: pendingPayment.url });
  }
  const built = await buildCluster(item);
  if (built.statusCode) return built;
  await put(built);
  return json(200, { cluster: publicCluster(built) });
}

// Starts building a cluster row in the customer's cloud; returns the row to save (or an error response).
async function buildCluster(item) {
  const connection = await getItem(connectionKey(item.ownerId, item.provider));
  if (item.provider !== 'aws') {
    const ctx = await providerContext(connection);
    const state = await ctx.ops.createCluster(ctx, item);
    return { ...item, status: state.status, outputs: state.outputs || {} };
  }
  const credentials = await credentialsFor(connection);
  await ensureLinkedRoles(item.kind, credentials);
  const zones = await zonesFor(item.region, item.kind, credentials);
  const built = { ...item, zones, stackName: `lyrcloud-cluster-${item.name}`, status: 'creating' };
  try {
    const { StackId } = await clients.cloudformation(item.region, credentials).send(new CreateStackCommand({
      StackName: built.stackName,
      TemplateBody: JSON.stringify(clusterTemplate({ ...built })),
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      OnFailure: 'ROLLBACK',
      Tags: [{ Key: 'lyrcloud', Value: 'managed' }, { Key: 'lyrcloud:cluster', Value: item.name }],
    }));
    built.stackId = StackId;
  } catch (err) {
    const message = awsMessage(err);
    if (message) return error(400, message);
    throw err;
  }
  return built;
}

// ---------------------------------------------------------------- Kubernetes manifests (kube.mjs)

async function kubeAccess(item) {
  const connection = await getItem(connectionKey(item.ownerId, item.provider));
  if (item.provider !== 'aws') {
    const ctx = await providerContext(connection);
    return ctx.ops.kubeAccess(ctx, item);
  }
  const { Endpoint, CertificateAuthority, ClusterName } = item.outputs || {};
  if (!Endpoint || !CertificateAuthority) throw new KubeError(409, 'The cluster isn’t running yet.');
  const credentials = await credentialsFor(connection);
  return { server: Endpoint, ca: Buffer.from(CertificateAuthority, 'base64').toString('utf8'), token: await eksToken(credentials, item.region, ClusterName) };
}

async function kubeRoutes(event, method, kind, item) {
  if (item.kind !== 'kubernetes') return error(400, 'Manifests are for Kubernetes clusters; serverless clusters run services.');
  if (item.status !== 'ready') return error(409, 'Wait until the cluster is ready.');
  if (kind === '/workloads' && method === 'GET') return json(200, await workloads(await kubeAccess(item)));
  if (kind === '/apply' && method === 'POST') {
    const docs = parseManifests(parseJson(event)?.manifests);
    const results = await applyManifests(await kubeAccess(item), docs);
    return json(results.every((r) => r.ok) ? 200 : 207, { results });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- Kubernetes management fee (fees.mjs)

async function openFeePayment(cluster, who) {
  const keys = await getLyrpay();
  if (!lyrpay.usable(keys)) throw new CloudError(503, 'Paying for Kubernetes clusters isn’t switched on yet. Contact sales.');
  const n = (cluster.payments || 0) + 1;
  try {
    const payment = await lyrpay.openPayment(keys, {
      orderId: feeReference(cluster.id, n), amountCents: KUBERNETES_FEE_CENTS,
      title: `Lyrcloud Kubernetes management: ${cluster.name}, 1 month`,
      returnUrl: `${SITE_URL}/dash/#/cloud/clusters/${cluster.id}?paid=1`, cancelUrl: `${SITE_URL}/dash/#/cloud`,
      metadata: { kind: 'cloud-kubernetes', cluster: cluster.id }, email: who.email,
    });
    return { id: payment.id, url: payment.url, n, openedAt: now() };
  } catch (err) {
    if (err instanceof lyrpay.LyrpayError) throw new CloudError(502, `Lyrpay: ${err.message}`);
    throw err;
  }
}

// Checks a cluster's open payment: paid adds a month (and builds a new cluster); expired drops it.
async function settleFee(item) {
  const pending = item.pendingPayment;
  if (!pending) return item;
  const payment = await lyrpay.getPayment(await getLyrpay(), pending.id).catch(() => null);
  if (payment?.status === 'paid' && lyrpay.paidCents(payment) === KUBERNETES_FEE_CENTS && payment.currency === 'USD') {
    let next = { ...item, paidThrough: addMonth(item.paidThrough), payments: pending.n, pendingPayment: null, updatedAt: now() };
    if (item.status === 'awaiting_payment') {
      next = { ...next, status: 'creating' };
      const built = await buildCluster(next).catch((err) => error(err.status || 500, err.message));
      if (built.statusCode) {
        // Couldn't even start: give the money back rather than charge for nothing.
        const refunded = await lyrpay.refundPayment(await getLyrpay(), pending.id).then(() => true, (err) => (console.error('fee refund failed', item.id, err.message), false));
        next = { ...next, status: 'failed', paidThrough: item.paidThrough || null, failureReason: `${JSON.parse(built.body).error}${refunded ? ' Your payment was refunded to your Lyrpay balance.' : ' Contact support for a refund.'}` };
      } else next = built;
    }
    await put(next);
    return next;
  }
  if (payment && ['expired', 'cancelled'].includes(payment.status)) {
    if (item.status === 'awaiting_payment') {
      await remove(clusterKey(item.id));
      return { ...item, status: 'deleted' };
    }
    return update(clusterKey(item.id), { pendingPayment: null });
  }
  return item;
}

async function feeRoutes(method, kind, item, who) {
  if (method !== 'POST') return error(404, 'not_found');
  if (kind === '/payment') return json(200, { cluster: publicCluster(await settleFee(item)) });
  if (!feeState(item).needsFee) return error(400, 'This cluster has no management fee.');
  if (item.pendingPayment && Date.now() - Date.parse(item.pendingPayment.openedAt) < 25 * 60_000) return json(200, { payUrl: item.pendingPayment.url });
  const pendingPayment = await openFeePayment(item, who);
  await update(clusterKey(item.id), { pendingPayment });
  return json(200, { payUrl: pendingPayment.url });
}

const feeBlocked = (item, who) => {
  const fee = feeState(item, new Date(), who.staff);
  return fee.needsFee && !fee.active ? error(402, 'This cluster’s Kubernetes management isn’t paid. Renew it on the cluster page to make changes (it keeps running in your account meanwhile).') : null;
};

async function ownedCluster(id, who) {
  const item = /^[a-f0-9]{8}$/.test(id) && (await getItem(clusterKey(id)));
  if (!item || (item.ownerId !== who.userId && !isStaff(who.role))) return null;
  return item;
}

async function clusterRoutes(event, method, path, who) {
  if (path === '/cloud/clusters' && method === 'POST') return createCluster(event, who);
  const match = path.match(/^\/cloud\/clusters\/([^/]+)(\/services|\/pay|\/payment|\/apply|\/workloads)?$/);
  if (!match) return error(404, 'not_found');
  const item = await ownedCluster(match[1], who);
  if (!item) return error(404, 'That cluster isn’t in your account.');
  if (item.ownerId !== who.userId && method !== 'GET') return error(403, 'Only the owner can change this cluster.');
  if (match[2] === '/pay' || match[2] === '/payment') return feeRoutes(method, match[2], item, who);
  if (item.status === 'awaiting_payment') {
    if (method === 'GET') return json(200, { cluster: publicCluster(await settleFee(item)), services: [] });
    if (method === 'DELETE') {
      await remove(clusterKey(item.id));
      return json(200, { cluster: publicCluster({ ...item, status: 'deleted' }) });
    }
    return error(409, 'Pay for the cluster first; Lyrcloud builds it once Lyrpay confirms.');
  }
  if ((method === 'PUT' || (method === 'POST' && ['/services', '/apply'].includes(match[2]))) && feeBlocked(item, who)) return feeBlocked(item, who);
  if (match[2] === '/apply' || match[2] === '/workloads') return kubeRoutes(event, method, match[2], item);
  if (item.provider !== 'aws') return remoteClusterRoutes(event, method, match, item, who);
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

async function remoteClusterRoutes(event, method, match, item, who) {
  const ctx = await providerContext(await getItem(connectionKey(item.ownerId, item.provider)));
  if (match[2]) return method === 'POST' ? createRemoteService(event, item, who, ctx) : error(404, 'not_found');
  if (method === 'GET') {
    const fresh = await refreshRemote(item, clusterKey(item.id), ctx);
    const rows = (await itemsOf(item.ownerId)).filter((row) => row.row === 'service' && row.clusterId === item.id);
    const services = [];
    for (const row of rows) services.push(publicService(CLOUD_BUSY_REMOTE.includes(row.status) ? await refreshRemote(row, serviceKey(row.id), ctx, item).catch(() => row) : row));
    return json(200, { cluster: publicCluster(fresh), services: services.filter((s) => s.status !== 'deleted'), kubectl: item.kind === 'kubernetes' ? ctx.ops.kubectl(item, ctx.connection) : null });
  }
  if (method === 'PUT') {
    if (item.kind !== 'kubernetes') return error(400, 'Serverless clusters grow with their services; there’s nothing to resize.');
    const nodes = parseJson(event)?.nodes;
    if (!Number.isInteger(nodes) || nodes < 1 || nodes > 20) return error(400, 'Use 1 to 20 nodes.');
    if (item.status !== 'ready') return error(409, 'Wait until the cluster is ready.');
    const state = await ctx.ops.resizeCluster(ctx, item, nodes);
    return json(200, { cluster: publicCluster(await update(clusterKey(item.id), { nodes, status: state.status, updatedAt: now() })) });
  }
  if (method === 'DELETE') {
    const services = (await itemsOf(item.ownerId)).filter((row) => row.row === 'service' && row.clusterId === item.id);
    if (services.length) return error(409, 'Remove this cluster’s services first.');
    const state = await ctx.ops.deleteCluster(ctx, item);
    if (state.status === 'deleted') {
      await remove(clusterKey(item.id));
      return json(200, { cluster: publicCluster({ ...item, status: 'deleted' }) });
    }
    return json(200, { cluster: publicCluster(await update(clusterKey(item.id), { status: 'deleting', updatedAt: now() })) });
  }
  return error(404, 'not_found');
}

const CLOUD_BUSY_REMOTE = ['creating', 'updating', 'deleting'];

async function createRemoteService(event, cluster, who, ctx) {
  if (cluster.kind !== 'serverless') return error(400, 'Lyrcloud deploys services to serverless clusters. On Kubernetes, deploy with kubectl (see the cluster page).');
  const fresh = await refreshRemote(cluster, clusterKey(cluster.id), ctx);
  if (fresh.status !== 'ready') return error(409, 'Wait until the cluster is ready.');
  const body = parseJson(event);
  const refused = serviceError(body);
  if (refused) return error(...refused);
  const name = cleanName(body.name);
  const allServices = (await itemsOf(who.userId)).filter((row) => row.row === 'service');
  const overLimit = serviceLimitError(who.plan, allServices, who.staff);
  if (overLimit) return error(...overLimit);
  const siblings = allServices.filter((row) => row.clusterId === cluster.id);
  if (siblings.length >= MAX_SERVICES_PER_CLUSTER) return error(409, `A cluster can run up to ${MAX_SERVICES_PER_CLUSTER} services.`);
  if (siblings.some((row) => row.name === name)) return error(409, `This cluster already has a service called ${name}.`);
  const id = shortId();
  const item = { ...serviceKey(id), row: 'service', id, clusterId: cluster.id, ownerId: who.userId, provider: cluster.provider, region: cluster.region, name, ...serviceConfig(body), ...registryFields(body.registry), status: 'creating', createdAt: now() };
  const state = await ctx.ops.deployService(ctx, fresh, item, { create: true, registry: body.registry });
  const saved = { ...item, status: state.status };
  await put(saved);
  return json(200, { service: publicService(saved) });
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
  executionRoleArn: cluster.outputs.ExecutionRoleArn, name: service.name, ...serviceConfig(service), privateRegistry: Boolean(service.privateRegistry),
});

// A private registry login: what the row keeps (never the password) and the CloudFormation parameters.
const registryFields = (registry, current = {}) => (registry === null ? { privateRegistry: false, registryUser: null }
  : registry ? { privateRegistry: true, registryUser: registry.username.trim() } : { privateRegistry: Boolean(current.privateRegistry), registryUser: current.registryUser || null });
const registryParameters = (registry, fields) => (!fields.privateRegistry ? []
  : registry ? [{ ParameterKey: 'RegistryLogin', ParameterValue: registryLogin(registry) }] : [{ ParameterKey: 'RegistryLogin', UsePreviousValue: true }]);

async function createService(event, cluster, who, credentials) {
  if (cluster.kind !== 'serverless') return error(400, 'Lyrcloud deploys services to serverless clusters. On Kubernetes, deploy with kubectl (see the cluster page).');
  const fresh = await refresh(cluster, clusterKey(cluster.id), credentials);
  if (fresh.status !== 'ready') return error(409, 'Wait until the cluster is ready.');
  const body = parseJson(event);
  const refused = serviceError(body);
  if (refused) return error(...refused);
  const name = cleanName(body.name);
  const allServices = (await itemsOf(who.userId)).filter((row) => row.row === 'service');
  const overLimit = serviceLimitError(who.plan, allServices, who.staff);
  if (overLimit) return error(...overLimit);
  const siblings = allServices.filter((row) => row.clusterId === cluster.id);
  if (siblings.length >= MAX_SERVICES_PER_CLUSTER) return error(409, `A cluster can run up to ${MAX_SERVICES_PER_CLUSTER} services.`);
  if (siblings.some((row) => row.name === name)) return error(409, `This cluster already has a service called ${name}.`);
  const id = shortId();
  await ensureLinkedRoles('service', credentials);
  const item = {
    ...serviceKey(id), row: 'service', id, clusterId: cluster.id, ownerId: who.userId, region: cluster.region, name, ...serviceConfig(body),
    ...registryFields(body.registry), stackName: `lyrcloud-svc-${cluster.name}-${name}`.slice(0, 128), status: 'creating', createdAt: now(),
  };
  try {
    await clients.cloudformation(cluster.region, credentials).send(new CreateStackCommand({
      StackName: item.stackName, TemplateBody: JSON.stringify(serviceTemplateFor(fresh, item)), OnFailure: 'ROLLBACK',
      Parameters: registryParameters(body.registry, item),
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
  if ((item.provider || 'aws') !== 'aws') return remoteServiceRoutes(event, method, item);
  const credentials = await credentialsFor(await getItem(connectionKey(item.ownerId)));
  if (method === 'GET') return json(200, { service: publicService(await refresh(item, serviceKey(item.id), credentials)) });
  if (method === 'PUT') {
    const body = parseJson(event);
    const refused = serviceError(body, { partial: true });
    if (refused) return error(...refused);
    if (!['ready', 'failed'].includes(item.status)) return error(409, 'Wait until the last change finishes.');
    const cluster = await getItem(clusterKey(item.clusterId));
    const next = { ...item, ...serviceConfig(body, item), ...registryFields(body.registry, item) };
    try {
      await clients.cloudformation(item.region, credentials).send(new UpdateStackCommand({ StackName: item.stackName, TemplateBody: JSON.stringify(serviceTemplateFor(cluster, next)), Parameters: registryParameters(body.registry, next) }));
    } catch (err) {
      if (err.name === 'ValidationError' && /No updates/.test(err.message)) return json(200, { service: publicService(item) });
      const message = awsMessage(err);
      if (message) return error(400, message);
      throw err;
    }
    const { image, port, size, count, env: vars, healthPath, privateRegistry, registryUser } = next;
    return json(200, { service: publicService(await update(serviceKey(item.id), { image, port, size, count, env: vars, healthPath, privateRegistry, registryUser, status: 'updating', updatedAt: now() })) });
  }
  if (method === 'DELETE') {
    await clients.cloudformation(item.region, credentials).send(new DeleteStackCommand({ StackName: item.stackName }));
    return json(200, { service: publicService(await update(serviceKey(item.id), { status: 'deleting', updatedAt: now() })) });
  }
  return error(404, 'not_found');
}

async function remoteServiceRoutes(event, method, item) {
  const ctx = await providerContext(await getItem(connectionKey(item.ownerId, item.provider)));
  const cluster = await getItem(clusterKey(item.clusterId));
  if (method === 'GET') return json(200, { service: publicService(await refreshRemote(item, serviceKey(item.id), ctx, cluster)) });
  if (method === 'PUT') {
    const body = parseJson(event);
    const refused = serviceError(body, { partial: true });
    if (refused) return error(...refused);
    if (!['ready', 'failed'].includes(item.status)) return error(409, 'Wait until the last change finishes.');
    const next = { ...item, ...serviceConfig(body, item), ...registryFields(body.registry, item) };
    const state = await ctx.ops.deployService(ctx, cluster, next, { create: false, registry: body.registry });
    const { image, port, size, count, env: vars, healthPath, privateRegistry, registryUser } = next;
    return json(200, { service: publicService(await update(serviceKey(item.id), { image, port, size, count, env: vars, healthPath, privateRegistry, registryUser, status: state.status, updatedAt: now() })) });
  }
  if (method === 'DELETE') {
    await ctx.ops.deleteService(ctx, cluster, item);
    return json(200, { service: publicService(await update(serviceKey(item.id), { status: 'deleting', updatedAt: now() })) });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- Linux servers (servers.mjs)

const publicServer = (item) => ({
  id: item.id, name: item.name, provider: item.provider, region: item.region, image: item.image, imageLabel: IMAGES[item.image]?.label, size: item.size,
  sizeLabel: SERVER_SIZES[item.size]?.label, sshFrom: item.sshFrom, status: item.status, failureReason: item.failureReason || null,
  publicIp: item.outputs?.PublicIp || null, ssh: sshCommand(item), estimate: serverEstimate(item), createdAt: item.createdAt,
});

async function refreshServer(item) {
  if (['ready', 'failed'].includes(item.status) && Date.now() - Date.parse(item.checkedAt || 0) < 60_000) return item;
  const connection = await getItem(connectionKey(item.ownerId, item.provider));
  if (item.provider === 'aws') return refresh(item, serverKey(item.id), await credentialsFor(connection));
  const ctx = await providerContext(connection);
  const state = await SERVER_OPS[item.provider].refresh(ctx, item);
  if (state.status === 'deleted') {
    await remove(serverKey(item.id));
    return { ...item, status: 'deleted' };
  }
  return update(serverKey(item.id), { status: state.status, checkedAt: now(), outputs: state.outputs || item.outputs || {}, failureReason: state.failureReason ?? null });
}

async function serverRoutes(event, method, path, who) {
  if (path === '/cloud/servers' && method === 'POST') {
    const body = parseJson(event);
    const region = findRegion(body?.provider, body?.region);
    const refused = serverError(body, region);
    if (refused) return error(...refused);
    const items = await itemsOf(who.userId);
    const servers = items.filter((row) => row.row === 'server');
    const max = SERVERS_LIMIT[who.plan] ?? 1;
    if (!who.staff && servers.length >= max) return error(402, `Your plan manages up to ${max} server${max === 1 ? '' : 's'}. Upgrade on the Plans page for more.`);
    if (servers.some((row) => row.name === body.name && row.provider === body.provider)) return error(409, `You already have a server called ${body.name} on this cloud.`);
    const connection = items.find((row) => row.row === 'connection' && (row.provider || 'aws') === body.provider);
    const id = shortId();
    const item = {
      ...serverKey(id), row: 'server', id, ownerId: who.userId, ownerEmail: who.email, provider: body.provider, region: region.code, name: body.name,
      image: body.image || 'ubuntu', size: body.size || 'small', sshKey: String(body.sshKey).trim(), sshFrom: String(body.sshFrom || '0.0.0.0/0').trim(), status: 'creating', createdAt: now(),
    };
    if (body.provider === 'aws') {
      const credentials = await credentialsFor(connection);
      item.stackName = `lyrcloud-server-${body.name}`;
      try {
        await clients.cloudformation(region.code, credentials).send(new CreateStackCommand({
          StackName: item.stackName, TemplateBody: JSON.stringify(awsServerTemplate(item)), OnFailure: 'ROLLBACK',
          Tags: [{ Key: 'lyrcloud', Value: 'managed' }, { Key: 'lyrcloud:server', Value: body.name }],
        }));
      } catch (err) {
        const message = awsMessage(err);
        if (message) return error(400, message);
        throw err;
      }
    } else {
      const ctx = await providerContext(connection);
      const state = await SERVER_OPS[body.provider].create(ctx, item);
      if (state?.outputs) item.outputs = state.outputs;
    }
    await put(item);
    return json(200, { server: publicServer(item) });
  }
  const id = path.match(/^\/cloud\/servers\/([a-f0-9]{8})$/)?.[1];
  const item = id && (await getItem(serverKey(id)));
  if (!item || (item.ownerId !== who.userId && !isStaff(who.role))) return error(404, 'That server isn’t in your account.');
  if (method === 'GET') return json(200, { server: publicServer(await refreshServer(item)) });
  if (method === 'DELETE') {
    if (item.ownerId !== who.userId) return error(403, 'Only the owner can delete this server.');
    const connection = await getItem(connectionKey(item.ownerId, item.provider));
    if (item.provider === 'aws') await clients.cloudformation(item.region, await credentialsFor(connection)).send(new DeleteStackCommand({ StackName: item.stackName }));
    else await SERVER_OPS[item.provider].remove(await providerContext(connection), item);
    return json(200, { server: publicServer(await update(serverKey(item.id), { status: 'deleting', updatedAt: now() })) });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- AWS Marketplace (marketplace.mjs)

const registrationKey = (code) => ({ pk: `mpreg#${code}`, sk: 'registration' });
const marketplaceKey = (userId) => ({ pk: `mp#${userId}`, sk: 'link' });
const licenseKey = (licenseArn) => ({ pk: `mplicense#${licenseArn}`, sk: 'owner' });

const publicMarketplace = (link) => link && ({ awsAccountId: link.awsAccountId, plan: link.plan || null, expiresAt: link.expiresAt || null, linkedAt: link.linkedAt, checkedAt: link.checkedAt || null, lastMeteredHour: link.lastMeteredHour || null });

// AWS posts the buyer here after they subscribe; no Lyrcloud login yet, so park it under a one-time code.
async function marketplaceFulfill(event) {
  const token = tokenFrom(event);
  const back = (fragment) => ({ statusCode: 303, headers: { location: `${SITE_URL}/dash/#/marketplace${fragment}`, 'cache-control': 'no-store' }, body: '' });
  if (!token) return back('?error=missing');
  let customer;
  try {
    customer = await clients.metering().send(new ResolveCustomerCommand({ RegistrationToken: token }));
  } catch (err) {
    console.error('ResolveCustomer failed', err.name, err.message);
    return back('?error=token');
  }
  const code = newCode();
  await put({
    ...registrationKey(code), row: 'marketplace-registration', awsAccountId: customer.CustomerAWSAccountId, licenseArn: customer.LicenseArn,
    productCode: customer.ProductCode, customerIdentifier: customer.CustomerIdentifier || null, createdAt: now(),
  });
  return back(`/${code}`);
}

// Reads the buyer's entitlements and brings their Lyrcloud plan (and clusters' billing) in line.
async function syncMarketplace(link) {
  const entitlements = [];
  let NextToken;
  do {
    const page = await clients.entitlements().send(new GetEntitlementsCommand({ ProductCode: link.productCode, Filter: { LICENSE_ARN: [link.licenseArn] }, NextToken }));
    entitlements.push(...(page.Entitlements || []));
    NextToken = page.NextToken;
  } while (NextToken);
  const entitled = planFromEntitlements(entitlements);
  const profile = (await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: link.ownerId } }))).Item || { userId: link.ownerId };
  const change = profileChange(profile, entitled);
  if (change) {
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE, Key: { userId: link.ownerId },
      UpdateExpression: 'SET #p = :p, #s = :s, #t = :t, #u = :u',
      ExpressionAttributeNames: { '#p': 'plan', '#s': 'planSource', '#t': 'planPaidThrough', '#u': 'updatedAt' }, ExpressionAttributeValues: { ':p': change.plan, ':s': change.planSource, ':t': change.planPaidThrough, ':u': now() },
    }));
  }
  if (!entitled) {
    // The subscription ended: its clusters go back to the monthly Lyrpay fee (due now).
    for (const row of (await itemsOf(link.ownerId)).filter((r) => r.row === 'cluster' && r.billing === 'marketplace')) {
      await update(clusterKey(row.id), { billing: null, paidThrough: now() });
    }
  }
  return update(marketplaceKey(link.ownerId), { plan: entitled?.plan || null, expiresAt: entitled?.expiresAt || null, checkedAt: now() });
}

async function marketplaceRoutes(event, method, path, who) {
  if (path === '/cloud/marketplace' && method === 'GET') return json(200, { marketplace: publicMarketplace(await getItem(marketplaceKey(who.userId))) || null });
  if (path === '/cloud/marketplace/link' && method === 'POST') {
    const code = String(parseJson(event)?.code || '');
    const registration = /^[\w-]{20,40}$/.test(code) && (await getItem(registrationKey(code)));
    if (!registration || Date.now() - Date.parse(registration.createdAt) > REGISTRATION_HOURS * 3_600_000) return error(404, 'That AWS Marketplace link has expired. Open Lyrcloud from your AWS Marketplace subscriptions again (Set up product).');
    const owner = await getItem(licenseKey(registration.licenseArn));
    if (owner && owner.ownerId !== who.userId) return error(409, 'This AWS Marketplace subscription is already linked to another Lyrcloud account.');
    const existing = await getItem(marketplaceKey(who.userId));
    if (existing && existing.licenseArn !== registration.licenseArn) return error(409, 'This Lyrcloud account already has an AWS Marketplace subscription.');
    await put({ ...licenseKey(registration.licenseArn), row: 'marketplace-license', ownerId: who.userId, createdAt: now() });
    const link = {
      ...marketplaceKey(who.userId), row: 'marketplace', ownerId: who.userId, ownerEmail: who.email, awsAccountId: registration.awsAccountId,
      licenseArn: registration.licenseArn, productCode: registration.productCode, linkedAt: existing?.linkedAt || now(),
    };
    await put(link);
    await remove(registrationKey(code));
    const synced = await syncMarketplace(link);
    return json(200, { marketplace: publicMarketplace(synced) });
  }
  return error(404, 'not_found');
}

// Every hour (and on Marketplace events): re-check every subscription, then meter the last full hour.
export async function marketplaceTick(at = new Date(), { meter = true } = {}) {
  const links = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: TABLE, FilterExpression: '#r = :r', ExpressionAttributeNames: { '#r': 'row' }, ExpressionAttributeValues: { ':r': 'marketplace' }, ExclusiveStartKey }));
    links.push(...(page.Items || []).filter((item) => item.row === 'marketplace'));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const hour = new Date(startOfHour(at).getTime() - 3_600_000);
  let metered = 0;
  for (const link of links) {
    try {
      await syncMarketplace(link);
      if (!meter || link.lastMeteredHour >= hour.toISOString()) continue;
      const record = usageRecord(link, (await itemsOf(link.ownerId)).filter((r) => r.row === 'cluster'), hour);
      if (record) {
        const result = await clients.metering().send(new BatchMeterUsageCommand({ UsageRecords: [record] }));
        if (result.UnprocessedRecords?.length) throw new Error(`usage not accepted: ${JSON.stringify(result.UnprocessedRecords).slice(0, 300)}`);
        const status = result.Results?.[0]?.Status;
        if (status && status !== 'Success' && status !== 'DuplicateRecord') throw new Error(`usage ${status}`);
        metered += 1;
      }
      await update(marketplaceKey(link.ownerId), { lastMeteredHour: hour.toISOString() });
    } catch (err) {
      console.error('marketplace', link.ownerId, err.name, err.message.split('\n').slice(0, 6).join(' '));
    }
  }
  return { links: links.length, metered };
}

// ---------------------------------------------------------------- managed hosting (hosting.mjs)

const appKey = (id) => ({ pk: `app#${id}`, sk: 'app' });
const creditKey = (userId) => ({ pk: `credit#${userId}`, sk: 'credit' });
const HOSTING_KEY = { pk: '#settings', sk: 'hosting' }; // the base stack's outputs, saved by deploy-hosting.sh

async function hostingBase() {
  const [features, base] = await Promise.all([getFeatures(), getItem(HOSTING_KEY)]);
  return features.hosting && base?.ListenerArn ? base : null;
}
const creditOf = async (userId) => Number((await getItem(creditKey(userId)))?.cents || 0);
async function addCredit(userId, cents) {
  const { Attributes } = await ddb.send(new UpdateCommand({ TableName: TABLE, Key: creditKey(userId), UpdateExpression: 'ADD cents :c SET updatedAt = :t', ExpressionAttributeValues: { ':c': cents, ':t': now() }, ReturnValues: 'ALL_NEW' }));
  return Number(Attributes.cents);
}

const publicApp = (item) => ({
  id: item.id, name: item.name, image: item.image, port: item.port, size: item.size, sizeLabel: HOSTING_SIZES[item.size]?.label, count: item.count, env: item.env || {},
  healthPath: item.healthPath, billing: item.billing, status: item.status, failureReason: item.failureReason || null, url: item.outputs?.Url || null,
  paidThrough: item.paidThrough || null, payUrl: item.pendingPayment?.url || null, stoppedReason: item.stoppedReason || null,
  monthlyCents: monthlyCents(item), hourlyCents: hourlyCents(item), privateRegistry: Boolean(item.privateRegistry), registryUser: item.registryUser || null, createdAt: item.createdAt,
});

// Creates or updates the app's stack. registry: a new login, null to drop it, undefined to keep it.
async function deployApp(app, base, { create = false, running = true, registry } = {}) {
  const cf = clients.cloudformation(base.Region || 'us-east-1');
  const input = { StackName: app.stackName, TemplateBody: JSON.stringify(hostingAppTemplate(app, base, { running })), Parameters: registryParameters(registry, app) };
  if (create) await cf.send(new CreateStackCommand({ ...input, OnFailure: 'ROLLBACK', Tags: [{ Key: 'lyrcloud', Value: 'hosting' }] }));
  else {
    try {
      await cf.send(new UpdateStackCommand(input));
    } catch (err) {
      if (!(err.name === 'ValidationError' && /No updates/.test(err.message))) throw err;
    }
  }
}

async function nextPriority() {
  const { Attributes } = await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: '#hosting', sk: 'priority' }, UpdateExpression: 'ADD n :one', ExpressionAttributeValues: { ':one': 1 }, ReturnValues: 'ALL_NEW' }));
  return 1 + (Number(Attributes.n) % 49_000);
}

async function openAppPayment(app, who) {
  const keys = await getLyrpay();
  if (!lyrpay.usable(keys)) throw new CloudError(503, 'Payments aren’t switched on yet.');
  const n = (app.payments || 0) + 1;
  const payment = await lyrpay.openPayment(keys, {
    orderId: `hostapp-${app.id}-${n}`, amountCents: monthlyCents(app), title: `Lyrcloud hosting: ${app.name}, 1 month (${HOSTING_SIZES[app.size].label} × ${app.count})`,
    returnUrl: `${SITE_URL}/dash/#/cloud?app=${app.id}`, cancelUrl: `${SITE_URL}/dash/#/cloud`, metadata: { kind: 'hosting-app', app: app.id }, email: who.email,
  }).catch((err) => { throw err instanceof lyrpay.LyrpayError ? new CloudError(502, `Lyrpay: ${err.message}`) : err; });
  return { id: payment.id, url: payment.url, n, openedAt: now() };
}

// A monthly app's open payment: paid adds a month and builds or restarts the app; expired drops a new order.
async function settleApp(item, base) {
  const pending = item.pendingPayment;
  if (!pending) return item;
  const payment = await lyrpay.getPayment(await getLyrpay(), pending.id).catch(() => null);
  if (payment?.status === 'paid' && lyrpay.paidCents(payment) === monthlyCents(item)) {
    const next = { ...item, paidThrough: addMonth(item.paidThrough), payments: pending.n, pendingPayment: null, stoppedReason: null };
    if (item.status === 'awaiting_payment') await deployApp({ ...next }, base, { create: true, registry: undefined }).then(() => { next.status = 'creating'; }, (err) => { next.status = 'failed'; next.failureReason = err.message; });
    else if (item.status === 'stopped') {
      await deployApp(next, base, { running: true });
      next.status = 'updating';
    }
    await put(next);
    return next;
  }
  if (payment && ['expired', 'cancelled'].includes(payment.status)) {
    if (item.status === 'awaiting_payment') {
      await remove(appKey(item.id));
      return { ...item, status: 'deleted' };
    }
    return update(appKey(item.id), { pendingPayment: null });
  }
  return item;
}

async function stopApp(item, base, reason) {
  await deployApp(item, base, { running: false });
  return update(appKey(item.id), { status: 'stopped', stoppedReason: reason, updatedAt: now() });
}

async function hostingRoutes(event, method, path, who) {
  const base = await hostingBase();
  if (!base) return error(404, 'Managed hosting isn’t available yet.');
  const items = await itemsOf(who.userId);
  const apps = items.filter((row) => row.row === 'app');
  if (path === '/cloud/hosting' && method === 'GET') {
    for (const app of apps.filter((a) => a.pendingPayment)) await settleApp(app, base).catch(() => {});
    const fresh = (await itemsOf(who.userId)).filter((row) => row.row === 'app');
    const refreshed = await Promise.all(fresh.map((a) => (['creating', 'updating', 'deleting'].includes(a.status) ? refresh(a, appKey(a.id)).catch(() => a) : a)));
    return json(200, { sizes: HOSTING_SIZES, creditPacks: CREDIT_PACKS, credit: await creditOf(who.userId), plan: who.plan, apps: refreshed.filter((a) => a.status !== 'deleted').map(publicApp) });
  }
  if (path === '/cloud/hosting/credit' && method === 'POST') {
    const cents = Number(parseJson(event)?.cents);
    if (!CREDIT_PACKS.includes(cents)) return error(400, `Buy credit in packs of ${CREDIT_PACKS.map((c) => `$${c / 100}`).join(', ')}.`);
    const keys = await getLyrpay();
    if (!lyrpay.usable(keys)) return error(503, 'Payments aren’t switched on yet.');
    const id = shortId();
    const payment = await lyrpay.openPayment(keys, { orderId: `hostcredit-${id}`, amountCents: cents, title: `Lyrcloud hosting credit $${cents / 100}`, returnUrl: `${SITE_URL}/dash/#/cloud?credit=1`, cancelUrl: `${SITE_URL}/dash/#/cloud`, metadata: { kind: 'hosting-credit' }, email: who.email });
    await put({ pk: `creditpay#${id}`, sk: 'creditpay', row: 'creditpay', id, ownerId: who.userId, cents, paymentId: payment.id, status: 'open', createdAt: now() });
    return json(200, { payUrl: payment.url });
  }
  if (path === '/cloud/hosting/credit/check' && method === 'POST') {
    let credit = await creditOf(who.userId);
    for (const row of items.filter((r) => r.row === 'creditpay' && r.status === 'open')) {
      const payment = await lyrpay.getPayment(await getLyrpay(), row.paymentId).catch(() => null);
      if (payment?.status === 'paid' && lyrpay.paidCents(payment) === row.cents) {
        try {
          await ddb.send(new UpdateCommand({ TableName: TABLE, Key: { pk: row.pk, sk: row.sk }, UpdateExpression: 'SET #s = :paid', ConditionExpression: '#s = :open', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':paid': 'paid', ':open': 'open' } }));
          credit = await addCredit(who.userId, row.cents);
        } catch (err) {
          if (err.name !== 'ConditionalCheckFailedException') throw err;
        }
      } else if (payment && ['expired', 'cancelled'].includes(payment.status)) await remove({ pk: row.pk, sk: row.sk });
    }
    // Credit back: restart pay-as-you-go apps that ran out.
    if (credit > 0) for (const app of apps.filter((a) => a.billing === 'payg' && a.status === 'stopped')) {
      await deployApp(app, base, { running: true });
      await update(appKey(app.id), { status: 'updating', stoppedReason: null });
    }
    return json(200, { credit });
  }
  if (path === '/cloud/hosting/apps' && method === 'POST') {
    const body = parseJson(event) || {};
    const refused = serviceError(body) || billingError({ billing: body.billing, size: body.size || 'small', count: body.count ?? 1 }, { plan: who.plan, apps, credit: await creditOf(who.userId) });
    if (refused) return error(...refused);
    const name = cleanName(body.name);
    if (apps.some((a) => a.name === name && a.status !== 'deleted')) return error(409, `You already host an app called ${name}.`);
    const id = shortId();
    const app = {
      ...appKey(id), row: 'app', id, ownerId: who.userId, ownerEmail: who.email, region: base.Region || 'us-east-1', name, ...serviceConfig(body), count: body.count ?? 1,
      billing: body.billing, ...registryFields(body.registry), token: randomBytes(24).toString('hex'), priority: await nextPriority(),
      stackName: `lyrcloud-app-${id}`, status: 'creating', createdAt: now(),
    };
    if (body.billing === 'monthly') {
      if (body.registry) return error(400, 'Add a private registry login after the first month is paid (Change → Private image).');
      const pendingPayment = await openAppPayment(app, who);
      const saved = { ...app, status: 'awaiting_payment', pendingPayment };
      await put(saved);
      return json(200, { app: publicApp(saved), payUrl: pendingPayment.url });
    }
    await deployApp(app, base, { create: true, registry: body.registry });
    await put(app);
    return json(200, { app: publicApp(app) });
  }
  const match = path.match(/^\/cloud\/hosting\/apps\/([a-f0-9]{8})(\/pay|\/payment)?$/);
  const app = match && apps.find((a) => a.id === match[1]);
  if (!app) return error(404, 'That app isn’t yours.');
  if (match[2] === '/payment' && method === 'POST') return json(200, { app: publicApp(await settleApp(app, base)) });
  if (match[2] === '/pay' && method === 'POST') {
    if (app.billing !== 'monthly') return error(400, 'Only monthly apps are paid this way.');
    const pendingPayment = await openAppPayment(app, who);
    await update(appKey(app.id), { pendingPayment });
    return json(200, { payUrl: pendingPayment.url });
  }
  if (method === 'GET') return json(200, { app: publicApp(app.pendingPayment ? await settleApp(app, base) : await refresh(app, appKey(app.id))) });
  if (method === 'PUT') {
    const body = parseJson(event) || {};
    const refused = serviceError(body, { partial: true });
    if (refused) return error(...refused);
    if (!['ready', 'failed'].includes(app.status)) return error(409, app.status === 'stopped' ? 'Pay or add credit to restart the app first.' : 'Wait until the last change finishes.');
    const next = { ...app, ...serviceConfig(body, app), ...registryFields(body.registry, app) };
    if ('size' in body || 'count' in body) {
      next.count = body.count ?? app.count;
      if (app.billing === 'plan' && (next.size !== 'small' || next.count !== 1)) return error(400, 'The included app is one small copy.');
      if (app.billing === 'monthly' && monthlyCents(next) !== monthlyCents(app)) return error(400, 'A monthly app keeps its size; make a new app for a different size.');
    }
    await deployApp(next, base, { registry: body.registry });
    const { image, port, size, count, env: vars, healthPath, privateRegistry, registryUser } = next;
    return json(200, { app: publicApp(await update(appKey(app.id), { image, port, size, count, env: vars, healthPath, privateRegistry, registryUser, status: 'updating', updatedAt: now() })) });
  }
  if (method === 'DELETE') {
    if (app.status === 'awaiting_payment') await remove(appKey(app.id));
    else {
      await clients.cloudformation(app.region).send(new DeleteStackCommand({ StackName: app.stackName }));
      await update(appKey(app.id), { status: 'deleting', updatedAt: now() });
    }
    return json(200, { deleted: true });
  }
  return error(404, 'not_found');
}

// Hourly: charge pay-as-you-go apps, stop apps whose month or plan ran out. Runs only with hosting on.
export async function hostingTick(at = new Date()) {
  const base = await hostingBase();
  if (!base) return { skipped: 'hosting off' };
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: TABLE, FilterExpression: '#r = :app', ExpressionAttributeNames: { '#r': 'row' }, ExpressionAttributeValues: { ':app': 'app' }, ExclusiveStartKey }));
    rows.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const result = { charged: 0, stopped: 0 };
  for (const app of rows.filter((a) => ['ready', 'updating', 'creating'].includes(a.status))) {
    try {
      if (app.billing === 'payg') {
        const left = await addCredit(app.ownerId, -hourlyCents(app));
        result.charged += hourlyCents(app);
        if (left <= 0) { await stopApp(app, base, 'Your Lyrcloud credit ran out. Add credit to restart it.'); result.stopped += 1; }
      } else if (app.billing === 'monthly' && Date.parse(app.paidThrough || 0) + GRACE_DAYS * 864e5 < at.getTime()) {
        await stopApp(app, base, 'This month isn’t paid. Pay to restart it.');
        result.stopped += 1;
      } else if (app.billing === 'plan') {
        const owner = (await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: app.ownerId } }))).Item;
        if (!PLAN_INCLUDED.includes(planFor(owner))) { await stopApp(app, base, 'Your plan no longer includes an app. Upgrade to restart it.'); result.stopped += 1; }
      }
    } catch (err) {
      console.error('hosting tick', app.id, err.message);
    }
  }
  return result;
}

// ---------------------------------------------------------------- overview and admin

async function overview(who) {
  let items = await itemsOf(who.userId);
  const pending = items.filter((item) => item.row === 'cluster' && item.pendingPayment);
  const busyServers = items.filter((item) => item.row === 'server' && ['creating', 'deleting', 'updating'].includes(item.status));
  if (pending.length || busyServers.length) {
    for (const item of pending) await settleFee(item).catch((err) => console.error('fee check', item.id, err.message));
    await Promise.all(busyServers.map((item) => refreshServer(item).catch((err) => console.error('server check', item.id, err.message))));
    items = await itemsOf(who.userId);
  }
  return json(200, {
    connection: publicConnection(items.find((item) => item.row === 'connection' && (item.provider || 'aws') === 'aws')) || null,
    connections: Object.fromEntries(items.filter((item) => item.row === 'connection').map((item) => [item.provider || 'aws', publicConnection(item)])),
    clusters: items.filter((item) => item.row === 'cluster').map(publicCluster),
    services: items.filter((item) => item.row === 'service').map(publicService),
    servers: items.filter((item) => item.row === 'server').map(publicServer),
    serverLimit: who.staff ? null : SERVERS_LIMIT[who.plan] ?? 1,
    accessRoleName: ACCESS_ROLE_NAME,
    plan: who.plan,
    limits: who.staff ? null : (await import('./fees.mjs')).limitsFor(who.plan),
    kubernetesFeeCents: KUBERNETES_FEE_CENTS,
    features: await getFeatures(),
  });
}

// Features the super admin switches on: the "your domain + CDN" upsell on services, and managed hosting.
const SETTINGS_KEY = { pk: '#settings', sk: 'cloud' };
export const FEATURES = ['upsell', 'hosting'];
async function getFeatures() {
  const row = (await getItem(SETTINGS_KEY)) || {};
  return Object.fromEntries(FEATURES.map((name) => [name, row[name] === true]));
}

async function saveSettings(event, who) {
  if (who.role !== 'superadmin') return error(403, 'Only the super admin switches cloud features.');
  const body = parseJson(event) || {};
  const next = { ...(await getFeatures()) };
  for (const name of FEATURES) if (typeof body[name] === 'boolean') next[name] = body[name];
  await put({ ...SETTINGS_KEY, ...next, updatedAt: now(), updatedBy: who.email });
  return json(200, { features: next });
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
    features: await getFeatures(),
    connections: byKind('connection').map((item) => ({ provider: item.provider || 'aws', ownerEmail: item.ownerEmail || null, accountId: item.accountId || item.projectId || item.subscriptionId || null, status: item.roleArn || item.connectedAt ? 'connected' : 'pending', createdAt: item.createdAt })),
    clusters: byKind('cluster').map((item) => ({ ...publicCluster(item), ownerEmail: item.ownerEmail || null })),
    services: byKind('service').map(publicService),
  });
}

// ---------------------------------------------------------------- entry

export const handler = async (event) => {
  if (event?.lyrcloudTask === 'hosting-tick') {
    const [hosting, marketplace] = await Promise.allSettled([hostingTick(), marketplaceTick()]);
    return { hosting: hosting.value ?? String(hosting.reason), marketplace: marketplace.value ?? String(marketplace.reason) };
  }
  // AWS Marketplace agreement and license events (EventBridge): re-read entitlements now, meter on the hour.
  if (typeof event?.source === 'string' && event.source.startsWith('aws.') && /marketplace/.test(event.source)) return marketplaceTick(new Date(), { meter: false });
  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  if (path === '/public/marketplace' && method === 'POST') return marketplaceFulfill(event).catch((err) => (console.error('marketplace fulfill', err), error(500, 'Something went wrong.')));
  try {
    const who = await caller(event);
    if (!who) return error(401, 'unauthorized');
    if (who.profile.disabled === true && who.role !== 'superadmin') return error(403, 'This account has been disabled.');
    if (path === '/admin/cloud' && method === 'GET') return await admin(who);
    if (path === '/admin/cloud/settings' && method === 'PUT') return await saveSettings(event, who);
    if (path === '/cloud' && method === 'GET') return await overview(who);
    if (path === '/cloud/connections/aws') return await connectionRoutes(event, method, who);
    if (FEDERATED.some((provider) => path === `/cloud/connections/${provider}`)) return await federatedConnectionRoutes(event, method, who, path.split('/').pop());
    if (path === '/cloud/clusters' || path.startsWith('/cloud/clusters/')) return await clusterRoutes(event, method, path, who);
    if (path.startsWith('/cloud/services/')) return await serviceRoutes(event, method, path, who);
    if (path === '/cloud/servers' || path.startsWith('/cloud/servers/')) return await serverRoutes(event, method, path, who);
    if (path === '/cloud/hosting' || path.startsWith('/cloud/hosting/')) return await hostingRoutes(event, method, path, who);
    if (path === '/cloud/marketplace' || path.startsWith('/cloud/marketplace/')) return await marketplaceRoutes(event, method, path, who);
    return error(404, 'not_found');
  } catch (err) {
    if (err instanceof CloudError || err instanceof FederationError || err instanceof ProviderError || err instanceof KubeError) return error(err.status, err.message);
    if (err instanceof AlibabaError) return error(err.status, `Alibaba Cloud: ${err.message}`);
    const message = awsMessage(err);
    if (message) return error(400, message);
    console.error('Cloud API failed', err);
    return error(500, 'Something went wrong. Please try again.');
  }
};

