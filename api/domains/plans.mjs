// Lyrcloud plans paid with Lyrpay: Scale is $29 a month or $290 a year (ten months), paid from the customer's
// Lyrpay balance. Launch is free; Enterprise is sold through Contact sales and set by staff. Pure rules here
// (tested in plans.test.mjs); the routes are in index.mjs:
//   GET  /domains/plan                     { plan, planPaidThrough, prices, lyrpayReady, orders }
//   POST /domains/plan/checkout            { plan: 'scale', period: 'month'|'year' } -> { url } on lyrpay.com
//   POST /domains/plan/orders/{id}/check   asks Lyrpay about an order (when the customer comes back)
// A paid plan is written to the account profile (lyrcloud-users: plan, planPaidThrough, planSource 'lyrpay'),
// so every Lyrcloud API sees it. The 15-minute run moves lapsed Lyrpay plans back to Launch.
export const PAID_PLANS = { scale: { name: 'Scale', monthCents: 2900 } };
export const PERIODS = { month: 1, year: 12 };

export function planPriceCents(plan, period) {
  const info = PAID_PLANS[plan];
  if (!info || !PERIODS[period]) return null;
  return info.monthCents * (period === 'year' ? 10 : 1);
}

export const planReference = (orderId) => `plan-${orderId}`;
export const planOrderFrom = (reference) => (/^plan-[a-f0-9-]{8,40}$/.test(String(reference || '')) ? String(reference).slice(5) : null);

// The new paid-through date: renewing the same active plan adds on; otherwise it starts now.
export function extendPlan(profile, plan, period, now = new Date()) {
  const months = PERIODS[period];
  if (!months) throw new Error(`Unknown period ${period}`);
  const active = profile?.plan === plan && profile?.planPaidThrough && Date.parse(profile.planPaidThrough) > now.getTime();
  const start = active ? new Date(profile.planPaidThrough) : new Date(now);
  const day = start.getUTCDate();
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()));
  next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  return next.toISOString();
}

// A plan bought with Lyrpay that has run out (plans set by staff have no planSource and never lapse).
export const planLapsed = (profile, now = new Date()) =>
  profile?.planSource === 'lyrpay' && profile.plan !== 'launch' && Boolean(profile.planPaidThrough) && Date.parse(profile.planPaidThrough) <= now.getTime();
