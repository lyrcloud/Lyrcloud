// Lyrcloud emails sent by the account API through Amazon SES: the welcome email for a new account and
// the product updates the super admin sends from the admin console. Every update carries a signed
// unsubscribe link (GET /public/unsubscribe), so no one has to sign in to stop them.
//
// Verification codes (sign-up, password reset) are sent by Cognito itself, not from here.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SITE_URL = 'https://www.lyrcloud.com';
export const UPDATE_SUBJECT_MAX = 150;
export const UPDATE_MESSAGE_MAX = 5000;

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Plain text → HTML paragraphs, with bare https links made clickable.
function textToHtml(text) {
  return String(text)
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) =>
      `<p style="margin:0 0 16px">${escapeHtml(paragraph)
        .replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}" style="color:#0369a1">${url}</a>`)
        .replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function layout({ heading, bodyHtml, footerHtml }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1f23">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e3e5e8">
<tr><td style="padding:28px 32px 0;font-size:20px;font-weight:700;color:#0369a1">Lyrcloud</td></tr>
<tr><td style="padding:20px 32px 8px;font-size:15px;line-height:1.6">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1d1f23">${escapeHtml(heading)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;line-height:1.5;color:#6b7078;border-top:1px solid #eef0f2">${footerHtml}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href, label) =>
  `<p style="margin:24px 0"><a href="${href}" style="display:inline-block;background:#0369a1;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${escapeHtml(label)}</a></p>`;

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

export function welcomeEmail({ name }) {
  const hello = firstName(name) ? `Welcome to Lyrcloud, ${firstName(name)}` : 'Welcome to Lyrcloud';
  const text = `${hello}!

Your account is ready. Here's how to get going:

1. Add your first website: ${SITE_URL}/dash/#/add-site
2. Point your domain's nameservers to Lyrcloud
3. Turn on caching, security rules and edge functions

Questions? Just reply to this email or write to support@lyrcloud.com.

— The Lyrcloud team

You're getting this one-off email because you created a Lyrcloud account.`;
  const html = layout({
    heading: `${hello}!`,
    bodyHtml: `<p style="margin:0 0 16px">Your account is ready. Here’s how to get going:</p>
<ol style="margin:0 0 16px;padding-left:20px">
<li>Add your first website</li>
<li>Point your domain’s nameservers to Lyrcloud</li>
<li>Turn on caching, security rules and edge functions</li>
</ol>
${button(`${SITE_URL}/dash/#/add-site`, 'Add your first website')}
<p style="margin:0">Questions? Just reply to this email or write to <a href="mailto:support@lyrcloud.com" style="color:#0369a1">support@lyrcloud.com</a>.</p>
<p style="margin:16px 0 0">— The Lyrcloud team</p>`,
    footerHtml: 'You’re getting this one-off email because you created a Lyrcloud account.',
  });
  return { subject: hello, text, html };
}

export function updateEmail({ subject, message, unsubscribeUrl }) {
  const text = `${message.trim()}

— The Lyrcloud team

Don't want product updates? Unsubscribe: ${unsubscribeUrl}
Or turn them off in ${SITE_URL}/dash/#/settings`;
  const html = layout({
    heading: subject,
    bodyHtml: `${textToHtml(message)}<p style="margin:0">— The Lyrcloud team</p>`,
    footerHtml: `You’re getting this because you have a Lyrcloud account with product updates turned on.
<a href="${unsubscribeUrl}" style="color:#6b7078">Unsubscribe</a> or change it in <a href="${SITE_URL}/dash/#/settings" style="color:#6b7078">account settings</a>.`,
  });
  return { subject, text, html };
}

// Returns [statusCode, message] when an update email can't be sent as given, else null.
export function updateEmailError(body) {
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!subject || subject.length > UPDATE_SUBJECT_MAX) return [400, `Subject must be 1 to ${UPDATE_SUBJECT_MAX} characters.`];
  if (!message || message.length > UPDATE_MESSAGE_MAX) return [400, `Message must be 1 to ${UPDATE_MESSAGE_MAX} characters.`];
  if (body.updateId !== undefined && !/^[0-9a-z-]{8,64}$/.test(String(body.updateId))) return [400, 'Invalid updateId.'];
  return null;
}

// Unsubscribe links: /public/unsubscribe?u=<userId>&t=<HMAC of the userId>.
export const unsubscribeToken = (secret, userId) => createHmac('sha256', secret).update(`unsubscribe:${userId}`).digest('base64url');

export function validUnsubscribeToken(secret, userId, token) {
  if (!secret || !userId || typeof token !== 'string') return false;
  const expected = Buffer.from(unsubscribeToken(secret, userId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// state: "confirm" (a button that POSTs to `action`), "done" or "invalid".
export function unsubscribePage(state, action = '') {
  const settings = button(`${SITE_URL}/dash/#/settings`, 'Email settings');
  const pages = {
    confirm: ['Unsubscribe from Lyrcloud updates?', `<p style="margin:0 0 16px">You’ll stop getting product update emails. Emails about your account and security still arrive.</p>
<form method="post" action="${escapeHtml(action)}" style="margin:24px 0"><button type="submit" style="background:#0369a1;color:#ffffff;border:0;font:inherit;font-weight:600;padding:12px 20px;border-radius:8px;cursor:pointer">Unsubscribe</button></form>`],
    done: ['You’re unsubscribed', `<p style="margin:0 0 16px">You won’t get Lyrcloud product updates any more. Emails about your account and security still arrive.</p>${settings}`],
    invalid: ['This link didn’t work', `<p style="margin:0 0 16px">The unsubscribe link is incomplete or out of date. You can turn updates off in your account settings.</p>${settings}`],
  };
  const [heading, bodyHtml] = pages[state] || pages.invalid;
  return layout({ heading, bodyHtml, footerHtml: 'Lyrcloud · <a href="https://www.lyrcloud.com" style="color:#6b7078">lyrcloud.com</a>' });
}
