// Projects API with DynamoDB, CodeBuild, S3, the router's KeyValueStore and GitHub replaced by fakes.
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { CodeBuildClient } from '@aws-sdk/client-codebuild';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP = { id: 7, slug: 'lyrcloud-deploy', client_id: 'Iv1.app', client_secret: 'app-secret', webhook_secret: 'hook-secret', pem: privateKey.export({ type: 'pkcs1', format: 'pem' }), html_url: 'https://github.com/apps/lyrcloud-deploy' };
Object.assign(process.env, {
  TABLE_NAME: 'projects', USERS_TABLE_NAME: 'users', SITES_BUCKET: 'sites', ARTIFACTS_BUCKET: 'artifacts', BUILDER_PROJECT: 'builder',
  KVS_ARN: 'arn:kvs', SITES_DOMAIN: 'lyrcloud.app', PROJECTS_SECRET: 'projects-secret', GITHUB_APP_JSON: JSON.stringify(APP),
});
const { handler } = await import('./index.mjs');
const { signState } = await import('./github.mjs');

let items; // "table|pk|sk" → item
let users;
let builds;
let objects; // "bucket/key" → { size, contentType }
let routes;
let githubCalls;

const key = (pk, sk) => `${pk}|${sk}`;
const project = (id) => items.get(key(`project#${id}`, 'project'));

DynamoDBDocumentClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  const input = command.input;
  if (input.TableName === 'users') return { Item: structuredClone(users.get(input.Key.userId)) };
  const all = () => [...items.values()];
  if (name === 'GetCommand') return { Item: structuredClone(items.get(key(input.Key.pk, input.Key.sk))) };
  if (name === 'PutCommand') {
    const k = key(input.Item.pk, input.Item.sk);
    if (input.ConditionExpression && items.has(k)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    items.set(k, structuredClone(input.Item));
    return {};
  }
  if (name === 'DeleteCommand') return items.delete(key(input.Key.pk, input.Key.sk)), {};
  if (name === 'ScanCommand') return { Items: all().filter((item) => item.sk === 'project').map((item) => structuredClone(item)) };
  if (name === 'QueryCommand') {
    const values = input.ExpressionAttributeValues;
    let found;
    if (input.IndexName === 'byOwner') found = all().filter((item) => item.ownerId === values[':o'] && item.sk === 'project');
    else if (input.IndexName === 'byRepo') found = all().filter((item) => item.repoKey === values[':r']);
    else found = all().filter((item) => item.pk === values[':pk'] && item.sk.startsWith(values[':d']));
    return { Items: found.map((item) => structuredClone(item)) };
  }
  if (name === 'UpdateCommand') {
    const k = key(input.Key.pk, input.Key.sk);
    const item = items.get(k) || { ...input.Key };
    const names = input.ExpressionAttributeNames || {};
    const values = input.ExpressionAttributeValues || {};
    for (const [, clause, body] of input.UpdateExpression.matchAll(/(SET|REMOVE|ADD) (.*?)(?= (?:SET|REMOVE|ADD) |$)/g)) {
      for (const part of body.split(', ')) {
        if (clause === 'SET') {
          const [field, token] = part.split(' = ');
          item[names[field] || field] = values[token];
        } else if (clause === 'REMOVE') delete item[names[part] || part];
        else {
          const [field, token] = part.split(' ');
          item[field] = (item[field] || 0) + values[token];
        }
      }
    }
    items.set(k, item);
    return { Attributes: structuredClone(item) };
  }
  throw new Error(`unexpected ${name}`);
};

CodeBuildClient.prototype.send = async function send(command) {
  if (command.constructor.name === 'StartBuildCommand') {
    const id = `builder:${builds.size + 1}`;
    builds.set(id, { id, environment: { environmentVariables: command.input.environmentVariablesOverride }, input: command.input, exportedEnvironmentVariables: [{ name: 'LYR_COMMIT', value: 'abc123' }, { name: 'LYR_FRAMEWORK', value: 'vite' }] });
    return { build: { id } };
  }
  return { builds: command.input.ids.map((id) => builds.get(id)) };
};

S3Client.prototype.send = async function send(command) {
  const { Bucket } = command.input;
  const name = command.constructor.name;
  if (name === 'ListObjectsV2Command') {
    const Contents = [...objects].filter(([k]) => k.startsWith(`${Bucket}/${command.input.Prefix}`)).map(([k, v]) => ({ Key: k.slice(Bucket.length + 1), Size: v.size }));
    return { Contents, IsTruncated: false };
  }
  if (name === 'CopyObjectCommand') {
    const source = decodeURIComponent(command.input.CopySource);
    objects.set(`${Bucket}/${command.input.Key}`, { ...objects.get(source), contentType: command.input.ContentType });
    return {};
  }
  if (name === 'DeleteObjectsCommand') {
    for (const { Key } of command.input.Delete.Objects) objects.delete(`${Bucket}/${Key}`);
    return {};
  }
  throw new Error(`unexpected ${name}`);
};

CloudFrontKeyValueStoreClient.prototype.send = async function send(command) {
  const name = command.constructor.name;
  if (name === 'DescribeKeyValueStoreCommand') return { ETag: 'etag' };
  if (name === 'PutKeyCommand') return routes.set(command.input.Key, command.input.Value), {};
  if (name === 'DeleteKeyCommand') return routes.delete(command.input.Key), {};
  throw new Error(`unexpected ${name}`);
};

// GitHub: an installation that can see "ada/blog", and a user who can create repositories.
globalThis.fetch = async (url, options = {}) => {
  const { pathname } = new URL(url);
  githubCalls.push([options.method || 'GET', pathname, options.body ? JSON.parse(options.body) : undefined]);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (pathname === '/login/oauth/access_token') return reply({ access_token: 'ghu_user', refresh_token: 'ghr_refresh', expires_in: 28800, refresh_token_expires_in: 15811200 });
  if (pathname === '/user') return reply({ login: 'ada', id: 99 });
  if (pathname === '/user/installations') return reply({ installations: [{ id: 555, repository_selection: 'all' }] });
  if (pathname === '/app/installations/555/access_tokens') return reply({ token: 'ghs_install' });
  if (pathname === '/installation/repositories') return reply({ repositories: [{ id: 1, full_name: 'ada/blog', private: false, default_branch: 'main', html_url: 'https://github.com/ada/blog', pushed_at: '2026-01-01' }] });
  if (pathname === '/user/repos') return reply({ id: 2, full_name: `ada/${JSON.parse(options.body).name}`, default_branch: 'main' }, 201);
  if (pathname === '/repos/vercel/next-site/forks') return reply({ id: 3, full_name: 'ada/next-site', default_branch: 'canary' }, 202);
  return reply({ message: 'Not Found' }, 404);
};

const ADA = { userId: 'user-ada', email: 'ada@example.com', provider: 'GoogleOIDC', plan: 'launch' };
const BOB = { userId: 'user-bob', email: 'bob@example.com', provider: 'GoogleOIDC', plan: 'launch' };
const STAFF = { userId: 'user-staff', email: 'staff@example.com', provider: 'GoogleOIDC', role: 'admin' };

async function call(person, method, path, body) {
  const response = await handler({
    requestContext: { http: { method, path }, domainName: 'projects.example.com', authorizer: person ? { jwt: { claims: { sub: person.userId } } } : undefined },
    headers: {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.statusCode, body: response.headers?.['content-type']?.includes('json') ? JSON.parse(response.body) : response.body, headers: response.headers };
}

// Simulates CodeBuild finishing `buildId`: files land under builds/<deployId>/, then the state event.
async function finishBuild(buildId, files, status = 'SUCCEEDED') {
  const build = builds.get(buildId);
  const vars = Object.fromEntries(build.environment.environmentVariables.map(({ name, value }) => [name, value]));
  for (const [file, size] of Object.entries(files)) objects.set(`artifacts/builds/${vars.LYR_DEPLOY_ID}/${file}`, { size });
  await handler({ source: 'aws.codebuild', detail: { 'build-status': 'IN_PROGRESS', 'build-id': buildId, 'additional-information': { environment: { 'environment-variables': build.environment.environmentVariables } } } });
  await handler({ source: 'aws.codebuild', detail: { 'build-status': status, 'build-id': buildId, 'additional-information': {} } });
  return vars;
}

beforeEach(() => {
  items = new Map();
  users = new Map([ADA, BOB, STAFF].map((person) => [person.userId, person]));
  builds = new Map();
  objects = new Map();
  routes = new Map();
  githubCalls = [];
});

test('import a public URL, build it and go live', async () => {
  const res = await call(ADA, 'POST', '/projects', { name: 'ada-blog', source: { url: 'https://gitlab.com/ada/blog/-/tree/pages' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.project.url, 'https://ada-blog.lyrcloud.app');
  assert.equal(res.body.deployment.status, 'queued');
  const [buildId] = builds.keys();
  const vars = await finishBuild(buildId, { 'index.html': 100, 'about.html': 50, 'css/site.css': 20 });
  assert.equal(vars.LYR_SOURCE_URL, 'https://gitlab.com/ada/blog.git');
  assert.equal(vars.LYR_BRANCH, 'pages');
  assert.equal(builds.get(buildId).input.artifactsOverride.name, vars.LYR_DEPLOY_ID);

  const live = project(res.body.project.projectId);
  assert.equal(live.status, 'live');
  assert.equal(routes.get('ada-blog'), `${live.projectId}/${vars.LYR_DEPLOY_ID}|static`);
  const site = `sites/sites/${live.projectId}/${vars.LYR_DEPLOY_ID}`;
  assert.equal(objects.get(`${site}/css/site.css`).contentType, 'text/css; charset=utf-8');
  assert.ok(objects.has(`${site}/about/index.html`), 'clean URL copy of about.html');
  assert.equal([...objects.keys()].some((k) => k.startsWith('artifacts/')), false, 'artifacts are cleaned up');

  const detail = await call(ADA, 'GET', `/projects/${live.projectId}`);
  assert.equal(detail.body.deployments[0].status, 'live');
  assert.equal(detail.body.deployments[0].commit, 'abc123');
  assert.equal(detail.body.deployments[0].framework, 'vite');
  assert.equal((await call(BOB, 'GET', `/projects/${live.projectId}`)).status, 404, 'other people can’t see it');
});

test('names are unique, reserved names refused, plans limit projects', async () => {
  assert.equal((await call(ADA, 'POST', '/projects', { name: 'www', source: { url: 'https://github.com/a/b' } })).status, 400);
  assert.equal((await call(ADA, 'POST', '/projects', { name: 'site-one', source: { url: 'http://insecure.example/a' } })).status, 400);
  assert.equal((await call(ADA, 'POST', '/projects', { name: 'site-one', source: { url: 'https://github.com/a/b' } })).status, 201);
  assert.equal((await call(BOB, 'POST', '/projects', { name: 'site-one', source: { url: 'https://github.com/a/b' } })).status, 409);
  await call(ADA, 'POST', '/projects', { name: 'site-two', source: { url: 'https://github.com/a/b' } });
  await call(ADA, 'POST', '/projects', { name: 'site-three', source: { url: 'https://github.com/a/b' } });
  assert.equal((await call(ADA, 'POST', '/projects', { name: 'site-four', source: { url: 'https://github.com/a/b' } })).status, 403);
});

test('a slow older build doesn’t replace a newer live one, failures are reported, rollback works', async () => {
  const { body } = await call(ADA, 'POST', '/projects', { name: 'racer', source: { url: 'https://github.com/a/b' } });
  await call(ADA, 'POST', `/projects/${body.project.projectId}/deployments`);
  const [first, second] = builds.keys();
  const newer = await finishBuild(second, { 'index.html': 1 });
  const older = await finishBuild(first, { 'index.html': 1 });
  assert.equal(project(body.project.projectId).liveDeployId, newer.LYR_DEPLOY_ID);
  assert.equal(routes.get('racer').split('|')[0].split('/')[1], newer.LYR_DEPLOY_ID);

  await call(ADA, 'POST', `/projects/${body.project.projectId}/deployments`);
  await finishBuild([...builds.keys()][2], {}, 'FAILED');
  const deployments = (await call(ADA, 'GET', `/projects/${body.project.projectId}`)).body.deployments;
  assert.equal(deployments[0].status, 'failed');
  assert.equal(project(body.project.projectId).status, 'live', 'a failed build leaves the site up');

  const rollback = await call(ADA, 'POST', `/projects/${body.project.projectId}/deployments/${older.LYR_DEPLOY_ID}/promote`);
  assert.equal(rollback.status, 200);
  assert.equal(routes.get('racer').split('|')[0].split('/')[1], older.LYR_DEPLOY_ID);
});

test('a build without index.html fails', async () => {
  const { body } = await call(ADA, 'POST', '/projects', { name: 'no-index', source: { url: 'https://github.com/a/b' } });
  await finishBuild([...builds.keys()][0], { 'readme.md': 5 });
  assert.match((await call(ADA, 'GET', `/projects/${body.project.projectId}`)).body.deployments[0].error, /index\.html/);
  assert.equal(routes.has('no-index'), false);
});

async function connectGithub(person = ADA) {
  const state = signState('projects-secret', { u: person.userId, t: 'install' });
  const res = await handler({ requestContext: { http: { method: 'GET', path: '/public/github/callback' }, domainName: 'p' }, queryStringParameters: { code: 'c', installation_id: '555', state }, headers: {} });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /#\/projects\?github=connected$/);
}

test('connecting GitHub stores an encrypted token and lists repositories', async () => {
  assert.equal((await handler({ requestContext: { http: { method: 'GET', path: '/public/github/callback' } }, queryStringParameters: { code: 'c', state: 'forged.x' }, headers: {} })).statusCode, 400);
  await connectGithub();
  const stored = items.get(key(`github#${ADA.userId}`, 'connection'));
  assert.equal(stored.login, 'ada');
  assert.equal(JSON.stringify(stored).includes('ghu_user'), false, 'tokens are sealed');
  const listing = await call(ADA, 'GET', '/projects');
  assert.deepEqual(listing.body.github.connected, true);
  assert.equal((await call(ADA, 'GET', '/projects/github/repos')).body.repos[0].fullName, 'ada/blog');
  assert.equal((await call(ADA, 'POST', '/projects/github/connect')).body.installUrl.startsWith('https://github.com/apps/lyrcloud-deploy/installations/new?state='), true);
});

const signedPush = (payload) => {
  const body = JSON.stringify(payload);
  return handler({
    requestContext: { http: { method: 'POST', path: '/public/github/webhook' } },
    headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP.webhook_secret).update(body).digest('hex')}` },
    body,
  }).then((res) => ({ status: res.statusCode, body: JSON.parse(res.body) }));
};

test('a linked GitHub repository redeploys on push to its branch', async () => {
  await connectGithub();
  const created = await call(ADA, 'POST', '/projects', { name: 'linked', source: { repo: 'ada/blog' } });
  assert.equal(created.status, 201);
  const vars = Object.fromEntries([...builds.values()][0].environment.environmentVariables.map(({ name, value }) => [name, value]));
  assert.equal(vars.LYR_SOURCE_URL, 'https://x-access-token:ghs_install@github.com/ada/blog.git');

  assert.equal((await signedPush({ ref: 'refs/heads/main', after: 'f00d', repository: { id: 1 }, head_commit: { message: 'Fix typo\n\nmore' } })).body.started.length, 1);
  assert.equal((await signedPush({ ref: 'refs/heads/dev', after: 'beef', repository: { id: 1 } })).body.started.length, 0);
  const forged = await handler({ requestContext: { http: { method: 'POST', path: '/public/github/webhook' } }, headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
  assert.equal(forged.statusCode, 401);
  const latest = (await call(ADA, 'GET', `/projects/${created.body.project.projectId}`)).body.deployments[0];
  assert.equal(latest.trigger, 'push');
  assert.equal(latest.message, 'Fix typo');
});

test('copy into the user’s GitHub pushes the source there; fork uses GitHub’s fork', async () => {
  assert.equal((await call(ADA, 'POST', '/projects', { name: 'copied', source: { url: 'https://bitbucket.org/team/site' }, mode: 'copy' })).status, 400, 'needs GitHub');
  await connectGithub();
  const copy = await call(ADA, 'POST', '/projects', { name: 'copied', source: { url: 'https://bitbucket.org/team/site/src/master' }, mode: 'copy', copy: { name: 'my-site', private: true } });
  assert.equal(copy.status, 201);
  assert.deepEqual(githubCalls.find(([, path]) => path === '/user/repos')[2], { name: 'my-site', private: true, description: 'Copied from https://bitbucket.org/team/site with Lyrcloud', auto_init: false });
  const vars = Object.fromEntries([...builds.values()][0].environment.environmentVariables.map(({ name, value }) => [name, value]));
  assert.equal(vars.LYR_SOURCE_URL, 'https://bitbucket.org/team/site.git');
  assert.equal(vars.LYR_BRANCH, 'master');
  assert.equal(vars.LYR_PUSH_URL, 'https://x-access-token:ghs_install@github.com/ada/my-site.git');
  assert.equal(vars.LYR_PUSH_BRANCH, 'master');
  assert.equal(copy.body.project.github.fullName, 'ada/my-site');
  assert.equal((await signedPush({ ref: 'refs/heads/master', after: 'x', repository: { id: 2 } })).body.started.length, 0, 'the copy’s own push doesn’t build twice');

  assert.equal((await call(ADA, 'POST', '/projects', { name: 'forked', source: { url: 'https://gitlab.com/a/b' }, mode: 'fork' })).status, 400, 'only GitHub forks');
  const fork = await call(ADA, 'POST', '/projects', { name: 'forked', source: { url: 'https://github.com/vercel/next-site' }, mode: 'fork' });
  assert.equal(fork.status, 201);
  assert.equal(fork.body.project.github.fullName, 'ada/next-site');
  assert.equal(fork.body.project.github.branch, 'canary');
});

test('staff can disable a project, which takes it offline; owners delete their projects', async () => {
  const { body } = await call(ADA, 'POST', '/projects', { name: 'shady', source: { url: 'https://github.com/a/b' } });
  await finishBuild([...builds.keys()][0], { 'index.html': 1 });
  assert.equal(routes.has('shady'), true);
  assert.equal((await call(ADA, 'GET', '/admin/projects')).status, 403);
  assert.equal((await call(STAFF, 'GET', '/admin/projects')).body.projects[0].ownerEmail, 'ada@example.com');
  assert.equal((await call(STAFF, 'PUT', `/admin/projects/${body.project.projectId}`, { disabled: true })).body.project.status, 'disabled');
  assert.equal(routes.has('shady'), false);
  assert.equal((await call(ADA, 'POST', `/projects/${body.project.projectId}/deployments`)).status, 403);
  await call(STAFF, 'PUT', `/admin/projects/${body.project.projectId}`, { disabled: false });
  assert.equal(routes.has('shady'), true);

  assert.equal((await call(BOB, 'DELETE', `/projects/${body.project.projectId}`)).status, 404);
  assert.equal((await call(ADA, 'DELETE', `/projects/${body.project.projectId}`)).status, 200);
  assert.equal(routes.has('shady'), false);
  assert.equal([...objects.keys()].some((k) => k.includes(body.project.projectId)), false);
  assert.equal((await call(BOB, 'POST', '/projects', { name: 'shady', source: { url: 'https://github.com/a/b' } })).status, 201, 'the name is free again');
});
