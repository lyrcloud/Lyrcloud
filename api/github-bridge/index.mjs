// GitHub → OpenID Connect bridge for Cognito. GitHub speaks OAuth 2 but not OIDC (no id_token, no
// discovery), so this Lambda presents GitHub to the Cognito user pool as an OIDC provider:
//
//   GET  /.well-known/openid-configuration   discovery document
//   GET  /authorize    Cognito → here → GitHub's consent page (callback: this bridge's /callback)
//   GET  /callback     GitHub → here → Cognito's /oauth2/idpresponse, with the OIDC nonce folded into the code
//   POST /token        Cognito swaps the code: GitHub access token + an RS256 id_token signed here
//   GET  /userinfo     the GitHub profile as OIDC claims (Bearer = the GitHub access token)
//   GET  /jwks.json    the public key Cognito checks id_tokens with
//
// The bridge stores nothing. Cognito sends the GitHub OAuth app's client ID and secret with each /token
// call (they're configured on the GitHubBridge identity provider), and the RSA signing key lives in
// Secrets Manager. The GitHub OAuth app's "Authorization callback URL" must be <bridge URL>/callback.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const KEY_SECRET_NAME = process.env.KEY_SECRET_NAME;
// Where /callback may send people: the user pool's IdP response URL. Nothing else is accepted.
const COGNITO_REDIRECT_URI = process.env.COGNITO_REDIRECT_URI;
const GITHUB = process.env.GITHUB_BASE_URL || 'https://github.com';
const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const USER_AGENT = 'lyrcloud-github-bridge';

let signingKey;
async function getSigningKey() {
  if (signingKey) return signingKey;
  const pem = process.env.SIGNING_KEY_PEM
    || (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: KEY_SECRET_NAME }))).SecretString;
  const privateKey = createPrivateKey(pem);
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = createHash('sha256').update(jwk.n).digest('base64url').slice(0, 16);
  signingKey = { privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
  return signingKey;
}

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export async function signIdToken(claims) {
  const { privateKey, jwk } = await getSigningKey();
  const input = `${b64url({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })}.${b64url(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  body: JSON.stringify(body),
});
const redirect = (location) => ({ statusCode: 302, headers: { location, 'cache-control': 'no-store' }, body: '' });
const oauthError = (statusCode, error, description) => json(statusCode, { error, error_description: description });

function formBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  return Object.fromEntries(new URLSearchParams(raw));
}

// Cognito may send the client credentials in the body (client_secret_post) or as Basic auth.
function clientCredentials(event, body) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  if (/^Basic /i.test(header)) {
    const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    return { clientId: decodeURIComponent(id || ''), clientSecret: decodeURIComponent(secret || '') };
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

async function github(path, token) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub ${path} failed: ${res.status}`), { status: res.status });
  return res.json();
}

// The GitHub account as OIDC claims. Uses the primary verified email, even when it's private.
export async function githubClaims(token) {
  const user = await github('/user', token);
  let email = null;
  let emailVerified = false;
  try {
    const emails = await github('/user/emails', token);
    const primary = emails.find((item) => item.primary && item.verified) || emails.find((item) => item.verified);
    if (primary) [email, emailVerified] = [primary.email, true];
  } catch {
    // Without the user:email scope only the public email is available, and it may be unverified.
  }
  email ??= user.email || null;
  return {
    sub: String(user.id),
    name: user.name || user.login,
    preferred_username: user.login,
    nickname: user.login,
    picture: user.avatar_url || undefined,
    profile: user.html_url || undefined,
    email: email ? email.toLowerCase() : undefined,
    email_verified: emailVerified,
  };
}

// Codes handed to Cognito are "<GitHub code>.<nonce>", so /token can put the nonce in the id_token.
const packCode = (code, nonce) => `${code}.${b64url(nonce || '')}`;
function unpackCode(packed) {
  const at = String(packed || '').lastIndexOf('.');
  if (at <= 0) return { code: packed, nonce: '' };
  return { code: packed.slice(0, at), nonce: Buffer.from(packed.slice(at + 1), 'base64url').toString('utf8') };
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  const issuer = `https://${event.requestContext?.domainName}`;
  const query = event.queryStringParameters || {};

  try {
    if (method === 'GET' && path === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks.json`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        claims_supported: ['sub', 'name', 'preferred_username', 'nickname', 'picture', 'profile', 'email', 'email_verified'],
      }, { 'cache-control': 'public, max-age=3600' });
    }

    if (method === 'GET' && path === '/jwks.json') {
      return json(200, { keys: [(await getSigningKey()).jwk] }, { 'cache-control': 'public, max-age=3600' });
    }

    if (method === 'GET' && path === '/authorize') {
      if (!query.client_id) return oauthError(400, 'invalid_request', 'client_id is required');
      if (query.redirect_uri !== COGNITO_REDIRECT_URI) return oauthError(400, 'invalid_request', 'redirect_uri is not allowed');
      const url = new URL(`${GITHUB}/login/oauth/authorize`);
      url.searchParams.set('client_id', query.client_id);
      url.searchParams.set('redirect_uri', `${issuer}/callback`);
      url.searchParams.set('scope', 'read:user user:email');
      url.searchParams.set('state', b64url({ s: query.state || '', n: query.nonce || '' }));
      url.searchParams.set('allow_signup', 'true');
      return redirect(url.toString());
    }

    if (method === 'GET' && path === '/callback') {
      let wrapped;
      try {
        wrapped = JSON.parse(Buffer.from(query.state || '', 'base64url').toString('utf8'));
      } catch {
        return oauthError(400, 'invalid_request', 'state is missing or damaged');
      }
      const url = new URL(COGNITO_REDIRECT_URI);
      if (wrapped.s) url.searchParams.set('state', wrapped.s);
      if (query.error) {
        url.searchParams.set('error', query.error === 'access_denied' ? 'access_denied' : 'server_error');
        if (query.error_description) url.searchParams.set('error_description', query.error_description);
      } else {
        url.searchParams.set('code', packCode(query.code, wrapped.n));
      }
      return redirect(url.toString());
    }

    if (method === 'POST' && path === '/token') {
      const body = formBody(event);
      const { clientId, clientSecret } = clientCredentials(event, body);
      if (body.grant_type !== 'authorization_code') return oauthError(400, 'unsupported_grant_type', 'Only authorization_code is supported');
      if (!clientId || !clientSecret || !body.code) return oauthError(400, 'invalid_request', 'client credentials and code are required');
      const { code, nonce } = unpackCode(body.code);

      const res = await fetch(`${GITHUB}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${issuer}/callback` }),
      });
      const grant = await res.json().catch(() => ({}));
      if (!res.ok || !grant.access_token) {
        console.error('GitHub token exchange failed', res.status, grant.error, grant.error_description);
        return oauthError(400, 'invalid_grant', grant.error_description || 'GitHub refused the code');
      }

      const claims = await githubClaims(grant.access_token);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await signIdToken({
        iss: issuer,
        aud: clientId,
        iat: now,
        exp: now + 3600,
        ...(nonce ? { nonce } : {}),
        ...claims,
      });
      return json(200, { access_token: grant.access_token, token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile', id_token: idToken });
    }

    if ((method === 'GET' || method === 'POST') && path === '/userinfo') {
      const header = event.headers?.authorization || event.headers?.Authorization || '';
      const token = header.replace(/^Bearer\s+/i, '');
      if (!token) return json(401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
      try {
        return json(200, await githubClaims(token));
      } catch (err) {
        if (err.status === 401) return json(401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
        throw err;
      }
    }

    return json(404, { error: 'not_found' });
  } catch (err) {
    console.error('GitHub bridge failed', err);
    return oauthError(500, 'server_error', 'The GitHub bridge hit an error');
  }
};
