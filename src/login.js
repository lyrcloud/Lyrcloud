// /login/ and /sign-up/: Google and GitHub go through the Cognito Hosted UI; email-and-password runs
// here, step by step (sign up → email code → mobile number → mobile code, or log in / reset password).
import { authFetch, CLIENT_ID, isLoggedIn, passwordSignIn, redirectToLogin } from './auth.js';
import { confirmForgotPassword, confirmSignUp, forgotPassword, normalizeEmail, resendCode, signUp } from './cognito.js';

const next = new URLSearchParams(location.search).get('next');
const destination = next && next.startsWith('/dash/') ? next : '/dash/';

if (isLoggedIn()) location.replace(destination);

for (const button of document.querySelectorAll('[data-login]')) {
  button.addEventListener('click', () => {
    button.disabled = true;
    redirectToLogin(destination, button.dataset.login);
  });
}

const card = document.querySelector('.auth-card');
const intro = card.querySelector('.auth-intro');
const switcher = card.querySelector('.auth-switch');
const steps = Object.fromEntries([...card.querySelectorAll('[data-step]')].map((form) => [form.dataset.step, form]));
// What the visitor has typed so far, carried between steps.
const flow = { email: '', password: '', phone: '' };

function show(step) {
  for (const [name, form] of Object.entries(steps)) form.hidden = name !== step;
  // Google/GitHub and the page switch only make sense on the first step.
  const first = step === 'sign-up' || step === 'sign-in';
  intro.hidden = !first;
  switcher.hidden = !first;
  const form = steps[step];
  for (const node of form.querySelectorAll('[data-show]')) node.textContent = flow[node.dataset.show];
  const email = form.querySelector('input[name="email"]');
  if (email && !email.value) email.value = flow.email;
  setError(form, '');
  form.querySelector('input:not([type="hidden"])')?.focus();
}

function setError(form, message) {
  const node = form.querySelector('.form-error');
  node.textContent = message;
  node.hidden = !message;
}

// Runs `work` with the form's submit button busy; shows any error on the form.
async function busy(form, label, work) {
  const button = form.querySelector('[type="submit"]');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  setError(form, '');
  try {
    await work();
  } catch (error) {
    setError(form, error.message);
    // An unconfirmed account trying to log in: send a fresh code and ask for it.
    if (error.type === 'UserNotConfirmedException') {
      await resendCode(CLIENT_ID, flow.email).catch(() => {});
      show('confirm');
      setError(steps.confirm, error.message);
    }
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

const finish = () => location.replace(destination);

async function accountApi(path, body) {
  const response = await authFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

const handlers = {
  'sign-up': (form, data) => busy(form, 'Creating account…', async () => {
    Object.assign(flow, { email: normalizeEmail(data.get('email')), password: String(data.get('password')) });
    await signUp(CLIENT_ID, { email: flow.email, password: flow.password, name: String(data.get('name')).trim() });
    show('confirm');
  }),

  'sign-in': (form, data) => busy(form, 'Logging in…', async () => {
    Object.assign(flow, { email: normalizeEmail(data.get('email')), password: String(data.get('password')) });
    await passwordSignIn(flow.email, flow.password);
    finish();
  }),

  confirm: (form, data) => busy(form, 'Verifying…', async () => {
    await confirmSignUp(CLIENT_ID, flow.email, String(data.get('code')));
    if (!flow.password) return show('sign-in');
    await passwordSignIn(flow.email, flow.password);
    flow.password = '';
    show('phone');
  }),

  forgot: (form, data) => busy(form, 'Sending…', async () => {
    flow.email = normalizeEmail(data.get('email'));
    await forgotPassword(CLIENT_ID, flow.email);
    show('reset');
  }),

  reset: (form, data) => busy(form, 'Saving…', async () => {
    const password = String(data.get('password'));
    await confirmForgotPassword(CLIENT_ID, flow.email, String(data.get('code')), password);
    await passwordSignIn(flow.email, password);
    finish();
  }),

  phone: (form, data) => busy(form, 'Sending…', async () => {
    const { phonePending } = await accountApi('/me/phone', { phone: String(data.get('phone')) });
    flow.phone = phonePending;
    show('phone-code');
  }),

  'phone-code': (form, data) => busy(form, 'Verifying…', async () => {
    await accountApi('/me/phone/verify', { code: String(data.get('code')).trim() });
    finish();
  }),
};

card.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-step]');
  if (!form) return;
  event.preventDefault();
  handlers[form.dataset.step]?.(form, new FormData(form));
});

card.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-goto], [data-action]');
  if (!target) return;
  if (target.dataset.goto) return show(target.dataset.goto);
  if (target.dataset.action === 'finish') return finish();
  if (target.dataset.action === 'resend') {
    const form = target.closest('form');
    target.disabled = true;
    try {
      await resendCode(CLIENT_ID, flow.email);
      setError(form, '');
      target.textContent = 'Code sent — check your email';
    } catch (error) {
      setError(form, error.message);
    }
    setTimeout(() => {
      target.disabled = false;
      target.textContent = 'Send a new code';
    }, 30_000);
  }
});
