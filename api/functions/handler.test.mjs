// Edge Functions API with DynamoDB, Lambda, API Gateway, ACM, CloudWatch Logs and Secrets Manager faked.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ACMClient } from '@aws-sdk/client-acm';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createRoot } from '../domains/lyrca.mjs';

Object.assign(process.env, {
  TABLE_NAME: 'functions', USERS_TABLE_NAME: 'users', DOMAINS_TABLE_NAME: 'domains', FUNCTIONS_DOMAIN: 'dev.lyr',
  EXEC_ROLE_ARN: 'arn:aws:iam::1:role/exec', INGRESS_API_ID: 'ingress', LYR_CA_SECRET_NAME: 'ca',
  PLATFORM_SECRET: 'test-secret', PLATFORM_FUNCTION: 'lyrcloud-functions-platform', DATA_TABLE_NAME: 'data',
});
const { handler, timing } = await import('./index.mjs');
const { createZip, listZip } = await import('./zip.mjs');
timing.sleep = async () => {};

const root = createRoot();
let tables; // table -> Map("pk|sk" -> item)
let users;
let lambdas; // name -> { zip, env, state }
let domains; // host -> { mappings: [], target }
let certs;
let logGroups;
let throttleDomains;

const k = (key) => `${key.pk}|${key.sk}`;
const table = (name) => (tables[name] ??= new Map());
const awsError = (name) => Object.assign(new Error(name), { name });

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const input = command.input;
  if (input.TableName === 'users') return { Item: structuredClone(users.get(input.Key.userId)) };
  const t = table(input.TableName);
  if (name === 'GetCommand') return { Item: structuredClone(t.get(k(input.Key))) };
  if (name === 'PutCommand') {
    const existing = t.get(k(input.Item));
    const cond = input.ConditionExpression;
    if (cond === 'attribute_not_exists(pk)' && existing) throw awsError('ConditionalCheckFailedException');
    if (cond === 'attribute_not_exists(fnVersion)' && existing?.fnVersion) throw awsError('ConditionalCheckFailedException');
    if (cond === 'fnVersion = :v' && existing?.fnVersion !== input.ExpressionAttributeValues[':v']) throw awsError('ConditionalCheckFailedException');
    t.set(k(input.Item), structuredClone(input.Item));
    return {};
  }
  if (name === 'DeleteCommand') {
    t.delete(k(input.Key));
    return {};
  }
  if (name === 'QueryCommand' && input.ExpressionAttributeValues[':pk']) {
    return { Items: [...t.values()].filter((item) => item.pk === input.ExpressionAttributeValues[':pk']) };
  }
  if (name === 'QueryCommand') {
    const owner = input.ExpressionAttributeValues[':o'];
    return { Items: [...t.values()].filter((item) => item.ownerId === owner) };
  }
  if (name === 'ScanCommand') return { Items: [...t.values()].filter((item) => item.kind === 'function') };
  throw new Error(`unexpected ${name}`);
};

LambdaClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const { FunctionName } = command.input;
  if (name === 'GetFunctionConfigurationCommand') {
    if (!lambdas.has(FunctionName)) throw awsError('ResourceNotFoundException');
    return { State: 'Active', LastUpdateStatus: 'Successful' };
  }
  if (name === 'CreateFunctionCommand') {
    lambdas.set(FunctionName, { zip: command.input.Code.ZipFile, env: command.input.Environment.Variables, handler: command.input.Handler });
    return {};
  }
  if (name === 'UpdateFunctionCodeCommand') {
    lambdas.get(FunctionName).zip = command.input.ZipFile;
    return {};
  }
  if (name === 'UpdateFunctionConfigurationCommand') {
    lambdas.get(FunctionName).env = command.input.Environment.Variables;
    return {};
  }
  if (name === 'DeleteFunctionCommand') {
    lambdas.delete(FunctionName);
    return {};
  }
  throw new Error(`unexpected ${name}`);
};

ApiGatewayV2Client.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const { DomainName } = command.input;
  const configs = (host) => ({ DomainNameConfigurations: [{ ApiGatewayDomainName: domains.get(host).target }] });
  if (name === 'GetDomainNameCommand') {
    if (!domains.has(DomainName)) throw awsError('NotFoundException');
    return configs(DomainName);
  }
  if (name === 'CreateDomainNameCommand') {
    if (throttleDomains) throw awsError('TooManyRequestsException');
    assert.equal(command.input.DomainNameConfigurations[0].CertificateArn, 'arn:cert:1');
    domains.set(DomainName, { mappings: [], target: `d-${DomainName.split('.')[0]}.execute-api.us-east-1.amazonaws.com` });
    return configs(DomainName);
  }
  if (name === 'GetApiMappingsCommand') {
    if (!domains.has(DomainName)) throw awsError('NotFoundException');
    return { Items: domains.get(DomainName).mappings };
  }
  if (name === 'CreateApiMappingCommand') {
    domains.get(DomainName).mappings.push({ ApiId: command.input.ApiId, ApiMappingId: 'm1' });
    return {};
  }
  if (name === 'DeleteApiMappingCommand') {
    domains.get(DomainName).mappings = [];
    return {};
  }
  if (name === 'DeleteDomainNameCommand' && throttleDomains) throw awsError('TooManyRequestsException');
  if (name === 'DeleteDomainNameCommand') {
    domains.delete(DomainName);
    return {};
  }
  throw new Error(`unexpected ${name}`);
};

ACMClient.prototype.send = async function send(command) {
  certs.push(command.input);
  assert.match(command.input.Certificate.toString(), /BEGIN CERTIFICATE/);
  return { CertificateArn: command.input.CertificateArn || 'arn:cert:1' };
};

SecretsManagerClient.prototype.send = async function send() {
  return { SecretString: JSON.stringify({ keyPem: root.keyPem, certPem: root.certPem }) };
};

CloudWatchLogsClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  if (name === 'CreateLogGroupCommand') { logGroups.add(command.input.logGroupName); return {}; }
  if (name === 'PutRetentionPolicyCommand') { assert.equal(command.input.retentionInDays, 7); return {}; }
  if (name === 'DeleteLogGroupCommand') { logGroups.delete(command.input.logGroupName); return {}; }
  if (name === 'FilterLogEventsCommand') {
    return { events: [
      { eventId: '1', timestamp: 1, message: 'START RequestId: abc Version: $LATEST\n' },
      { eventId: '2', timestamp: 2, message: '2026-01-01T00:00:00Z\tabc\tINFO\thello\n' },
    ] };
  }
  throw new Error(`unexpected ${name}`);
};

beforeEach(() => {
  tables = {};
  users = new Map([['u1', { userId: 'u1', email: 'one@example.com' }], ['u2', { userId: 'u2', email: 'two@example.com' }]]);
  lambdas = new Map();
  domains = new Map();
  certs = [];
  logGroups = new Set();
  throttleDomains = false;
});

const call = (method, path, { user = 'u1', body, query } = {}) => handler({
  requestContext: { http: { method, path }, authorizer: { jwt: { claims: { sub: user } } } },
  body: body === undefined ? undefined : JSON.stringify(body),
  queryStringParameters: query,
});
const parse = (res) => ({ status: res.statusCode, ...JSON.parse(res.body) });
const code = (files = [{ name: 'index.js', data: 'export default { fetch() { return new Response("hi") } }' }]) => createZip(files).toString('base64');

test('deploy creates the Lambda, domain, certificate and .lyr record', async () => {
  const res = parse(await call('PUT', '/functions/hello-edge', { body: { code: code(), main: 'index.js', vars: { GREETING: 'hi' } } }));
  assert.equal(res.status, 200, res.error);
  assert.equal(res.function.url, 'https://hello-edge.dev.lyr');
  assert.equal(res.function.status, 'live');
  const fn = lambdas.get('lyrfn-hello-edge');
  assert.equal(fn.handler, '__lyrcloud/runtime.handler');
  assert.deepEqual(listZip(fn.zip).map((e) => e.name), ['index.js', '__lyrcloud/runtime.mjs']);
  assert.equal(fn.env.LYR_MAIN, 'index.js');
  assert.equal(fn.env.LYR_VARS, '{"GREETING":"hi"}');
  assert.deepEqual(domains.get('hello-edge.dev.lyr').mappings.map((m) => m.ApiId), ['ingress']);
  assert.equal(certs.length, 1);
  assert.ok(logGroups.has('/aws/lambda/lyrfn-hello-edge'));
  const lyr = table('domains').get('lyr#dev.lyr|lyr');
  assert.deepEqual(lyr.records, [{ type: 'CNAME', name: 'hello-edge.dev.lyr', values: ['d-hello-edge.execute-api.us-east-1.amazonaws.com'], ttl: 300 }]);

  // Redeploy updates in place and keeps the certificate.
  const again = parse(await call('PUT', '/functions/hello-edge', { body: { code: code(), main: 'index.js' } }));
  assert.equal(again.function.deploys, 2);
  assert.equal(certs.length, 1);
  assert.equal(lambdas.get('lyrfn-hello-edge').env.LYR_VARS, '{}');

  // A second function adds its record next to the first.
  await call('PUT', '/functions/other', { body: { code: code() } });
  assert.deepEqual(table('domains').get('lyr#dev.lyr|lyr').records.map((r) => r.name), ['hello-edge.dev.lyr', 'other.dev.lyr']);
});

test('names belong to whoever claimed them first', async () => {
  await call('PUT', '/functions/mine', { body: { code: code() } });
  const res = parse(await call('PUT', '/functions/mine', { user: 'u2', body: { code: code() } }));
  assert.equal(res.status, 409);
  assert.equal(parse(await call('GET', '/functions/mine', { user: 'u2' })).status, 404);
  assert.equal(parse(await call('DELETE', '/functions/mine', { user: 'u2' })).status, 404);
});

test('bad uploads are refused before anything is created', async () => {
  assert.equal(parse(await call('PUT', '/functions/x', { body: { code: 'bm90IGEgemlw' } })).status, 400);
  assert.match(parse(await call('PUT', '/functions/x', { body: { code: code(), main: 'main.js' } })).error, /isn’t in the upload/);
  assert.match(parse(await call('PUT', '/functions/Bad_Name', { body: { code: code() } })).error, /lowercase/);
  assert.equal(lambdas.size, 0);
  assert.equal(table('functions').size, 0);
});

test('plan limit', async () => {
  for (let i = 0; i < 5; i += 1) assert.equal((await call('PUT', `/functions/f${i}`, { body: { code: code() } })).statusCode, 200);
  const res = parse(await call('PUT', '/functions/f5', { body: { code: code() } }));
  assert.equal(res.status, 403);
  assert.match(res.error, /5 functions/);
});

test('a throttled domain still leaves the code deployed and says to retry', async () => {
  throttleDomains = true;
  const res = parse(await call('PUT', '/functions/slow', { body: { code: code() } }));
  assert.equal(res.status, 503);
  assert.match(res.error, /Run deploy again/);
  assert.ok(lambdas.has('lyrfn-slow'));
  throttleDomains = false;
  assert.equal((await call('PUT', '/functions/slow', { body: { code: code() } })).statusCode, 200);
});

test('list, logs and delete', async () => {
  await call('PUT', '/functions/hello', { body: { code: code() } });
  const list = parse(await call('GET', '/functions'));
  assert.deepEqual(list.functions.map((f) => f.name), ['hello']);
  assert.equal(list.limit, 5);
  const logs = parse(await call('GET', '/functions/hello/logs', { query: { since: '1h' } }));
  assert.deepEqual(logs.events.map((e) => e.id), ['2']);
  const del = parse(await call('DELETE', '/functions/hello'));
  assert.equal(del.deleted, 'hello');
  assert.equal(lambdas.size, 0);
  assert.equal(domains.size, 0);
  assert.equal(logGroups.size, 0);
  assert.deepEqual(table('domains').get('lyr#dev.lyr|lyr').records, []);
  assert.equal(parse(await call('GET', '/functions')).functions.length, 0);
});

test('the daily task renews the certificate in place when it is close to expiry', async () => {
  const first = await handler({ task: 'renew-certificate' });
  assert.equal(first.arn, 'arn:cert:1');
  await handler({ task: 'renew-certificate' });
  assert.equal(certs.length, 1); // still fresh
  const item = table('functions').get('system|certificate');
  item.notAfter = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await handler({ task: 'renew-certificate' });
  assert.equal(certs.length, 2);
  assert.equal(certs[1].CertificateArn, 'arn:cert:1');
});

test('unsigned callers are turned away', async () => {
  const res = await handler({ requestContext: { http: { method: 'GET', path: '/functions' } } });
  assert.equal(res.statusCode, 401);
});

test('deploying with storage bindings gives the function a token for its owner', async () => {
  const { readToken } = await import('./storage.mjs');
  const res = parse(await call('PUT', '/functions/stored', { body: { code: code(), kv: { CACHE: 'cache' }, buckets: { FILES: 'uploads' }, ai: 'AI' } }));
  assert.equal(res.status, 200, res.error);
  assert.deepEqual(res.function.bindings.map((b) => b.binding), ['AI', 'CACHE', 'FILES']);
  const fnEnv = lambdas.get('lyrfn-stored').env;
  assert.equal(fnEnv.LYR_PLATFORM, 'lyrcloud-functions-platform');
  assert.deepEqual(JSON.parse(fnEnv.LYR_BINDINGS), [{ binding: 'AI', type: 'ai', name: 'ai' }, { binding: 'CACHE', type: 'kv', name: 'cache' }, { binding: 'FILES', type: 'bucket', name: 'uploads' }]);
  assert.deepEqual(readToken('test-secret', fnEnv.LYR_TOKEN), { fn: 'stored', owner: 'u1' });
  assert.match(parse(await call('PUT', '/functions/bad', { body: { code: code(), kv: { 'no good': 'x' } } })).error, /valid binding/);
  const storage = parse(await call('GET', '/storage'));
  assert.deepEqual(storage, { status: 200, kv: ['cache'], buckets: ['uploads'] });
});

test('a delete while API Gateway is busy still takes the function down, and the daily run removes the address', async () => {
  await call('PUT', '/functions/busy', { body: { code: code() } });
  throttleDomains = true;
  const res = parse(await call('DELETE', '/functions/busy'));
  assert.equal(res.status, 200, res.error);
  assert.equal(lambdas.has('lyrfn-busy'), false);
  assert.deepEqual(table('domains').get('lyr#dev.lyr|lyr').records, []);
  assert.ok(domains.has('busy.dev.lyr'));
  assert.ok(table('data').has('cleanup#domain|busy'));
  throttleDomains = false;
  const daily = await handler({ task: 'renew-certificate' });
  assert.equal(daily.domainsRemoved, 1);
  assert.equal(domains.has('busy.dev.lyr'), false);
  assert.equal(table('data').size, 0);
});
