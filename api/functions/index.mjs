// Lyrcloud Edge Functions API, used by the `lyrcloud` CLI. Each function is its own Lambda function
// (lyrfn-<name>, running __lyrcloud/runtime.mjs around the customer's code) and is served at
// https://<name>.dev.lyr: an API Gateway custom domain mapped to the router (router.mjs), with a .lyr
// CNAME record pointing at it and a *.dev.lyr certificate from the Lyr Root CA.
//
//   GET    /functions                  your functions and plan limit
//   PUT    /functions/{name}           { code: base64 zip, main, vars? } create or redeploy
//   GET    /functions/{name}           one function
//   GET    /functions/{name}/logs      ?since=15m&next=token  recent log lines
//   DELETE /functions/{name}           take it down and free the name
//   GET    /admin/functions            every function (staff)
//
// Storage (also reached from deployed functions through env bindings and platform.mjs):
//   GET    /storage                              namespaces and buckets your functions bind
//   GET    /storage/kv/{ns}/keys                 ?prefix=&cursor=  list keys
//   GET|PUT|DELETE /storage/kv/{ns}/keys/{key}  { value: base64, expirationTtl?, metadata? }
//   GET    /storage/buckets/{b}/objects          ?prefix=&cursor=&delimiter=  list objects
//   GET|PUT|DELETE /storage/buckets/{b}/objects/{key}  { body: base64, contentType? }
//
// AI Gateway (also env.AI in functions):
//   GET  /ai/models                 the catalog, marked with what your plan allows
//   GET  /ai/usage                  ?month=YYYY-MM  tokens by model, and your plan's budget
//   POST /ai/run                    { model?, input: { prompt | messages, system?, max_tokens? }, options?: { cache? } }
//   POST /ai/embed                  { model?, input: text | [texts], options?: { dimensions? } }
//
// Lyrcloud Access (access.mjs):
//   POST /access/grant              { to } from www.lyrcloud.com/access/: checks the signed-in visitor
//                                   against the function's allow-list, logs it, returns the ticket URL
//   GET  /functions/{name}/access-log   ?since=7d  allow/deny decisions (owner)
//
// A daily EventBridge rule sends { task: 'renew-certificate' } to keep the *.dev.lyr certificate fresh.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ACMClient, ImportCertificateCommand } from '@aws-sdk/client-acm';
import {
  ApiGatewayV2Client,
  CreateApiMappingCommand,
  CreateDomainNameCommand,
  DeleteApiMappingCommand,
  DeleteDomainNameCommand,
  GetApiMappingsCommand,
  GetDomainNameCommand,
} from '@aws-sdk/client-apigatewayv2';
import { CloudWatchLogsClient, CreateLogGroupCommand, DeleteLogGroupCommand, FilterLogEventsCommand, PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { isStaff, planFor, roleFor } from '../account/roles.mjs';
import { issueCertificate } from '../domains/lyrca.mjs';
import {
  archiveError,
  certNeedsRenewal,
  cleanVars,
  FUNCTIONS_DOMAIN_DEFAULT,
  functionNameError,
  hostFor,
  lambdaName,
  limitFor,
  LOG_RETENTION_DAYS,
  MAX_CODE_BYTES,
  mainError,
  parseSince,
  RUNTIME_ENTRY,
  RUNTIME_HANDLER,
} from './rules.mjs';
import { cleanAccess, isAllowed, newNonce, sign, TICKET_SECONDS, verify as verifyAccess } from './access.mjs';
import { aiLimitsFor, listModels, usageOf } from './ai.mjs';
import { performAny, platformSecret } from './platform.mjs';
import { cleanBindings, perform, signToken, StorageError } from './storage.mjs';
import { addZipEntry, listZip, ZipError } from './zip.mjs';

const env = process.env;
const TABLE = env.TABLE_NAME;
const USERS_TABLE = env.USERS_TABLE_NAME;
const DOMAINS_TABLE = env.DOMAINS_TABLE_NAME; // holds the .lyr registry (lyr#dev.lyr)
const DOMAIN = env.FUNCTIONS_DOMAIN || FUNCTIONS_DOMAIN_DEFAULT;
const EXEC_ROLE_ARN = env.EXEC_ROLE_ARN;
const INGRESS_API_ID = env.INGRESS_API_ID;
const PLATFORM_FUNCTION = env.PLATFORM_FUNCTION;
const LYR_CA_SECRET_NAME = env.LYR_CA_SECRET_NAME;
const SUPER_ADMIN_EMAIL = env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com';
const FUNCTION_MEMORY = Number(env.FUNCTION_MEMORY_MB || 256);
const FUNCTION_TIMEOUT = Number(env.FUNCTION_TIMEOUT_SECONDS || 25); // under API Gateway's 30 s, room for AI calls

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
export const lambda = new LambdaClient({});
export const apigw = new ApiGatewayV2Client({});
export const acm = new ACMClient({});
export const logs = new CloudWatchLogsClient({});
export const secrets = new SecretsManagerClient({});
export const timing = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

let runtimeSource;
const runtime = () => (runtimeSource ??= readFileSync(new URL('./runtime.mjs', import.meta.url)));

// ---------------------------------------------------------------- helpers

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const error = (statusCode, message) => json(statusCode, { error: message });
const now = () => new Date().toISOString();
const fnKey = (name) => ({ pk: `fn#${name}`, sk: 'fn' });
const CERT_KEY = { pk: 'system', sk: 'certificate' };
const LYR_KEY = { pk: `lyr#${DOMAIN}`, sk: 'lyr' };
const DATA_TABLE = env.DATA_TABLE_NAME;
const ACCESS_LOG_DAYS = 90;
const getItem = async (key, table = TABLE) => (await ddb.send(new GetCommand({ TableName: table, Key: key }))).Item;
const isConditionFailure = (err) => err?.name === 'ConditionalCheckFailedException';

function parseJson(event) {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

async function queryAll(input) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ TableName: TABLE, ...input, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const functionsOf = (ownerId) => queryAll({ IndexName: 'byOwner', KeyConditionExpression: 'ownerId = :o', ExpressionAttributeValues: { ':o': ownerId } });

export class UserError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const publicFunction = (item) => ({
  name: item.name,
  url: `https://${hostFor(item.name, DOMAIN)}`,
  status: item.status,
  main: item.main || null,
  vars: Object.keys(item.vars || {}),
  bindings: item.bindings || [],
  access: item.access ? { allow: item.access.allow, paths: item.access.paths } : null,
  codeBytes: item.codeBytes || 0,
  deploys: item.deploys || 0,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt || null,
  lastError: item.lastError || null,
});

async function caller(event) {
  const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!userId) return null;
  const profile = (await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }))).Item || { userId };
  return { userId, profile, role: roleFor(profile, SUPER_ADMIN_EMAIL), plan: planFor(profile), email: profile.email || event.requestContext.authorizer.jwt.claims.email || null };
}

// Retries `work` while AWS says to slow down (API Gateway allows few domain changes a minute).
async function patiently(work, { tries = 6, delay = 1500 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      const slowDown = err?.name === 'TooManyRequestsException' || err?.name === 'ThrottlingException' || err?.$metadata?.httpStatusCode === 429;
      const busy = err?.name === 'ResourceConflictException';
      if ((!slowDown && !busy) || attempt >= tries) throw err;
      await timing.sleep(delay * attempt);
    }
  }
}

// ---------------------------------------------------------------- certificate

// A *.dev.lyr certificate from the Lyr Root CA, imported into ACM so API Gateway can serve it.
// Renewal re-imports into the same ACM certificate, so every custom domain picks it up.
export async function ensureCertificate({ force = false } = {}) {
  const current = await getItem(CERT_KEY);
  if (!force && !certNeedsRenewal(current)) return current;
  const ca = JSON.parse((await secrets.send(new GetSecretValueCommand({ SecretId: LYR_CA_SECRET_NAME }))).SecretString || '{}');
  if (!ca.keyPem || !ca.certPem) throw new Error('The Lyr Root CA secret has no key yet. Run scripts/lyr-root-ca.mjs first.');
  // RSA, which every API Gateway endpoint type accepts.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issued = issueCertificate({ caKeyPem: ca.keyPem, caCertPem: ca.certPem, name: DOMAIN, publicKey });
  const { CertificateArn } = await acm.send(new ImportCertificateCommand({
    Certificate: Buffer.from(issued.certPem),
    PrivateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    CertificateChain: Buffer.from(ca.certPem),
    ...(current?.arn ? { CertificateArn: current.arn } : { Tags: [{ Key: 'lyrcloud', Value: 'edge-functions' }] }),
  }));
  const item = { ...CERT_KEY, arn: CertificateArn, notAfter: issued.notAfter, serial: issued.serial, issuedAt: now() };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  console.log('Certificate for', DOMAIN, current?.arn ? 'renewed' : 'created', CertificateArn, 'until', issued.notAfter);
  return item;
}

// ---------------------------------------------------------------- .lyr records

// Points (or with target null, stops pointing) name.dev.lyr at its API Gateway domain in the .lyr registry.
// The registry item is shared by every function, so writes are optimistic and retried on a clash.
export async function setLyrRecord(host, target) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const entry = await getItem(LYR_KEY, DOMAINS_TABLE);
    const records = (entry?.records || []).filter((record) => record.name !== host);
    if (target) records.push({ type: 'CNAME', name: host, values: [target], ttl: 300 });
    records.sort((a, b) => a.name.localeCompare(b.name));
    const version = entry?.fnVersion || 0;
    const item = {
      kind: 'lyr', name: DOMAIN, owner: 'Lyrcloud', note: 'Lyrcloud Edge Functions. Records are managed automatically by the functions API.', createdAt: now(),
      ...(entry || {}),
      ...LYR_KEY, records, updatedAt: now(), fnVersion: version + 1,
    };
    const condition = !entry
      ? { ConditionExpression: 'attribute_not_exists(pk)' }
      : entry.fnVersion
        ? { ConditionExpression: 'fnVersion = :v', ExpressionAttributeValues: { ':v': version } }
        : { ConditionExpression: 'attribute_not_exists(fnVersion)' };
    try {
      await ddb.send(new PutCommand({ TableName: DOMAINS_TABLE, Item: item, ...condition }));
      return;
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
      await timing.sleep(50 + Math.floor(Math.random() * 200));
    }
  }
  throw new Error(`Couldn’t update the ${DOMAIN} records: too many changes at once.`);
}

// ---------------------------------------------------------------- AWS resources for one function

async function waitUntilReady(functionName) {
  for (let i = 0; i < 40; i += 1) {
    const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
    if (config.State === 'Failed' || config.LastUpdateStatus === 'Failed') {
      throw new UserError(500, `Lambda couldn’t prepare the function: ${config.StateReason || config.LastUpdateStatusReason || 'unknown reason'}`);
    }
    if (config.State === 'Active' && config.LastUpdateStatus !== 'InProgress') return config;
    await timing.sleep(500);
  }
  throw new UserError(504, 'The function is taking longer than usual to start. Run deploy again in a minute.');
}

async function putLambda(name, zip, main, vars, bindings, ownerId) {
  const FunctionName = lambdaName(name);
  const Environment = {
    Variables: {
      LYR_MAIN: main,
      LYR_VARS: JSON.stringify(vars),
      LYR_BINDINGS: JSON.stringify(bindings),
      LYR_PLATFORM: PLATFORM_FUNCTION || '',
      LYR_TOKEN: signToken(await platformSecret(), { fn: name, owner: ownerId }),
      NODE_OPTIONS: '--enable-source-maps',
    },
  };
  let exists = true;
  try {
    await lambda.send(new GetFunctionConfigurationCommand({ FunctionName }));
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
    exists = false;
  }
  if (!exists) {
    const LogGroup = `/aws/lambda/${FunctionName}`;
    try {
      await logs.send(new CreateLogGroupCommand({ logGroupName: LogGroup, tags: { lyrcloud: 'edge-functions' } }));
    } catch (err) {
      if (err.name !== 'ResourceAlreadyExistsException') throw err;
    }
    await logs.send(new PutRetentionPolicyCommand({ logGroupName: LogGroup, retentionInDays: LOG_RETENTION_DAYS }));
    // A brand-new IAM role can take a few seconds before Lambda may use it: retried by patiently().
    await patiently(() => lambda.send(new CreateFunctionCommand({
      FunctionName,
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: RUNTIME_HANDLER,
      Role: EXEC_ROLE_ARN,
      Code: { ZipFile: zip },
      MemorySize: FUNCTION_MEMORY,
      Timeout: FUNCTION_TIMEOUT,
      Environment,
      Tags: { lyrcloud: 'edge-functions', 'lyrcloud:owner': ownerId },
    })));
    return waitUntilReady(FunctionName);
  }
  await waitUntilReady(FunctionName);
  await patiently(() => lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName, Environment, MemorySize: FUNCTION_MEMORY, Timeout: FUNCTION_TIMEOUT, Handler: RUNTIME_HANDLER })));
  await waitUntilReady(FunctionName);
  await patiently(() => lambda.send(new UpdateFunctionCodeCommand({ FunctionName, ZipFile: zip })));
  return waitUntilReady(FunctionName);
}

// The custom domain name.dev.lyr, mapped to the router. Returns API Gateway's target host for the CNAME.
async function ensureDomain(name) {
  const DomainName = hostFor(name, DOMAIN);
  let domain;
  try {
    domain = await apigw.send(new GetDomainNameCommand({ DomainName }));
  } catch (err) {
    if (err.name !== 'NotFoundException') throw err;
    const cert = await ensureCertificate();
    try {
      domain = await patiently(() => apigw.send(new CreateDomainNameCommand({
        DomainName,
        DomainNameConfigurations: [{ CertificateArn: cert.arn, EndpointType: 'REGIONAL', SecurityPolicy: 'TLS_1_2' }],
        Tags: { lyrcloud: 'edge-functions' },
      })), { tries: 5, delay: 2000 });
    } catch (createErr) {
      if (createErr.name === 'TooManyRequestsException') {
        throw new UserError(503, `Your code is deployed, but ${DomainName} couldn’t be set up yet because many addresses are being created right now. Run deploy again in a minute.`);
      }
      if (createErr.name === 'LimitExceededException') {
        throw new UserError(503, `Your code is deployed, but Lyrcloud has reached its limit of addresses. Contact support to get ${DomainName} switched on.`);
      }
      throw createErr;
    }
  }
  const { Items = [] } = await apigw.send(new GetApiMappingsCommand({ DomainName }));
  if (!Items.some((mapping) => mapping.ApiId === INGRESS_API_ID)) {
    for (const mapping of Items) await apigw.send(new DeleteApiMappingCommand({ DomainName, ApiMappingId: mapping.ApiMappingId }));
    await patiently(() => apigw.send(new CreateApiMappingCommand({ DomainName, ApiId: INGRESS_API_ID, Stage: '$default' })));
  }
  return domain.DomainNameConfigurations?.[0]?.ApiGatewayDomainName;
}

async function removeFunctionResources(name) {
  const FunctionName = lambdaName(name);
  const DomainName = hostFor(name, DOMAIN);
  await setLyrRecord(DomainName, null);
  try {
    const { Items = [] } = await apigw.send(new GetApiMappingsCommand({ DomainName }));
    for (const mapping of Items) await patiently(() => apigw.send(new DeleteApiMappingCommand({ DomainName, ApiMappingId: mapping.ApiMappingId })));
    await patiently(() => apigw.send(new DeleteDomainNameCommand({ DomainName })));
  } catch (err) {
    if (err.name !== 'NotFoundException') throw err;
  }
  try {
    await lambda.send(new DeleteFunctionCommand({ FunctionName }));
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }
  try {
    await logs.send(new DeleteLogGroupCommand({ logGroupName: `/aws/lambda/${FunctionName}` }));
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }
}

// ---------------------------------------------------------------- routes

async function deploy(event, name, who) {
  const body = parseJson(event);
  if (!body) return error(400, 'Invalid JSON body.');
  const main = body.main ?? 'index.js';
  const mainProblem = mainError(main);
  if (mainProblem) return error(400, mainProblem);
  const [vars, varsProblem] = cleanVars(body.vars);
  if (varsProblem) return error(400, varsProblem);
  const [bindings, bindingsProblem] = cleanBindings({ kv: body.kv, buckets: body.buckets, ai: body.ai }, vars);
  if (bindingsProblem) return error(400, bindingsProblem);
  const [access, accessProblem] = cleanAccess(body.access);
  if (accessProblem) return error(400, accessProblem);
  if (typeof body.code !== 'string' || !body.code) return error(400, 'Send the code as a base64 zip in "code".');
  const code = Buffer.from(body.code, 'base64');
  if (code.length > MAX_CODE_BYTES) return error(413, `Functions can be at most ${MAX_CODE_BYTES / 1024 / 1024} MB zipped.`);
  let entries;
  try {
    entries = listZip(code);
  } catch (err) {
    if (err instanceof ZipError) return error(400, err.message);
    throw err;
  }
  const archiveProblem = archiveError(entries, main);
  if (archiveProblem) return error(400, archiveProblem);

  let item = await getItem(fnKey(name));
  if (item && item.ownerId !== who.userId) return error(409, `${hostFor(name, DOMAIN)} is taken. Choose another name in lyrcloud.json.`);
  if (item?.disabled && !isStaff(who.role)) return error(403, 'This function has been disabled by Lyrcloud. Contact support.');
  if (!item) {
    const limit = limitFor(who.plan);
    const mine = await functionsOf(who.userId);
    if (mine.length >= limit) return error(403, `Your plan includes ${limit} function${limit === 1 ? '' : 's'}. Delete one with \`lyrcloud delete\`, or upgrade your plan.`);
    item = { ...fnKey(name), kind: 'function', name, ownerId: who.userId, ownerEmail: who.email, status: 'deploying', deploys: 0, createdAt: now() };
    try {
      await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
    } catch (err) {
      if (isConditionFailure(err)) return error(409, `${hostFor(name, DOMAIN)} was just taken. Choose another name.`);
      throw err;
    }
  }

  const zip = addZipEntry(code, RUNTIME_ENTRY, runtime());
  try {
    await putLambda(name, zip, main, vars, bindings, who.userId);
    const target = await ensureDomain(name);
    await setLyrRecord(hostFor(name, DOMAIN), target);
  } catch (err) {
    const message = err instanceof UserError ? err.message : 'The deploy failed on Lyrcloud’s side. Please try again.';
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...item, status: item.deploys ? item.status : 'failed', lastError: message, updatedAt: now() } }));
    if (err instanceof UserError) return error(err.statusCode, err.message);
    throw err;
  }
  const saved = { ...item, status: 'live', main, vars, bindings, access: access || undefined, codeBytes: code.length, deploys: (item.deploys || 0) + 1, updatedAt: now(), lastError: undefined };
  delete saved.lastError;
  await ddb.send(new PutCommand({ TableName: TABLE, Item: saved }));
  return json(200, { function: publicFunction(saved) });
}

async function readLogs(event, name) {
  const query = event.queryStringParameters || {};
  const startTime = parseSince(query.since);
  if (startTime === null) return error(400, 'Use since like 15m, 2h or 1d.');
  try {
    const page = await logs.send(new FilterLogEventsCommand({
      logGroupName: `/aws/lambda/${lambdaName(name)}`,
      startTime,
      limit: Math.min(Number(query.limit) || 500, 1000),
      ...(query.next ? { nextToken: query.next } : {}),
    }));
    const events = (page.events || [])
      .filter((line) => !/^(START|END|REPORT|INIT_START) RequestId|^INIT_START/.test(line.message || ''))
      .map((line) => ({ id: line.eventId, time: new Date(line.timestamp).toISOString(), message: (line.message || '').replace(/\n$/, '') }));
    return json(200, { events, next: page.nextToken || null });
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return json(200, { events: [], next: null });
    throw err;
  }
}

async function functionRoutes(event, method, path, who) {
  if (path === '/functions' && method === 'GET') {
    const items = (await functionsOf(who.userId)).sort((a, b) => a.name.localeCompare(b.name));
    return json(200, { functions: items.map(publicFunction), limit: limitFor(who.plan), plan: who.plan, domain: DOMAIN });
  }
  const match = path.match(/^\/functions\/([^/]+)(\/logs|\/access-log)?$/);
  if (!match) return error(404, 'not_found');
  const name = decodeURIComponent(match[1]).toLowerCase();
  const problem = functionNameError(name);
  if (problem) return error(400, problem);
  if (method === 'PUT' && !match[2]) return deploy(event, name, who);

  const item = await getItem(fnKey(name));
  const mayRead = item && (item.ownerId === who.userId || isStaff(who.role));
  if (!mayRead) return error(404, `You have no function called ${name}.`);
  if (match[2] === '/logs' && method === 'GET') return readLogs(event, name);
  if (match[2] === '/access-log' && method === 'GET') return readAccessLog(event, item);
  if (!match[2] && method === 'GET') return json(200, { function: publicFunction(item) });
  if (!match[2] && method === 'DELETE') {
    if (item.ownerId !== who.userId && who.role !== 'superadmin') return error(403, 'Only the owner can delete this function.');
    await removeFunctionResources(name);
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: fnKey(name) }));
    return json(200, { deleted: name });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- storage routes (CLI)

function segments(event) {
  // rawPath keeps %2F inside keys; each segment is decoded on its own.
  const raw = event.rawPath || event.requestContext?.http?.path || '';
  return raw.split('/').filter((part, i) => i > 0).map((part) => decodeURIComponent(part));
}

async function storageRoutes(event, method, who) {
  const parts = segments(event);
  const query = event.queryStringParameters || {};
  if (parts.length === 1 && method === 'GET') {
    const kv = new Set();
    const buckets = new Set();
    for (const fn of await functionsOf(who.userId)) {
      for (const binding of fn.bindings || []) {
        if (binding.type === 'kv') kv.add(binding.name);
        else if (binding.type === 'bucket') buckets.add(binding.name);
      }
    }
    return json(200, { kv: [...kv].sort(), buckets: [...buckets].sort() });
  }
  const [, kind, store, collection, ...rest] = parts;
  const key = rest.join('/');
  const call = (request) => perform(who.userId, { store, ...request });
  if (kind === 'kv' && collection === 'keys') {
    if (!key && method === 'GET') return json(200, await call({ op: 'kv.list', options: { prefix: query.prefix, cursor: query.cursor, limit: query.limit } }));
    if (key && method === 'GET') {
      const found = await call({ op: 'kv.get', key });
      return found ? json(200, found) : error(404, `No key ${key} in ${store}.`);
    }
    if (key && method === 'PUT') {
      const body = parseJson(event);
      if (!body) return error(400, 'Invalid JSON body.');
      await call({ op: 'kv.put', key, value: body.value, options: { expirationTtl: body.expirationTtl, metadata: body.metadata } });
      return json(200, { ok: true });
    }
    if (key && method === 'DELETE') return json(200, await call({ op: 'kv.delete', key }));
  }
  if (kind === 'buckets' && collection === 'objects') {
    if (!key && method === 'GET') return json(200, await call({ op: 'object.list', options: { prefix: query.prefix, cursor: query.cursor, delimiter: query.delimiter, limit: query.limit } }));
    if (key && method === 'GET') {
      const found = await call({ op: 'object.get', key });
      return found ? json(200, found) : error(404, `No object ${key} in ${store}.`);
    }
    if (key && method === 'PUT') {
      const body = parseJson(event);
      if (!body) return error(400, 'Invalid JSON body.');
      return json(200, await call({ op: 'object.put', key, value: body.body, options: { contentType: body.contentType } }));
    }
    if (key && method === 'DELETE') return json(200, await call({ op: 'object.delete', key }));
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- access

async function logAccess(item, entry) {
  const at = new Date();
  await ddb.send(new PutCommand({
    TableName: DATA_TABLE,
    Item: {
      pk: `access#${item.ownerId}#${item.name}`, sk: `${at.toISOString()}#${newNonce()}`,
      ...entry, expiresAt: Math.floor(at.getTime() / 1000) + ACCESS_LOG_DAYS * 86400,
    },
  }));
}

async function grantAccess(event, who) {
  const body = parseJson(event);
  const request = verifyAccess(await platformSecret(), 'request', body?.to);
  if (!request) return error(400, 'This sign-in link has expired. Open the function’s address again.');
  const item = await getItem(fnKey(request.fn));
  if (!item) return error(404, 'That function no longer exists.');
  const host = hostFor(item.name, DOMAIN);
  if (!item.access) return json(200, { url: `https://${host}${request.ret}` });
  const email = who.email || null;
  if (!email) return error(400, 'Your Lyrcloud account has no email address. Add one in Account settings.');
  const allowed = isAllowed(item.access, email, item.ownerEmail);
  await logAccess(item, { email, allowed, path: request.ret.slice(0, 300), ip: event.requestContext?.http?.sourceIp || null, userAgent: String(event.headers?.['user-agent'] || '').slice(0, 300) });
  if (!allowed) return json(403, { error: `${email} isn’t allowed to open ${host}. Ask its owner to add you.`, email, host });
  const ticket = sign(await platformSecret(), 'ticket', { fn: item.name, email, ret: request.ret, nonce: newNonce() }, TICKET_SECONDS);
  return json(200, { url: `https://${host}/__lyrcloud/access?ticket=${encodeURIComponent(ticket)}`, email, host });
}

async function readAccessLog(event, item) {
  const since = parseSince(event.queryStringParameters?.since || '7d');
  if (since === null) return error(400, 'Use since like 1h, 7d or 30d.');
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: DATA_TABLE,
    KeyConditionExpression: 'pk = :pk AND sk >= :since',
    ExpressionAttributeValues: { ':pk': `access#${item.ownerId}#${item.name}`, ':since': new Date(since).toISOString() },
    ScanIndexForward: false,
    Limit: 500,
  }));
  return json(200, { events: Items.map((row) => ({ time: row.sk.split('#')[0], email: row.email, allowed: row.allowed, path: row.path, ip: row.ip })) });
}

async function aiRoutes(event, method, path, who) {
  if (path === '/ai/models' && method === 'GET') return json(200, { models: listModels(who.plan), plan: who.plan });
  if (path === '/ai/usage' && method === 'GET') {
    const when = event.queryStringParameters?.month;
    if (when && !/^\d{4}-\d{2}$/.test(when)) return error(400, 'Use month=YYYY-MM.');
    return json(200, { ...(await usageOf(who.userId, when || undefined)), plan: who.plan, limits: aiLimitsFor(who.plan) });
  }
  if ((path === '/ai/run' || path === '/ai/embed') && method === 'POST') {
    const body = parseJson(event);
    if (!body) return error(400, 'Invalid JSON body.');
    return json(200, await performAny(who.userId, { op: path === '/ai/run' ? 'ai.run' : 'ai.embed', model: body.model, input: body.input, options: body.options || {} }));
  }
  return error(404, 'not_found');
}

async function adminRoutes(method, path, who) {
  if (!isStaff(who.role)) return error(403, 'Staff only.');
  if (path === '/admin/functions' && method === 'GET') {
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(new ScanCommand({ TableName: TABLE, FilterExpression: '#k = :f', ExpressionAttributeNames: { '#k': 'kind' }, ExpressionAttributeValues: { ':f': 'function' }, ExclusiveStartKey }));
      items.push(...(page.Items || []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    const certificate = await getItem(CERT_KEY);
    return json(200, {
      functions: items.sort((a, b) => a.name.localeCompare(b.name)).map((item) => ({ ...publicFunction(item), ownerEmail: item.ownerEmail || null })),
      certificate: certificate ? { notAfter: certificate.notAfter, issuedAt: certificate.issuedAt } : null,
    });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- entry

export const handler = async (event) => {
  if (event.task === 'renew-certificate' || event.source === 'aws.events') {
    const cert = await ensureCertificate({ force: event.force === true });
    return { arn: cert.arn, notAfter: cert.notAfter };
  }
  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  try {
    const who = await caller(event);
    if (!who) return error(401, 'Sign in again with `lyrcloud login`.');
    if (who.profile.disabled === true && who.role !== 'superadmin') return error(403, 'This account has been disabled.');
    if (path.startsWith('/admin/')) return await adminRoutes(method, path, who);
    if (path === '/functions' || path.startsWith('/functions/')) return await functionRoutes(event, method, path, who);
    if (path === '/storage' || path.startsWith('/storage/')) return await storageRoutes(event, method, who);
    if (path.startsWith('/ai/')) return await aiRoutes(event, method, path, who);
    if (path === '/access/grant' && method === 'POST') return await grantAccess(event, who);
    return error(404, 'not_found');
  } catch (err) {
    console.error('Functions API failed', err);
    if (err instanceof UserError) return error(err.statusCode, err.message);
    if (err instanceof StorageError) return error(err.status, err.message);
    if (err instanceof URIError) return error(400, 'That key isn’t encoded correctly.');
    return error(500, 'Something went wrong on Lyrcloud’s side. Please try again.');
  }
};
