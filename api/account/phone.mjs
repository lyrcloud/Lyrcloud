// Mobile number verification: the account API texts a 6-digit code through Amazon SNS and stores
// only an HMAC of it on the profile row, with an expiry and an attempt count.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const SMS_PER_USER_PER_DAY = 5;
export const SMS_SITE_PER_DAY = 200;

// "+91 98765-43210" → "+919876543210". E.164: a "+", then 8 to 15 digits not starting with 0.
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const compact = input.trim().replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export const hashCode = (secret, userId, phone, code) =>
  createHmac('sha256', secret).update(`phone:${userId}:${phone}:${code}`).digest('base64url');

export const smsMessage = (code) => `${code} is your Lyrcloud verification code. It expires in 10 minutes. Don't share it with anyone.`;

// Checks `code` against the pending verification on `profile`. Returns { ok } or { error: [status, message] }.
export function checkCode(secret, profile, code, now = Date.now()) {
  const pending = profile?.phonePending;
  if (!pending?.phone || !pending.hash) return { error: [400, 'Send a code to your number first.'] };
  if (now > pending.expiresAt) return { error: [400, 'That code has expired. Send a new one.'] };
  if ((pending.attempts || 0) >= MAX_ATTEMPTS) return { error: [429, 'Too many wrong codes. Send a new one.'] };
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return { error: [400, 'Enter the 6-digit code.'] };
  const expected = Buffer.from(pending.hash);
  const given = Buffer.from(hashCode(secret, profile.userId, pending.phone, code.trim()));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { error: [400, 'That code isn’t right.'], wrong: true };
  return { ok: true, phone: pending.phone };
}

// Shows only the last digits of a number in the admin console.
export const maskPhone = (phone) => (phone ? `${phone.slice(0, 3)}••••${phone.slice(-3)}` : null);
