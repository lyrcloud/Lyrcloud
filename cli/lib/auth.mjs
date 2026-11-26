// Signing in. `lyrcloud login` opens Lyrcloud's sign-in page (Cognito Hosted UI, the same one the website
// uses) with PKCE and catches the redirect on http://localhost:5173/callback.html. `--email` signs in
// with an email and password instead. The ID token is sent to the API and refreshed with the refresh token.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { CLIENT_ID, COGNITO_DOMAIN, COGNITO_REGION, LOGIN_PORTS, readCredentials, writeCredentials } from './config.mjs';

export class AuthError extends Error {}

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function saveTokens(tokens, previous = {}) {
  const claims = decodeJwt(tokens.id_token);
  const credentials = {
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token || previous.refreshToken,
    expiresAt: (claims.exp || Math.floor(Date.now() / 1000) + 3600) * 1000,
    email: claims.email || previous.email || null,
    name: claims.name || previous.name || null,
    sub: claims.sub || previous.sub || null,
  };
  writeCredentials(credentials);
  return credentials;
}

export function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed too.
  }
}

function listen(port, handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const page = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:30rem;margin:20vh auto;padding:0 1rem;line-height:1.5;text-align:center"><h1>${title}</h1><p>${text}</p></body>`;

export async function browserLogin({ provider, log = console.log, timeoutMs = 5 * 60_000 } = {}) {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  let server;
  let port;
  let settle;
  const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const onRequest = (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname !== '/callback.html') {
      res.writeHead(404).end();
      return;
    }
    const send = (status, title, text) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(page(title, text));
    if (url.searchParams.get('state') !== state) {
      send(400, 'Sign-in didn’t match', 'Run <code>lyrcloud login</code> again.');
      return;
    }
    if (url.searchParams.get('error')) {
      send(400, 'Sign-in failed', url.searchParams.get('error_description') || url.searchParams.get('error'));
      settle.reject(new AuthError(url.searchParams.get('error_description') || url.searchParams.get('error')));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      send(400, 'Sign-in failed', 'No sign-in code came back. Run <code>lyrcloud login</code> again.');
      return;
    }
    send(200, '✓ Signed in', 'You can close this window and return to the terminal.');
    settle.resolve(code);
  };
  for (const candidate of LOGIN_PORTS) {
    try {
      server = await listen(candidate, onRequest);
      port = candidate;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  if (!server) throw new AuthError(`Ports ${LOGIN_PORTS.join(' and ')} are busy (a dev server, perhaps). Stop it and run lyrcloud login again, or use lyrcloud login --email.`);

  const redirectUri = `http://localhost:${port}/callback.html`;
  const authorize = new URL(`https://${COGNITO_DOMAIN}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(provider ? { identity_provider: provider } : {}),
  }).toString();

  log('Opening your browser to sign in to Lyrcloud…');
  log(`If it doesn’t open, visit:\n  ${authorize}\n`);
  openBrowser(authorize.toString());

  const timer = setTimeout(() => settle.reject(new AuthError('Sign-in timed out. Run lyrcloud login again.')), timeoutMs);
  try {
    const code = await result;
    const response = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    const tokens = await response.json().catch(() => ({}));
    if (!response.ok || !tokens.id_token) throw new AuthError(`Sign-in failed: ${tokens.error_description || tokens.error || response.status}`);
    return saveTokens(tokens);
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

async function cognito(target, body) {
  const response = await fetch(`https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const type = String(data.__type || '').split('#').pop();
    const err = new AuthError(data.message || type || `Cognito answered ${response.status}`);
    err.type = type;
    throw err;
  }
  return data;
}

export async function passwordLogin(email, password) {
  let data;
  try {
    data = await cognito('InitiateAuth', { ClientId: CLIENT_ID, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } });
  } catch (err) {
    if (err.type === 'InvalidParameterException' && /USER_PASSWORD_AUTH/.test(err.message)) {
      throw new AuthError('Email sign-in isn’t switched on for the CLI yet. Use lyrcloud login (browser) instead.');
    }
    if (err.type === 'NotAuthorizedException') throw new AuthError('Wrong email or password.');
    if (err.type === 'UserNotConfirmedException') throw new AuthError('Confirm your email first: finish signing up at https://www.lyrcloud.com/sign-up/.');
    throw err;
  }
  if (data.ChallengeName) throw new AuthError(`This account needs ${data.ChallengeName} to sign in. Use lyrcloud login (browser) instead.`);
  const result = data.AuthenticationResult;
  return saveTokens({ id_token: result.IdToken, refresh_token: result.RefreshToken });
}

// A valid ID token, refreshed when it's within a minute of expiring. Throws AuthError when signed out.
export async function idToken() {
  const credentials = readCredentials();
  if (!credentials?.idToken) throw new AuthError('You’re not signed in. Run lyrcloud login first.');
  if (credentials.expiresAt - Date.now() > 60_000) return credentials.idToken;
  if (!credentials.refreshToken) throw new AuthError('Your sign-in has expired. Run lyrcloud login again.');
  try {
    const data = await cognito('InitiateAuth', { ClientId: CLIENT_ID, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: credentials.refreshToken } });
    return saveTokens({ id_token: data.AuthenticationResult.IdToken }, credentials).idToken;
  } catch (err) {
    if (err instanceof AuthError && err.type) throw new AuthError('Your sign-in has expired. Run lyrcloud login again.');
    throw err;
  }
}

export async function revoke() {
  const credentials = readCredentials();
  if (!credentials?.refreshToken) return;
  await fetch(`https://${COGNITO_DOMAIN}/oauth2/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: credentials.refreshToken, client_id: CLIENT_ID }),
  }).catch(() => {});
}
