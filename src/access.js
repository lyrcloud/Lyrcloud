// /access/: functions protected by Lyrcloud Access (api/functions/access.mjs) send visitors here with a
// signed ?to=. Once they're signed in, the functions API checks them against the function's allow-list
// and hands back a one-time link to the function, which sets its own session cookie.
import { authFetch, clearTokens, FUNCTIONS_API_BASE, isLoggedIn, redirectToLogin } from './auth.js';

const to = new URLSearchParams(location.search).get('to');
const title = document.querySelector('.access-title');
const text = document.querySelector('.access-text');
const signIn = document.querySelector('.access-signin');
const actions = document.querySelector('.access-actions');
const here = `${location.pathname}${location.search}`;

const say = (heading, message) => {
  title.textContent = heading;
  text.textContent = message;
};

function askToSignIn() {
  say('Sign in to continue', 'This app is protected by Lyrcloud Access. Sign in with the account its owner gave access to.');
  signIn.hidden = false;
  signIn.querySelector('.access-email').href = `/login/?next=${encodeURIComponent(here)}`;
  signIn.querySelector('[data-access-login]').addEventListener('click', (event) => {
    event.currentTarget.disabled = true;
    redirectToLogin(here, 'google');
  });
}

document.querySelector('.access-switch').addEventListener('click', () => {
  clearTokens();
  actions.hidden = true;
  askToSignIn();
});

async function main() {
  if (!to) {
    say('Nothing to open', 'Open the app’s address again to sign in to it.');
    return;
  }
  if (!isLoggedIn()) {
    askToSignIn();
    return;
  }
  let res;
  try {
    res = await authFetch('/access/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }) }, FUNCTIONS_API_BASE);
  } catch (err) {
    if (err.message === 'not_authenticated') {
      askToSignIn();
      return;
    }
    say('Couldn’t reach Lyrcloud', 'Check your connection and reload this page.');
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.url) {
    say('Opening the app…', data.host ? `Signed in as ${data.email || 'you'}. Taking you to ${data.host}.` : 'Taking you there.');
    location.replace(data.url);
    return;
  }
  if (res.status === 401) {
    clearTokens();
    askToSignIn();
    return;
  }
  say(res.status === 403 ? 'No access' : 'Couldn’t sign you in', data.error || 'Please try again.');
  actions.hidden = false;
}

main();
