// The Lyrcloud GitHub App: created once by the super admin through GitHub's manifest flow, then
// installed by users on their accounts. The app reads and writes repository contents (to copy
// projects in and deploy them), creates repositories (for copies) and gets push webhooks (to redeploy).
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, randomBytes, sign, timingSafeEqual } from 'node:crypto';

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const WEB = process.env.GITHUB_BASE_URL || 'https://github.com';
const USER_AGENT = 'lyrcloud-projects';

export function appManifest({ name, apiBase }) {
  return {
    name,
    url: 'https://www.lyrcloud.com',
    description: 'Import, copy and deploy your repositories to Lyrcloud. Every push goes live.',
    hook_attributes: { url: `${apiBase}/public/github/webhook`, active: true },
    redirect_url: `${apiBase}/public/github-app/created`,
    callback_urls: [`${apiBase}/public/github/callback`],
    setup_url: `${apiBase}/public/github/callback`,
    setup_on_update: true,
    request_oauth_on_install: true,
    public: true,
    default_permissions: { contents: 'write', metadata: 'read', administration: 'write' },
    default_events: ['push'],
  };
}

// ---------------------------------------------------------------- signed state and sealed tokens

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function same(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

// A short-lived, signed value that comes back to us through GitHub (the "state" parameter).
export function signState(key, payload, ttlSeconds = 900) {
  const body = b64url({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  return `${body}.${createHmac('sha256', key).update(`state:${body}`).digest('base64url')}`;
}

export function readState(key, state) {
  const [body, mac] = String(state || '').split('.');
  if (!body || !mac || !same(mac, createHmac('sha256', key).update(`state:${body}`).digest('base64url'))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return payload.exp >= Math.floor(Date.now() / 1000) ? payload : null;
}

// GitHub user tokens are stored encrypted (AES-256-GCM) with a key derived from the projects secret.
const tokenKey = (secret) => createHash('sha256').update(`github-tokens:${secret}`).digest();

export function seal(secret, text) {
  if (!text) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(secret), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

export function unseal(secret, sealed) {
  if (!sealed) return null;
  const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function validWebhookSignature(webhookSecret, rawBody, header) {
  if (!webhookSecret || !header?.startsWith('sha256=')) return false;
  return same(header, `sha256=${createHmac('sha256', webhookSecret).update(rawBody).digest('hex')}`);
}

// ---------------------------------------------------------------- GitHub API

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function github(path, { token, method = 'GET', body, auth = 'Bearer' } = {}) {
  const res = await fetch(path.startsWith('https://') ? path : `${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': USER_AGENT,
      ...(token ? { authorization: `${auth} ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new GitHubError(res.status, data.message || `GitHub ${method} ${path} failed (${res.status})`);
  return data;
}

// Exchanges the code from the manifest flow for the new app's id, private key and secrets.
export const convertManifest = (code) => github(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });

export function appJwt(app) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat: now - 60, exp: now + 540, iss: String(app.id) })}`;
  return `${input}.${sign('sha256', Buffer.from(input), createPrivateKey(app.pem)).toString('base64url')}`;
}

export async function installationToken(app, installationId) {
  const { token } = await github(`/app/installations/${installationId}/access_tokens`, { token: appJwt(app), method: 'POST' });
  return token;
}

export const installation = (app, installationId) => github(`/app/installations/${installationId}`, { token: appJwt(app) });

// OAuth: the code from the install callback, or a refresh token, for a user access token.
export async function userToken(app, params) {
  const res = await fetch(`${WEB}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new GitHubError(400, data.error_description || 'GitHub didn’t give us access. Try connecting again.');
  const now = Date.now();
  return {
    token: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: data.expires_in ? now + data.expires_in * 1000 : null,
    refreshExpiresAt: data.refresh_token_expires_in ? now + data.refresh_token_expires_in * 1000 : null,
  };
}

export const tokenCloneUrl = (token, fullName) => `https://x-access-token:${token}@github.com/${fullName}.git`;

export const installUrl = (app, state) => `${app.html_url || `${WEB}/apps/${app.slug}`}/installations/new?state=${encodeURIComponent(state)}`;
