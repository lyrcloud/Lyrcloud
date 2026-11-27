// Atlassian for Lyrcloud Projects:
//   Bitbucket  private repositories and deploy-on-push. The customer gives a Bitbucket repository (or workspace)
//              access token with Repositories: Read and Webhooks: Read and write. Lyrcloud clones with it and adds
//              a webhook (with its own secret) that redeploys the project on every push to its branch.
//   Jira       after a deploy goes live, Lyrcloud comments on the Jira issues named in the commit message
//              (ABC-123) with the live address. The customer connects their site with an Atlassian API token.
// Tokens are sealed with the projects secret before they're stored (github.mjs seal/unseal).
import { createHmac, timingSafeEqual } from 'node:crypto';

export class AtlassianError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const BITBUCKET_API = 'https://api.bitbucket.org/2.0';
const ISSUE_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;

// ---------------------------------------------------------------- Bitbucket

export const bitbucketCloneUrl = (token, workspace, repo) => `https://x-token-auth:${encodeURIComponent(token)}@bitbucket.org/${workspace}/${repo}.git`;

async function bitbucket(fetchImpl, token, path, { method = 'GET', body } = {}) {
  const res = await fetchImpl(`${BITBUCKET_API}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new AtlassianError(400, 'Bitbucket refused the token. Use a repository access token with Repositories: Read and Webhooks: Read and write.');
  if (res.status === 404) throw new AtlassianError(404, 'Bitbucket can’t find that repository with this token.');
  if (!res.ok) throw new AtlassianError(502, `Bitbucket said: ${data.error?.message || res.status}`);
  return data;
}

// Checks the token can read the repository and adds the push webhook. Returns the repository's main branch.
export async function connectBitbucket({ fetchImpl = fetch, token, workspace, repo, hookUrl, hookSecret }) {
  const info = await bitbucket(fetchImpl, token, `/repositories/${workspace}/${repo}`);
  await bitbucket(fetchImpl, token, `/repositories/${workspace}/${repo}/hooks`, {
    method: 'POST', body: { description: 'Lyrcloud: deploy on push', url: hookUrl, active: true, events: ['repo:push'], secret: hookSecret },
  });
  return { mainBranch: info.mainbranch?.name || 'main', private: Boolean(info.is_private) };
}

// A Bitbucket webhook delivery: X-Hub-Signature is "sha256=" + HMAC-SHA256 of the body with the hook's secret.
export function validBitbucketSignature(secret, rawBody, header) {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const sent = Buffer.from(String(header || ''));
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}

// The branch pushes in a repo:push payload: [{ branch, commit, message }].
export function bitbucketPushes(payload) {
  return (payload?.push?.changes || [])
    .map((change) => change.new)
    .filter((target) => target?.type === 'branch')
    .map((target) => ({ branch: target.name, commit: target.target?.hash || null, message: String(target.target?.message || '').split('\n')[0].slice(0, 200) }));
}

// ---------------------------------------------------------------- Jira

export function cleanJiraSite(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/.test(host) ? `https://${host}` : null;
}

export const jiraKeys = (message) => [...new Set(String(message || '').match(ISSUE_RE) || [])].slice(0, 5);

const basic = (email, token) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

export async function verifyJira({ fetchImpl = fetch, site, email, token }) {
  const res = await fetchImpl(`${site}/rest/api/3/myself`, { headers: { authorization: basic(email, token), accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) throw new AtlassianError(400, 'Jira refused that email and API token. Make the token at id.atlassian.com → Security → API tokens.');
  if (!res.ok) throw new AtlassianError(502, `Jira answered ${res.status}. Check the site address.`);
  const me = await res.json().catch(() => ({}));
  return { accountName: me.displayName || email };
}

// The comment: "Deployed to <url> by Lyrcloud (commit abc1234)" in Atlassian Document Format.
export function deployComment({ url, projectName, commit }) {
  return {
    body: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: `🚀 ${projectName} is live at ` },
        { type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] },
        { type: 'text', text: ` (Lyrcloud${commit ? `, commit ${String(commit).slice(0, 7)}` : ''}).` },
      ] }],
    },
  };
}

// Comments on each issue named in the commit message; returns the keys it commented on.
export async function notifyJira({ fetchImpl = fetch, site, email, token }, { message, url, projectName, commit }) {
  const done = [];
  for (const key of jiraKeys(message)) {
    const res = await fetchImpl(`${site}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST', headers: { authorization: basic(email, token), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(deployComment({ url, projectName, commit })), signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (res?.ok) done.push(key);
  }
  return done;
}
