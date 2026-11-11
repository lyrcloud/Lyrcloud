// Pay with Lyrpay: customers pay for a domain from their Lyrpay balance (lyrpay.com, the Lyr wallet). The order
// stores the Lyrpay payment id (lpp_…) where a Stripe order stores its session and payment intent; index.mjs asks
// which kind it holds when it confirms, refunds or expires an order. Lyrpay posts a signed callback to
// /public/lyrpay/callback when a payment is paid; the scheduled run asks about any it missed.
//
// Keys: the lyrcloud/lyrpay secret, JSON { "secret_key": "lpk_lyrcloud_…", "webhook_secret": "lpwh_…" }, from
// lyrpay.com/#admin > Lyr apps. Without it the Lyrpay option stays hidden. Auto-renew needs a saved card, so a
// domain paid with Lyrpay renews from the dashboard.
import { createHmac, timingSafeEqual } from 'node:crypto';

const API = () => (process.env.LYRPAY_API || 'https://lyrpay.com/api/v1').replace(/\/$/, '');
const SIGNATURE_AGE_S = 600;

export const isLyrpay = (id) => /^lpp_[0-9a-f]{24}$/.test(String(id ?? ''));
export const usable = (keys) => /^lpk_/.test(String(keys?.secret_key ?? ''));

export class LyrpayError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function call(keys, method, path, body) {
  if (!usable(keys)) throw new LyrpayError('Pay with Lyrpay isn’t switched on.', 503);
  let res;
  try {
    res = await fetch(`${API()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${keys.secret_key}`, 'Content-Type': 'application/json', 'User-Agent': 'Lyrcloud-Domains/1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new LyrpayError('Lyrpay didn’t answer. Please try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new LyrpayError(data.detail || `Lyrpay answered ${res.status}`, res.status);
  return data;
}

// A payment for one order, in US cents. Returns { id, url } (url: the page on lyrpay.com).
// email only fills in Lyrpay's sign-up form; any Lyr account may still pay
export async function openPayment(keys, { orderId, amountCents, title, returnUrl, cancelUrl, metadata, email }) {
  const payment = await call(keys, 'POST', '/payments', {
    amount: (amountCents / 100).toFixed(2), currency: 'USD', reference: orderId, description: String(title).slice(0, 140),
    returnUrl, cancelUrl, expiresInMinutes: 30, metadata, ...(/^\S+@\S+\.\S+$/.test(email || '') ? { email } : {}),
  });
  return { id: payment.id, url: payment.url };
}

export const getPayment = (keys, id) => call(keys, 'GET', `/payments/${encodeURIComponent(id)}`);

// Gives all of it back to the customer's Lyrpay balance. Refunding twice is harmless: the second is refused as done.
export async function refundPayment(keys, id) {
  try {
    return await call(keys, 'POST', `/payments/${encodeURIComponent(id)}/refund`, {});
  } catch (err) {
    if (err.status === 409 && (await getPayment(keys, id).catch(() => null))?.status === 'refunded') return null;
    throw err;
  }
}

export const paidCents = (payment) => Math.round(Number(payment.amount) * 100);

// The callback's JSON if its Lyrpay-Signature (t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">) is good, else null.
export function verify(keys, rawBody, header, nowSeconds = Math.floor(Date.now() / 1000)) {
  const secret = keys?.webhook_secret;
  if (!secret || !header) return null;
  const parts = Object.fromEntries(String(header).split(',').map((part) => part.split('=')).filter((part) => part.length === 2));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > SIGNATURE_AGE_S) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const sent = Buffer.from(String(parts.v1 ?? ''));
  if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
