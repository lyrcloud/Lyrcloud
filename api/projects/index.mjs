// Lyrcloud Projects API: import a repository from GitHub, GitLab, Bitbucket or any public git URL,
// optionally copy or fork it into the user's GitHub, build it on CodeBuild and serve it live at
// <name>.lyrcloud.app. Pushes to the linked GitHub repository redeploy automatically.
//
//   GET    /projects                                   your projects, plan limits, GitHub connection
//   POST   /projects                                   { name, source: { url } | { repo }, mode, copy?, settings? }
//   GET    /projects/{id}                              a project and its deployments
//   PUT    /projects/{id}                              { settings } build settings
//   DELETE /projects/{id}                              take the site down and delete the project
//   POST   /projects/{id}/deployments                  deploy the latest commit again
//   POST   /projects/{id}/deployments/{d}/promote      make an earlier deployment live (rollback)
//   GET    /projects/{id}/deployments/{d}/log          the build log
//   POST   /projects/github/connect                    the GitHub App install link
//   GET    /projects/github/repos                      repositories the app can reach
//   DELETE /projects/github                            forget the GitHub connection
//   GET    /admin/projects, PUT /admin/projects/{id}   every project; { disabled } (staff)
//   GET    /admin/github-app                           whether the GitHub App exists (staff)
//   POST   /admin/github-app/manifest                  { name } start creating it (super admin)
//   GET    /public/github-app/created                  GitHub's redirect after the app is created
//   GET    /public/github/callback                     GitHub's redirect after a user installs the app
//   POST   /public/github/webhook                      push events → redeploy
//
// The same function receives CodeBuild state changes from EventBridge and publishes finished builds.
import './sigv4a.mjs';
import { CloudFrontKeyValueStoreClient, DeleteKeyCommand, DescribeKeyValueStoreCommand, PutKeyCommand } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isStaff, planFor, roleFor } from '../account/roles.mjs';
import { buildspec } from './buildspec.mjs';
import {
  appManifest,
  convertManifest,
  github,
  GitHubError,
  installation,
  installationToken,
  installUrl,
  readState,
  seal,
  signState,
  tokenCloneUrl,
  unseal,
  userToken,
  validWebhookSignature,
} from './github.mjs';
import {
  BUILD_TIMEOUT_MINUTES,
  cacheControlFor,
  cleanSettings,
  cleanUrlCopies,
  contentTypeFor,
  KEEP_DEPLOYMENTS,
  limitsFor,
  MAX_SITE_BYTES,
  MAX_SITE_FILES,
  newId,
  parseGitUrl,
  projectNameError,
  repoNameError,
  routeValue,
  settingsError,
  siteMode,
  SITES_DOMAIN_DEFAULT,
} from './rules.mjs';

const env = process.env;
const TABLE = env.TABLE_NAME;
const USERS_TABLE = env.USERS_TABLE_NAME;
const SITES_BUCKET = env.SITES_BUCKET;
const ARTIFACTS_BUCKET = env.ARTIFACTS_BUCKET;
const BUILDER = env.BUILDER_PROJECT;
const KVS_ARN = env.KVS_ARN;
const DOMAIN = env.SITES_DOMAIN || SITES_DOMAIN_DEFAULT;
const SUPER_ADMIN_EMAIL = env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com';
const DASH_URL = env.DASH_URL || 'https://www.lyrcloud.com/dash/';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const codebuild = new CodeBuildClient({});
const logs = new CloudWatchLogsClient({});
const secrets = new SecretsManagerClient({});
const kvs = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });

// ---------------------------------------------------------------- helpers

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const error = (statusCode, message) => json(statusCode, { error: message });
const redirect = (location) => ({ statusCode: 302, headers: { location, 'cache-control': 'no-store' }, body: '' });
const html = (statusCode, title, message) => ({
  statusCode,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5"><h1>${title}</h1><p>${message}</p><p><a href="${DASH_URL}#/projects">Back to Lyrcloud</a></p></body>`,
});

function rawBody(event) {
  return event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
}

function parseJson(event) {
  try {
    return JSON.parse(rawBody(event) || '{}');
  } catch {
    return null;
  }
}

const apiBase = (event) => `https://${event.requestContext.domainName}`;
const now = () => new Date().toISOString();
const projectKey = (projectId) => ({ pk: `project#${projectId}`, sk: 'project' });
const getItem = async (key) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: key }))).Item;
const getProject = (projectId) => getItem(projectKey(projectId));

async function update(key, set, remove = []) {
  const names = {};
  const values = {};
  const parts = Object.entries(set).map(([field, value], i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = value;
    return `#f${i} = :v${i}`;
  });
  const removes = remove.map((field, i) => {
    names[`#r${i}`] = field;
    return `#r${i}`;
  });
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: key,
    UpdateExpression: [parts.length ? `SET ${parts.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' '),
    ExpressionAttributeNames: names,
    ...(parts.length ? { ExpressionAttributeValues: values } : {}),
    ReturnValues: 'ALL_NEW',
  }));
  return Attributes;
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

const deploymentsOf = async (projectId) =>
  (await queryAll({ KeyConditionExpression: 'pk = :pk AND begins_with(sk, :d)', ExpressionAttributeValues: { ':pk': `project#${projectId}`, ':d': 'deploy#' } }))
    .sort((a, b) => b.deployId.localeCompare(a.deployId));

const projectsOf = (ownerId) =>
  queryAll({ IndexName: 'byOwner', KeyConditionExpression: 'ownerId = :o', ExpressionAttributeValues: { ':o': ownerId }, ScanIndexForward: false });

// Runs `work` over `items`, `limit` at a time.
async function pool(items, limit, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await work(queue.shift());
  }));
}

// ---------------------------------------------------------------- secrets

let projectsSecret;
async function getProjectsSecret() {
  if (env.PROJECTS_SECRET) return env.PROJECTS_SECRET;
  projectsSecret ??= (await secrets.send(new GetSecretValueCommand({ SecretId: env.PROJECTS_SECRET_NAME }))).SecretString;
  return projectsSecret;
}

// The GitHub App's credentials ({} until the super admin creates the app). Re-read every few minutes.
let githubApp = { value: null, at: 0 };
async function getGithubApp() {
  if (env.GITHUB_APP_JSON) return JSON.parse(env.GITHUB_APP_JSON);
  if (!githubApp.value || Date.now() - githubApp.at > 300_000) {
    const raw = (await secrets.send(new GetSecretValueCommand({ SecretId: env.GITHUB_APP_SECRET_NAME }))).SecretString;
    githubApp = { value: JSON.parse(raw || '{}'), at: Date.now() };
  }
  return githubApp.value;
}
const appReady = (app) => Boolean(app?.id && app?.pem && app?.client_id);

// ---------------------------------------------------------------- callers

async function caller(event) {
  const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!userId) return null;
  const profile = (await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }))).Item || { userId };
  return { userId, profile, role: roleFor(profile, SUPER_ADMIN_EMAIL), plan: planFor(profile), email: profile.email || null };
}

// Counts a build against the owner's daily limit; returns false when the day's builds are used up.
async function allowBuild(ownerId, plan) {
  const day = new Date().toISOString().slice(0, 10);
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `usage#${ownerId}`, sk: day },
    UpdateExpression: 'ADD builds :one SET expiresAt = :exp',
    ExpressionAttributeValues: { ':one': 1, ':exp': Math.floor(Date.now() / 1000) + 3 * 86400 },
    ReturnValues: 'ALL_NEW',
  }));
  return Attributes.builds <= limitsFor(plan).buildsPerDay;
}

// ---------------------------------------------------------------- GitHub connection

const connectionKey = (userId) => ({ pk: `github#${userId}`, sk: 'connection' });

// A current user token for the caller, refreshing it when it has expired.
async function userAccess(userId) {
  const connection = await getItem(connectionKey(userId));
  if (!connection) return null;
  const secret = await getProjectsSecret();
  if (!connection.expiresAt || connection.expiresAt > Date.now() + 60_000) return { connection, token: unseal(secret, connection.token) };
  if (!connection.refreshToken || connection.refreshExpiresAt < Date.now()) return null;
  const fresh = await userToken(await getGithubApp(), { grant_type: 'refresh_token', refresh_token: unseal(secret, connection.refreshToken) });
  await update(connectionKey(userId), {
    token: seal(secret, fresh.token),
    refreshToken: seal(secret, fresh.refreshToken),
    expiresAt: fresh.expiresAt,
    refreshExpiresAt: fresh.refreshExpiresAt,
  });
  return { connection, token: fresh.token };
}

const publicConnection = (connection) =>
  connection ? { connected: true, login: connection.login, repositorySelection: connection.repositorySelection, connectedAt: connection.connectedAt } : { connected: false };

// Repositories the user's installation can reach, newest first.
async function installationRepos(installationId) {
  const token = await installationToken(await getGithubApp(), installationId);
  const repos = [];
  for (let page = 1; page <= 3; page += 1) {
    const data = await github(`/installation/repositories?per_page=100&page=${page}`, { token });
    repos.push(...data.repositories);
    if (data.repositories.length < 100) break;
  }
  return repos
    .map((repo) => ({ id: repo.id, fullName: repo.full_name, private: repo.private, defaultBranch: repo.default_branch, url: repo.html_url, pushedAt: repo.pushed_at }))
    .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)));
}

// When the user picked "only selected repositories", a new copy or fork has to be added to the install.
async function includeInInstallation(access, repoId) {
  if (access.connection.repositorySelection !== 'selected') return;
  await github(`/user/installations/${access.connection.installationId}/repositories/${repoId}`, { token: access.token, method: 'PUT' });
}

async function connectGithub(event) {
  const app = await getGithubApp();
  const query = event.queryStringParameters || {};
  const state = readState(await getProjectsSecret(), query.state);
  if (!state || state.t !== 'install') {
    return html(400, 'Almost there', 'Open your Lyrcloud dashboard and choose “Connect GitHub” to finish linking your account.');
  }
  if (!query.code) return redirect(`${DASH_URL}#/projects?github=cancelled`);
  const access = await userToken(app, { code: query.code });
  const user = await github('/user', { token: access.token });
  const { installations } = await github('/user/installations', { token: access.token });
  const chosen = installations.find((item) => String(item.id) === String(query.installation_id)) || installations[0];
  if (!chosen) return html(400, 'GitHub isn’t connected', 'The Lyrcloud app isn’t installed on your GitHub account yet. Try “Connect GitHub” again.');
  const secret = await getProjectsSecret();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...connectionKey(state.u),
      userId: state.u,
      login: user.login,
      githubUserId: user.id,
      installationId: chosen.id,
      repositorySelection: chosen.repository_selection,
      token: seal(secret, access.token),
      refreshToken: seal(secret, access.refreshToken),
      expiresAt: access.expiresAt,
      refreshExpiresAt: access.refreshExpiresAt,
      connectedAt: now(),
    },
  }));
  return redirect(`${DASH_URL}#/projects?github=connected`);
}

// ---------------------------------------------------------------- builds

const ENV_FIELDS = { branch: 'LYR_BRANCH', rootDir: 'LYR_ROOT_DIR', installCommand: 'LYR_INSTALL_COMMAND', buildCommand: 'LYR_BUILD_COMMAND', outputDir: 'LYR_OUTPUT_DIR' };

// Queues a build of `project`. `copy` pushes the source to the user's new repository first.
async function startDeployment(project, { trigger, copy, commit, message } = {}) {
  const deployId = newId();
  let sourceUrl = project.source.cloneUrl;
  const settings = { ...project.settings };
  if (copy) {
    // The first build of a copy clones the original repository's branch and pushes it.
    if (copy.sourceBranch) settings.branch = copy.sourceBranch;
    else delete settings.branch;
  } else if (project.github) {
    sourceUrl = tokenCloneUrl(await installationToken(await getGithubApp(), project.github.installationId), project.github.fullName);
    settings.branch ||= project.github.branch;
  }
  const variables = {
    LYR_PROJECT_ID: project.projectId,
    LYR_DEPLOY_ID: deployId,
    LYR_SOURCE_URL: sourceUrl,
    ...Object.fromEntries(Object.entries(ENV_FIELDS).filter(([field]) => settings[field]).map(([field, name]) => [name, settings[field]])),
    ...(copy ? { LYR_PUSH_URL: copy.pushUrl, LYR_PUSH_BRANCH: copy.branch } : {}),
  };
  const deployment = {
    pk: `project#${project.projectId}`,
    sk: `deploy#${deployId}`,
    deployId,
    projectId: project.projectId,
    status: 'queued',
    trigger,
    branch: settings.branch || null,
    commit: commit || null,
    message: message || null,
    createdAt: now(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: deployment }));
  try {
    const { build } = await codebuild.send(new StartBuildCommand({
      projectName: BUILDER,
      buildspecOverride: buildspec(),
      timeoutInMinutesOverride: BUILD_TIMEOUT_MINUTES,
      environmentVariablesOverride: Object.entries(variables).map(([name, value]) => ({ name, value: String(value), type: 'PLAINTEXT' })),
      artifactsOverride: { type: 'S3', location: ARTIFACTS_BUCKET, path: 'builds', name: deployId, namespaceType: 'NONE', packaging: 'NONE' },
    }));
    deployment.buildId = build.id;
    await update({ pk: deployment.pk, sk: deployment.sk }, { buildId: build.id });
  } catch (err) {
    console.error('StartBuild failed', err);
    await update({ pk: deployment.pk, sk: deployment.sk }, { status: 'failed', error: 'The build couldn’t start. Try again in a minute.' });
    deployment.status = 'failed';
  }
  await update(projectKey(project.projectId), { lastDeployId: deployId, lastDeployAt: deployment.createdAt });
  return deployment;
}

// ---------------------------------------------------------------- publishing (EventBridge)

async function listKeys(Bucket, Prefix) {
  const objects = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    objects.push(...(page.Contents || []));
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return objects;
}

async function deletePrefix(Bucket, Prefix) {
  const objects = await listKeys(Bucket, Prefix);
  for (let i = 0; i < objects.length; i += 1000) {
    await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects.slice(i, i + 1000).map(({ Key }) => ({ Key })), Quiet: true } }));
  }
}

async function setRoute(name, value) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { ETag } = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN }));
      await kvs.send(value === null
        ? new DeleteKeyCommand({ KvsARN: KVS_ARN, Key: name, IfMatch: ETag })
        : new PutKeyCommand({ KvsARN: KVS_ARN, Key: name, Value: value, IfMatch: ETag }));
      return;
    } catch (err) {
      if (value === null && err.name === 'ResourceNotFoundException') return;
      if (attempt >= 4 || !['ConflictException', 'ValidationException'].includes(err.name)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

const liveUrl = (project) => `https://${project.name}.${DOMAIN}`;

async function publish(project, deployment, build) {
  const prefix = `builds/${deployment.deployId}/`;
  const objects = (await listKeys(ARTIFACTS_BUCKET, prefix)).filter((object) => !object.Key.endsWith('/'));
  const bytes = objects.reduce((sum, object) => sum + object.Size, 0);
  const keys = objects.map((object) => object.Key.slice(prefix.length));
  let problem = null;
  if (!keys.includes('index.html')) problem = 'The build didn’t produce an index.html.';
  else if (keys.length > MAX_SITE_FILES) problem = `The site has ${keys.length} files; the limit is ${MAX_SITE_FILES}.`;
  else if (bytes > MAX_SITE_BYTES) problem = `The site is ${Math.round(bytes / 1048576)} MB; the limit is ${MAX_SITE_BYTES / 1048576} MB.`;
  if (problem) {
    await deletePrefix(ARTIFACTS_BUCKET, prefix);
    return finishDeployment(project, deployment, { status: 'failed', error: problem }, build);
  }

  const mode = siteMode(keys);
  const target = `sites/${project.projectId}/${deployment.deployId}/`;
  const copies = [...keys.map((key) => [key, key]), ...(mode === 'static' ? cleanUrlCopies(keys) : [])];
  await pool(copies, 16, ([from, to]) => s3.send(new CopyObjectCommand({
    Bucket: SITES_BUCKET,
    Key: `${target}${to}`,
    CopySource: `${ARTIFACTS_BUCKET}/${(prefix + from).split('/').map(encodeURIComponent).join('/')}`,
    MetadataDirective: 'REPLACE',
    ContentType: contentTypeFor(to),
    CacheControl: cacheControlFor(to),
  })));
  await deletePrefix(ARTIFACTS_BUCKET, prefix);

  // A slower, older build finishing late doesn't replace a newer live one.
  const fresh = await getProject(project.projectId);
  const promote = fresh && !fresh.disabled && (!fresh.liveDeployId || deployment.deployId > fresh.liveDeployId || fresh.liveDeployId === fresh.rolledBackFrom);
  if (promote) {
    await setRoute(fresh.name, routeValue(project.projectId, deployment.deployId, mode));
    if (fresh.liveDeployId) await update({ pk: `project#${project.projectId}`, sk: `deploy#${fresh.liveDeployId}` }, { status: 'ready' }).catch(() => {});
    await update(projectKey(project.projectId), { liveDeployId: deployment.deployId, liveAt: now(), status: 'live' }, ['rolledBackFrom']);
  }
  await finishDeployment(project, deployment, { status: promote ? 'live' : 'ready', files: keys.length, bytes, mode, publishedAt: now() }, build);
  await prune(project.projectId);
}

async function finishDeployment(project, deployment, result, build) {
  const exported = Object.fromEntries((build?.exportedEnvironmentVariables || []).map(({ name, value }) => [name, value]));
  await update({ pk: `project#${project.projectId}`, sk: `deploy#${deployment.deployId}` }, {
    ...result,
    commit: deployment.commit || exported.LYR_COMMIT || null,
    message: deployment.message || exported.LYR_COMMIT_MESSAGE || null,
    framework: exported.LYR_FRAMEWORK || null,
    finishedAt: now(),
  });
  if (deployment.trigger === 'copy' || project.copyPending) await update(projectKey(project.projectId), {}, ['copyPending']);
  if (result.status === 'failed' && !project.liveDeployId) await update(projectKey(project.projectId), { status: 'failed' });
}

// Keeps the live deployment and the newest few others; deletes older files and old failed rows.
async function prune(projectId) {
  const project = await getProject(projectId);
  const deployments = await deploymentsOf(projectId);
  const ready = deployments.filter((item) => item.status === 'ready' && item.deployId !== project?.liveDeployId);
  for (const old of ready.slice(KEEP_DEPLOYMENTS)) {
    await deletePrefix(SITES_BUCKET, `sites/${projectId}/${old.deployId}/`);
    await update({ pk: old.pk, sk: old.sk }, { status: 'expired' });
  }
  for (const old of deployments.slice(30).filter((item) => item.deployId !== project?.liveDeployId)) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: old.pk, sk: old.sk } }));
  }
}

const FAILED_STATES = { FAILED: 'The build failed. Open the log to see why.', FAULT: 'The build service hit an error. Try again.', STOPPED: 'The build was stopped.', TIMED_OUT: `The build took longer than ${BUILD_TIMEOUT_MINUTES} minutes.` };

async function onBuildEvent(event) {
  const detail = event.detail || {};
  const variables = Object.fromEntries((detail['additional-information']?.environment?.['environment-variables'] || []).map((item) => [item.name, item.value]));
  let { LYR_PROJECT_ID: projectId, LYR_DEPLOY_ID: deployId } = variables;
  let build = null;
  const status = detail['build-status'];
  if (!projectId || !deployId || status === 'SUCCEEDED' || FAILED_STATES[status]) {
    build = (await codebuild.send(new BatchGetBuildsCommand({ ids: [detail['build-id']] }))).builds?.[0];
    const vars = Object.fromEntries((build?.environment?.environmentVariables || []).map((item) => [item.name, item.value]));
    projectId ||= vars.LYR_PROJECT_ID;
    deployId ||= vars.LYR_DEPLOY_ID;
  }
  if (!projectId || !deployId) return;
  const project = await getProject(projectId);
  const deployment = await getItem({ pk: `project#${projectId}`, sk: `deploy#${deployId}` });
  if (!project || !deployment) {
    if (deployId) await deletePrefix(ARTIFACTS_BUCKET, `builds/${deployId}/`);
    return;
  }
  if (status === 'IN_PROGRESS') {
    await update({ pk: deployment.pk, sk: deployment.sk }, { status: 'building', startedAt: now() });
    if (!project.liveDeployId) await update(projectKey(projectId), { status: 'building' });
  } else if (status === 'SUCCEEDED') {
    await publish(project, deployment, build);
  } else if (FAILED_STATES[status]) {
    await finishDeployment(project, deployment, { status: 'failed', error: FAILED_STATES[status] }, build);
    await deletePrefix(ARTIFACTS_BUCKET, `builds/${deployId}/`);
  }
}

// ---------------------------------------------------------------- views

const publicDeployment = (item) => ({
  deployId: item.deployId,
  status: item.status,
  trigger: item.trigger,
  branch: item.branch,
  commit: item.commit,
  message: item.message,
  framework: item.framework || null,
  files: item.files ?? null,
  bytes: item.bytes ?? null,
  error: item.error || null,
  createdAt: item.createdAt,
  finishedAt: item.finishedAt || null,
});

const publicProject = (item) => ({
  projectId: item.projectId,
  name: item.name,
  url: liveUrl(item),
  status: item.disabled ? 'disabled' : item.status,
  disabled: item.disabled === true,
  source: item.source ? { url: item.source.webUrl, provider: item.source.provider } : null,
  github: item.github ? { fullName: item.github.fullName, url: `https://github.com/${item.github.fullName}`, branch: item.github.branch, mode: item.github.mode } : null,
  settings: item.settings || {},
  liveDeployId: item.liveDeployId || null,
  lastDeployAt: item.lastDeployAt || null,
  createdAt: item.createdAt,
});

// ---------------------------------------------------------------- project routes

async function createProject(event, who) {
  const body = parseJson(event);
  if (!body) return error(400, 'Invalid JSON body.');
  const name = String(body.name || '').trim().toLowerCase();
  const nameProblem = projectNameError(name);
  if (nameProblem) return error(400, nameProblem);
  const settings = cleanSettings(body.settings);
  const settingsProblem = settingsError(settings);
  if (settingsProblem) return error(400, settingsProblem);
  const mode = body.mode || 'deploy';
  if (!['deploy', 'copy', 'fork'].includes(mode)) return error(400, 'Mode must be deploy, copy or fork.');

  const owned = await projectsOf(who.userId);
  if (owned.length >= limitsFor(who.plan).projects) return error(403, `Your plan allows ${limitsFor(who.plan).projects} projects. Delete one or upgrade.`);

  // Work out the source before claiming the name, so a bad URL doesn't use it up.
  const project = { projectId: newId(), name, ownerId: who.userId, ownerEmail: who.email, settings, status: 'queued', createdAt: now() };
  let copy = null;
  let access = null;
  if (body.source?.repo) {
    access = await userAccess(who.userId);
    if (!access) return error(400, 'Connect GitHub first.');
    const repo = (await installationRepos(access.connection.installationId)).find((item) => item.fullName === body.source.repo);
    if (!repo) return error(404, 'The Lyrcloud app can’t see that repository. Give it access on GitHub and try again.');
    project.github = { repoId: repo.id, fullName: repo.fullName, branch: settings.branch || repo.defaultBranch, installationId: access.connection.installationId, mode: 'linked' };
    project.source = { cloneUrl: `https://github.com/${repo.fullName}.git`, webUrl: repo.url, provider: 'github' };
  } else {
    const parsed = parseGitUrl(body.source?.url);
    if (!parsed) return error(400, 'Enter a public https git URL, like https://github.com/owner/repo.');
    project.source = { cloneUrl: parsed.cloneUrl, webUrl: parsed.webUrl, provider: parsed.provider };
    settings.branch ||= parsed.branch;
    if (mode !== 'deploy') {
      access = await userAccess(who.userId);
      if (!access) return error(400, 'Connect GitHub to copy or fork the project into your account.');
      if (mode === 'fork' && parsed.provider !== 'github') return error(400, 'Only GitHub repositories can be forked. Choose “Copy” instead.');
      const repoName = String(body.copy?.name || name).trim();
      const repoProblem = repoNameError(repoName);
      if (repoProblem) return error(400, repoProblem);
      try {
        if (mode === 'fork') {
          const fork = await github(`/repos/${parsed.owner}/${parsed.repo}/forks`, {
            token: access.token,
            method: 'POST',
            body: { name: repoName, default_branch_only: true },
          });
          await includeInInstallation(access, fork.id);
          project.github = { repoId: fork.id, fullName: fork.full_name, branch: settings.branch || fork.default_branch, installationId: access.connection.installationId, mode: 'fork' };
        } else {
          const created = await github('/user/repos', {
            token: access.token,
            method: 'POST',
            body: { name: repoName, private: body.copy?.private !== false, description: `Copied from ${parsed.webUrl} with Lyrcloud`, auto_init: false },
          });
          await includeInInstallation(access, created.id);
          const branch = settings.branch || 'main';
          project.github = { repoId: created.id, fullName: created.full_name, branch, installationId: access.connection.installationId, mode: 'copy' };
          copy = {
            pushUrl: tokenCloneUrl(await installationToken(await getGithubApp(), access.connection.installationId), created.full_name),
            branch,
            sourceBranch: settings.branch || null,
          };
          project.copyPending = true;
        }
      } catch (err) {
        if (err instanceof GitHubError) {
          const taken = err.status === 422 ? ` A repository named “${repoName}” may already exist in your account.` : '';
          return error(err.status === 422 ? 409 : 502, `GitHub said: ${err.message}.${taken}`);
        }
        throw err;
      }
      // Later builds clone the user's own repository.
      project.settings = { ...settings, branch: project.github.branch };
    }
  }
  if (project.github) project.repoKey = `github#${project.github.repoId}`;

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: `name#${name}`, sk: 'name', projectId: project.projectId, ownerId: who.userId },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return error(409, `${name}.${DOMAIN} is taken. Pick another name.`);
    throw err;
  }
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...projectKey(project.projectId), ...project } }));

  if (!(await allowBuild(who.userId, who.plan))) return json(201, { project: publicProject(project), warning: 'You’ve used today’s builds; deploy it tomorrow.' });
  const deployment = await startDeployment(project, { trigger: copy ? 'copy' : 'create', copy });
  return json(201, { project: publicProject(project), deployment: publicDeployment(deployment) });
}

async function deleteProject(project) {
  await setRoute(project.name, null);
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `name#${project.name}`, sk: 'name' } }));
  for (const item of await deploymentsOf(project.projectId)) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: item.pk, sk: item.sk } }));
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: projectKey(project.projectId) }));
  await deletePrefix(SITES_BUCKET, `sites/${project.projectId}/`);
}

const TOKEN_RE = /(https:\/\/)[^@\s/]+@/g;

async function buildLog(deployment) {
  if (!deployment.buildId) return '';
  const build = (await codebuild.send(new BatchGetBuildsCommand({ ids: [deployment.buildId] }))).builds?.[0];
  if (!build?.logs?.groupName || !build.logs.streamName) return 'The log isn’t available yet. It appears once the build starts.';
  const { events } = await logs.send(new GetLogEventsCommand({ logGroupName: build.logs.groupName, logStreamName: build.logs.streamName, startFromHead: false, limit: 500 }));
  return events.map((item) => item.message.replace(TOKEN_RE, '$1').replace(/\u001b\[[0-9;]*m/g, '')).join('').slice(-60_000);
}

async function projectRoutes(event, method, path, who) {
  if (path === '/projects/github/connect' && method === 'POST') {
    const app = await getGithubApp();
    if (!appReady(app)) return error(503, 'GitHub connections aren’t set up yet.');
    return json(200, { installUrl: installUrl(app, signState(await getProjectsSecret(), { u: who.userId, t: 'install' })) });
  }
  if (path === '/projects/github/repos' && method === 'GET') {
    const connection = await getItem(connectionKey(who.userId));
    if (!connection) return error(400, 'Connect GitHub first.');
    return json(200, { repos: await installationRepos(connection.installationId) });
  }
  if (path === '/projects/github' && method === 'DELETE') {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: connectionKey(who.userId) }));
    return json(200, { connected: false });
  }

  if (path === '/projects') {
    if (method === 'GET') {
      const [owned, connection, app] = [await projectsOf(who.userId), await getItem(connectionKey(who.userId)), await getGithubApp()];
      return json(200, {
        projects: owned.map(publicProject),
        limits: { ...limitsFor(who.plan), plan: who.plan, used: owned.length },
        github: { ...publicConnection(connection), available: appReady(app) },
        domain: DOMAIN,
      });
    }
    if (method === 'POST') return createProject(event, who);
  }

  const match = path.match(/^\/projects\/([a-z0-9]+)(?:\/deployments(?:\/([a-z0-9]+)\/(promote|log))?)?$/);
  if (!match) return error(404, 'not_found');
  const project = await getProject(match[1]);
  if (!project || (project.ownerId !== who.userId && !isStaff(who.role))) return error(404, 'No such project.');
  const isDeployments = path.includes('/deployments');

  if (!isDeployments) {
    if (method === 'GET') return json(200, { project: publicProject(project), deployments: (await deploymentsOf(project.projectId)).map(publicDeployment) });
    if (method === 'PUT') {
      const body = parseJson(event);
      const settings = cleanSettings(body?.settings);
      const problem = !body ? 'Invalid JSON body.' : settingsError(settings);
      if (problem) return error(400, problem);
      const saved = await update(projectKey(project.projectId), { settings: { ...project.settings, ...settings } });
      if (project.github && settings.branch) await update(projectKey(project.projectId), { github: { ...project.github, branch: settings.branch } });
      return json(200, { project: publicProject(saved) });
    }
    if (method === 'DELETE') {
      if (project.ownerId !== who.userId && who.role !== 'superadmin') return error(403, 'Only the owner can delete this project.');
      await deleteProject(project);
      return json(200, { deleted: project.projectId });
    }
    return error(404, 'not_found');
  }

  if (project.disabled) return error(403, 'This project has been disabled by Lyrcloud.');
  const [, , deployId, action] = match;
  if (!deployId && method === 'POST') {
    if (!(await allowBuild(project.ownerId, who.plan))) return error(429, `You’ve used today’s ${limitsFor(who.plan).buildsPerDay} builds. Try again tomorrow.`);
    return json(201, { deployment: publicDeployment(await startDeployment(project, { trigger: 'manual' })) });
  }
  const deployment = deployId && (await getItem({ pk: `project#${project.projectId}`, sk: `deploy#${deployId}` }));
  if (!deployment) return error(404, 'No such deployment.');
  if (action === 'log' && method === 'GET') return json(200, { log: await buildLog(deployment) });
  if (action === 'promote' && method === 'POST') {
    if (!['ready', 'live'].includes(deployment.status)) return error(400, 'Only a finished deployment whose files are still kept can go live.');
    await setRoute(project.name, routeValue(project.projectId, deployment.deployId, deployment.mode));
    if (project.liveDeployId && project.liveDeployId !== deployment.deployId) {
      await update({ pk: deployment.pk, sk: `deploy#${project.liveDeployId}` }, { status: 'ready' }).catch(() => {});
    }
    await update({ pk: deployment.pk, sk: deployment.sk }, { status: 'live' });
    // Marks a rollback, so the next build still goes live even though older ones are kept.
    const saved = await update(projectKey(project.projectId), { liveDeployId: deployment.deployId, liveAt: now(), status: 'live', rolledBackFrom: deployment.deployId });
    return json(200, { project: publicProject(saved) });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- admin routes

async function adminRoutes(event, method, path, who) {
  if (!isStaff(who.role)) return error(403, 'Admins only.');
  if (path === '/admin/github-app' && method === 'GET') {
    const app = await getGithubApp();
    return json(200, { configured: appReady(app), name: app.name || null, url: app.html_url || null });
  }
  if (path === '/admin/github-app/manifest' && method === 'POST') {
    if (who.role !== 'superadmin') return error(403, 'Only the super admin can create the GitHub App.');
    const body = parseJson(event) || {};
    const name = String(body.name || 'Lyrcloud Deploy').trim().slice(0, 34) || 'Lyrcloud Deploy';
    const state = signState(await getProjectsSecret(), { u: who.userId, t: 'manifest' }, 3600);
    return json(200, { action: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(appManifest({ name, apiBase: apiBase(event) })) });
  }
  if (path === '/admin/projects' && method === 'GET') {
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(new ScanCommand({ TableName: TABLE, FilterExpression: 'sk = :p', ExpressionAttributeValues: { ':p': 'project' }, ExclusiveStartKey }));
      items.push(...page.Items);
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return json(200, { projects: items.map((item) => ({ ...publicProject(item), ownerEmail: item.ownerEmail || null })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }
  const match = path.match(/^\/admin\/projects\/([a-z0-9]+)$/);
  if (match && method === 'PUT') {
    const project = await getProject(match[1]);
    if (!project) return error(404, 'No such project.');
    const body = parseJson(event);
    if (typeof body?.disabled !== 'boolean') return error(400, 'Send { "disabled": true | false }.');
    if (body.disabled) await setRoute(project.name, null);
    else if (project.liveDeployId) {
      const live = await getItem({ pk: `project#${project.projectId}`, sk: `deploy#${project.liveDeployId}` });
      await setRoute(project.name, routeValue(project.projectId, project.liveDeployId, live?.mode));
    }
    const saved = await update(projectKey(project.projectId), { disabled: body.disabled, disabledBy: who.userId, disabledAt: now() });
    return json(200, { project: { ...publicProject(saved), ownerEmail: saved.ownerEmail || null } });
  }
  return error(404, 'not_found');
}

// ---------------------------------------------------------------- public routes

async function appCreated(event) {
  const query = event.queryStringParameters || {};
  const state = readState(await getProjectsSecret(), query.state);
  if (!state || state.t !== 'manifest' || !query.code) return html(400, 'That link has expired', 'Start creating the GitHub App again from the admin console.');
  const app = await convertManifest(query.code);
  const stored = {
    id: app.id, slug: app.slug, name: app.name, html_url: app.html_url, client_id: app.client_id,
    client_secret: app.client_secret, webhook_secret: app.webhook_secret, pem: app.pem, createdAt: now(),
  };
  await secrets.send(new PutSecretValueCommand({ SecretId: env.GITHUB_APP_SECRET_NAME, SecretString: JSON.stringify(stored) }));
  githubApp = { value: stored, at: Date.now() };
  return redirect(`${DASH_URL}#/admin?tab=settings&github-app=created`);
}

async function webhook(event) {
  const app = await getGithubApp();
  const body = rawBody(event);
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  if (!validWebhookSignature(app.webhook_secret, body, headers['x-hub-signature-256'])) return error(401, 'Bad signature.');
  const kind = headers['x-github-event'];
  const payload = JSON.parse(body);
  if (kind !== 'push') return json(200, { ignored: kind });
  if (payload.deleted || !payload.ref?.startsWith('refs/heads/')) return json(200, { ignored: 'not a branch push' });
  const branch = payload.ref.slice('refs/heads/'.length);
  const projects = await queryAll({ IndexName: 'byRepo', KeyConditionExpression: 'repoKey = :r', ExpressionAttributeValues: { ':r': `github#${payload.repository.id}` } });
  const started = [];
  for (const project of projects) {
    // A copy's first push comes from our own build, which deploys it already.
    if (project.disabled || project.copyPending || (project.github?.branch || project.settings?.branch) !== branch) continue;
    const owner = (await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: project.ownerId } }))).Item;
    if (!(await allowBuild(project.ownerId, planFor(owner)))) continue;
    const deployment = await startDeployment(project, { trigger: 'push', commit: payload.after, message: payload.head_commit?.message?.split('\n')[0]?.slice(0, 200) });
    started.push(deployment.deployId);
  }
  return json(200, { started });
}

// ---------------------------------------------------------------- entry

export const handler = async (event) => {
  if (event.source === 'aws.codebuild') return onBuildEvent(event);

  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  try {
    if (path === '/public/github/webhook' && method === 'POST') return await webhook(event);
    if (path === '/public/github/callback' && method === 'GET') return await connectGithub(event);
    if (path === '/public/github-app/created' && method === 'GET') return await appCreated(event);

    const who = await caller(event);
    if (!who) return error(401, 'unauthorized');
    if (who.profile.disabled === true && who.role !== 'superadmin') return error(403, 'This account has been disabled.');
    if (path.startsWith('/admin/')) return await adminRoutes(event, method, path, who);
    if (path === '/projects' || path.startsWith('/projects/')) return await projectRoutes(event, method, path, who);
    return error(404, 'not_found');
  } catch (err) {
    console.error('Projects API failed', err);
    if (err instanceof GitHubError) return error(502, `GitHub said: ${err.message}`);
    return error(500, 'Something went wrong. Please try again.');
  }
};
