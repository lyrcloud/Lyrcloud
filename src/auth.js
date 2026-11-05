// Shared auth helpers for Lyrcloud's Cognito login: Google and GitHub through the Hosted UI (GitHub via
// the OIDC bridge in infra/aws/github-bridge.yml), and email-and-password through src/cognito.js.
// Used by the site header (src/main.js), /callback.html (token exchange), and
// the dashboard (src/dash.js, via src/session.js).
//
// Tokens live in sessionStorage (cleared when the tab closes) rather than
// localStorage, since there's no need for a persistent "remember me" session
// yet. The access_token (not the id_token) is what's sent to the account
// API — Cognito access tokens carry `client_id` instead of `aud`, which is
// exactly what the API's JWT authorizer is configured to check.

import { refresh, revoke, signIn } from './cognito.js';

export const COGNITO_DOMAIN = 'lyrcloud-auth.auth.us-east-1.amazoncognito.com';
export const CLIENT_ID = '5h78n6dkjbhq92423lscfllj6t';
export const ACCOUNT_API_BASE = 'https://wcqz7ix4t7.execute-api.us-east-1.amazonaws.com';
// Lyrcloud Projects (import, build and host git repositories); the lyrcloud-projects stack's API.
export const PROJECTS_API_BASE = 'https://projects-api.invalid';
export const SITES_DOMAIN = 'lyrcloud.app';
// Lyrcloud Domains (search, register, transfer and renew domains); the lyrcloud-domains stack's API.
export const DOMAINS_API_BASE = 'https://uqp5mc2gq0.execute-api.us-east-1.amazonaws.com';

const REDIRECT_URI = `${location.origin}/callback.html`;
const LOGOUT_URI = `${location.origin}/index.html`;
const TOKENS_KEY = 'lyrcloud.auth.tokens';
const VERIFIER_KEY = 'lyrcloud.auth.pkce_verifier';
const RETURN_KEY = 'lyrcloud.auth.return_to';

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

function randomString(length) {
  return base64url(crypto.getRandomValues(new Uint8Array(length)));
}

export function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function getTokens() {
  try {
    return JSON.parse(sessionStorage.getItem(TOKENS_KEY) || 'null');
  } catch {
    return null;
  }
}

// `method` is "password" for sessions from the email-and-password form; those refresh through the
// Cognito API instead of the Hosted UI token endpoint.
function storeTokens(tokenResponse, method = 'hosted') {
  const tokens = {
    accessToken: tokenResponse.access_token,
    idToken: tokenResponse.id_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
    method,
  };
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  return tokens;
}

export function clearTokens() {
  sessionStorage.removeItem(TOKENS_KEY);
}

export function isLoggedIn() {
  return Boolean(getTokens());
}

// Signs in with an email and password (see src/cognito.js) and keeps the session like a Hosted UI one.
export async function passwordSignIn(email, password) {
  const result = await signIn(CLIENT_ID, email, password);
  return storeTokens({
    access_token: result.AccessToken,
    id_token: result.IdToken,
    refresh_token: result.RefreshToken,
    expires_in: result.ExpiresIn,
  }, 'password');
}

// Redirects the browser to Cognito. Passing `provider` ('google' or 'github')
// skips the Hosted UI chooser page and goes straight to that provider; without
// it, Hosted UI shows both. `returnTo` must be a same-site path; /callback.html
// sends the user there after sign-in.
const IDENTITY_PROVIDERS = { google: 'GoogleOIDC', github: 'GitHubBridge' };

export async function redirectToLogin(returnTo = '/dash/', provider) {
  sessionStorage.setItem(RETURN_KEY, returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dash/');
  const verifier = randomString(32);
  const challenge = base64url(await sha256(verifier));
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const url = new URL(`https://${COGNITO_DOMAIN}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (IDENTITY_PROVIDERS[provider]) url.searchParams.set('identity_provider', IDENTITY_PROVIDERS[provider]);
  location.href = url.toString();
}

export async function exchangeCodeForTokens(code) {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier) throw new Error('missing_pkce_verifier');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return storeTokens(await res.json());
}

async function refreshTokens() {
  const tokens = getTokens();
  if (!tokens?.refreshToken) return null;

  if (tokens.method === 'password') {
    try {
      const result = await refresh(CLIENT_ID, tokens.refreshToken);
      return storeTokens({ access_token: result.AccessToken, id_token: result.IdToken, refresh_token: tokens.refreshToken, expires_in: result.ExpiresIn }, 'password');
    } catch {
      clearTokens();
      return null;
    }
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: tokens.refreshToken,
  });

  const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    clearTokens();
    return null;
  }
  const refreshed = await res.json();
  // Cognito's refresh grant doesn't return a new refresh_token; keep the old one.
  return storeTokens({ ...refreshed, refresh_token: tokens.refreshToken });
}

export async function getValidAccessToken() {
  let tokens = getTokens();
  if (!tokens) return null;
  if (Date.now() < tokens.expiresAt - 30_000) return tokens.accessToken;
  tokens = await refreshTokens();
  return tokens?.accessToken ?? null;
}

// Calls an API protected by this user pool's JWT authorizer (the Lyrcloud account API by default).
export async function authFetch(path, options = {}, apiBase = ACCOUNT_API_BASE) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new Error('not_authenticated');
  return fetch(`${apiBase}${path}`, {
    ...options,
    headers: { ...options.headers, authorization: `Bearer ${accessToken}` },
  });
}

export function takeReturnPath(fallback = '/dash/') {
  const path = sessionStorage.getItem(RETURN_KEY) || fallback;
  sessionStorage.removeItem(RETURN_KEY);
  return path;
}

export function logout() {
  const tokens = getTokens();
  clearTokens();
  sessionStorage.removeItem('lyrcloud.profile');
  // Password sessions never touched the Hosted UI, so there's no Cognito cookie to clear.
  if (tokens?.method === 'password') {
    revoke(CLIENT_ID, tokens.refreshToken).finally(() => location.replace(LOGOUT_URI));
    return;
  }
  const url = new URL(`https://${COGNITO_DOMAIN}/logout`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('logout_uri', LOGOUT_URI);
  location.href = url.toString();
}
