// GitHub → OpenID Connect bridge for Cognito (the lyrcloud-github-bridge stack). GitHub speaks OAuth 2
// but not OIDC (no id_token, no discovery), so this Lambda presents GitHub to the user pool as the
// "GitHubBridge" OIDC provider:
//
//   GET  /.well-known/openid-configuration   discovery document
//   GET  /authorize    Cognito → here → GitHub's consent page
//   GET  /callback     GitHub → here: swaps GitHub's code for the profile, then → Cognito's idpresponse
//                      with a 60-second internal code (HS256) carrying the profile and the OIDC nonce
//   POST /token        Cognito swaps the internal code for an RS256 id_token (also used as access token)
//   GET  /userinfo     the claims of that token, which Cognito reads after /token
//   GET  /.well-known/jwks.json   the public key Cognito checks tokens with
//
// Everything secret lives in one Secrets Manager JSON secret (SECRET_ARN): githubClientId and
// githubClientSecret (the GitHub OAuth app, whose callback URL is <bridge>/callback), rsaPrivateKeyPem
// and keyId (token signing), internalCodeHmacSecret, and bridgeClientId/bridgeClientSecret (what
// Cognito authenticates to the bridge with). Nothing is stored per sign-in.
import { createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const SECRET_ARN = process.env.SECRET_ARN;
const BRIDGE_BASE_URL = process.env.BRIDGE_BASE_URL;
// Where /callback may send people: the user pool's IdP response URL. Nothing else is accepted.
const ALLOWED_REDIRECT_URI = process.env.ALLOWED_REDIRECT_URI;
const GITHUB = process.env.GITHUB_BASE_URL || 'https://github.com';
const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const USER_AGENT = 'lyrcloud-github-bridge';
const TOKEN_TTL = 300;
const CODE_TTL = 60;

let cachedSecret;
async function getSecret() {
  if (process.env.BRIDGE_SECRET_JSON) return JSON.parse(process.env.BRIDGE_SECRET_JSON);
  cachedSecret ??= JSON.parse((await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))).SecretString);
  return cachedSecret;
}

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const fromB64url = (text) => JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
const now = () => Math.floor(Date.now() / 1000);

function sameText(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---------------------------------------------------------------- JWTs

export function signRS256(claims, secret) {
  const input = `${b64url({ alg: 'RS256', typ: 'JWT', kid: secret.keyId })}.${b64url(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), createPrivateKey(secret.rsaPrivateKeyPem)).toString('base64url')}`;
}

function verifyRS256(token, secret) {
  const [header, payload, signature] = String(token).split('.');
  if (!signature) throw new Error('malformed');
  const publicKey = createPublicKey(createPrivateKey(secret.rsaPrivateKeyPem));
  if (!verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))) throw new Error('bad signature');
  const claims = fromB64url(payload);
  if (claims.iss !== BRIDGE_BASE_URL || claims.exp < now()) throw new Error('expired or foreign');
  return claims;
}

function signHS256(claims, key) {
  const input = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
}

function verifyHS256(token, key) {
  const [header, payload, signature] = String(token).split('.');
  if (!signature || !sameText(signature, createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url'))) throw new Error('bad signature');
  const claims = fromB64url(payload);
  if (claims.exp < now()) throw new Error('expired');
  return claims;
}

function jwks(secret) {
  const jwk = createPublicKey(createPrivateKey(secret.rsaPrivateKeyPem)).export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: secret.keyId, alg: 'RS256', use: 'sig' }] };
}

// ---------------------------------------------------------------- HTTP

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  body: JSON.stringify(body),
});
const redirect = (location) => ({ statusCode: 302, headers: { location, 'cache-control': 'no-store' }, body: '' });
const oauthError = (statusCode, error, description) => json(statusCode, { error, error_description: description });
const invalidToken = () => json(401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });

function formBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  return Object.fromEntries(new URLSearchParams(raw));
}

// Cognito may send its client credentials in the body (client_secret_post) or as Basic auth.
function clientCredentials(event, body) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  if (/^Basic /i.test(header)) {
    const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    return { clientId: decodeURIComponent(id || ''), clientSecret: decodeURIComponent(secret || '') };
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

// ---------------------------------------------------------------- GitHub

async function github(path, token) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`GitHub ${path} failed: ${res.status}`);
  return res.json();
}

// Swaps GitHub's code for the account's profile. Uses the primary verified email, even a private one.
async function githubProfile(code, secret) {
  const res = await fetch(`${GITHUB}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ client_id: secret.githubClientId, client_secret: secret.githubClientSecret, code, redirect_uri: `${BRIDGE_BASE_URL}/callback` }),
  });
  const grant = await res.json().catch(() => ({}));
  if (!grant.access_token) throw new Error(`GitHub token exchange failed: ${grant.error || res.status}`);

  const user = await github('/user', grant.access_token);
  let email = null;
  let emailVerified = false;
  try {
    const emails = await github('/user/emails', grant.access_token);
    const chosen = emails.find((item) => item.primary && item.verified) || emails.find((item) => item.verified);
    if (chosen) [email, emailVerified] = [chosen.email, true];
  } catch {
    // Without the user:email scope only the public email is available, and it may not be verified.
  }
  email ??= user.email || null;
  return {
    // "github:<id>" as the original bridge did, so existing GitHub accounts keep their identity.
    sub: `github:${user.id}`,
    email: email ? email.toLowerCase() : undefined,
    email_verified: emailVerified,
    name: user.name || user.login,
    preferred_username: user.login,
    picture: user.avatar_url || undefined,
  };
}

const PROFILE_CLAIMS = ['sub', 'email', 'email_verified', 'name', 'preferred_username', 'picture'];
const profileOf = (claims) => Object.fromEntries(PROFILE_CLAIMS.filter((key) => claims[key] !== undefined).map((key) => [key, claims[key]]));

// ---------------------------------------------------------------- routes

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  const query = event.queryStringParameters || {};

  try {
    const secret = await getSecret();

    if (method === 'GET' && path === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: BRIDGE_BASE_URL,
        authorization_endpoint: `${BRIDGE_BASE_URL}/authorize`,
        token_endpoint: `${BRIDGE_BASE_URL}/token`,
        userinfo_endpoint: `${BRIDGE_BASE_URL}/userinfo`,
        jwks_uri: `${BRIDGE_BASE_URL}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        claims_supported: PROFILE_CLAIMS,
      }, { 'cache-control': 'public, max-age=3600' });
    }

    if (method === 'GET' && path === '/.well-known/jwks.json') return json(200, jwks(secret), { 'cache-control': 'public, max-age=3600' });

    if (method === 'GET' && path === '/authorize') {
      if (query.client_id !== secret.bridgeClientId) return oauthError(400, 'unauthorized_client', 'Unknown client_id');
      if (query.redirect_uri !== ALLOWED_REDIRECT_URI) return oauthError(400, 'invalid_request', 'redirect_uri is not allowed');
      const url = new URL(`${GITHUB}/login/oauth/authorize`);
      url.searchParams.set('client_id', secret.githubClientId);
      url.searchParams.set('redirect_uri', `${BRIDGE_BASE_URL}/callback`);
      url.searchParams.set('scope', 'read:user user:email');
      url.searchParams.set('state', b64url({ s: query.state || '', n: query.nonce || '' }));
      url.searchParams.set('allow_signup', 'true');
      return redirect(url.toString());
    }

    if (method === 'GET' && path === '/callback') {
      let wrapped;
      try {
        wrapped = fromB64url(query.state || '');
      } catch {
        return oauthError(400, 'invalid_request', 'state is missing or damaged');
      }
      const url = new URL(ALLOWED_REDIRECT_URI);
      if (wrapped.s) url.searchParams.set('state', wrapped.s);
      if (query.error || !query.code) {
        url.searchParams.set('error', query.error === 'access_denied' ? 'access_denied' : 'server_error');
        return redirect(url.toString());
      }
      const profile = await githubProfile(query.code, secret);
      url.searchParams.set('code', signHS256({ ...profile, nonce: wrapped.n || undefined, exp: now() + CODE_TTL }, secret.internalCodeHmacSecret));
      return redirect(url.toString());
    }

    if (method === 'POST' && path === '/token') {
      const body = formBody(event);
      if (body.grant_type !== 'authorization_code' || !body.code) return oauthError(400, 'unsupported_grant_type', 'Only authorization_code is supported');
      const { clientId, clientSecret } = clientCredentials(event, body);
      if (clientId !== secret.bridgeClientId || (secret.bridgeClientSecret && !sameText(clientSecret, secret.bridgeClientSecret))) {
        return oauthError(401, 'invalid_client', 'Client authentication failed');
      }
      let code;
      try {
        code = verifyHS256(body.code, secret.internalCodeHmacSecret);
      } catch {
        return oauthError(400, 'invalid_grant', 'The code is invalid or expired');
      }
      const issued = now();
      const base = { iss: BRIDGE_BASE_URL, aud: secret.bridgeClientId, iat: issued, exp: issued + TOKEN_TTL, ...profileOf(code) };
      const idToken = signRS256({ ...base, ...(code.nonce ? { nonce: code.nonce } : {}) }, secret);
      const accessToken = signRS256({ ...base, token_use: 'access' }, secret);
      return json(200, { access_token: accessToken, id_token: idToken, token_type: 'Bearer', expires_in: TOKEN_TTL, scope: 'openid email profile' });
    }

    if ((method === 'GET' || method === 'POST') && path === '/userinfo') {
      const header = event.headers?.authorization || event.headers?.Authorization || '';
      try {
        const claims = verifyRS256(header.replace(/^Bearer\s+/i, ''), secret);
        if (claims.aud !== secret.bridgeClientId) return invalidToken();
        return json(200, profileOf(claims));
      } catch {
        return invalidToken();
      }
    }

    return json(404, { error: 'not_found' });
  } catch (err) {
    console.error('GitHub bridge failed', err);
    return oauthError(500, 'server_error', 'The GitHub bridge hit an error');
  }
};
