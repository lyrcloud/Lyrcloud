// Lyrcloud on AWS Marketplace (SaaS, contract with pay-as-you-go). Buyers pay on their AWS bill; AWS pays Lyrcloud.
//   Contract dimensions   scale, enterprise   which Lyrcloud plan the buyer has (1 = entitled)
//   Usage dimension       kubernetes_cluster_hours   each managed Kubernetes cluster, metered every hour
//                         (instead of the $49/month Lyrpay fee for that buyer's clusters)
// Flow:
//   1. The buyer subscribes in AWS Marketplace and AWS POSTs a form with x-amzn-marketplace-token to
//      POST /public/marketplace (no login). ResolveCustomer turns it into the buyer's AWS account ID,
//      LicenseArn and product code; Lyrcloud keeps them under a one-time code and sends the browser to
//      /dash/#/marketplace/<code>.
//   2. Signed in to Lyrcloud, the buyer links it: POST /cloud/marketplace/link { code }. One license links to
//      one Lyrcloud account.
//   3. The plan comes from GetEntitlements (product code + LicenseArn), re-read on every Marketplace event and
//      every hour; it's written to the account profile with planSource 'marketplace'. When the entitlement goes,
//      the plan goes back to Launch and the buyer's clusters return to the Lyrpay fee.
//   4. Every hour, BatchMeterUsage with the LicenseArn (new-style integrations: no CustomerIdentifier, and no
//      ProductCode at the request level) and the number of Kubernetes clusters Lyrcloud manages for the buyer.
import { randomBytes } from 'node:crypto';

export const CONTRACT_DIMENSIONS = { enterprise: 'enterprise', scale: 'scale' }; // best first
export const USAGE_DIMENSION = 'kubernetes_cluster_hours';
export const CLUSTER_HOUR_USD = 0.067; // ≈ $49 a month, the same as the Lyrpay fee
export const REGISTRATION_HOURS = 24;
export const METERED_STATUSES = ['creating', 'ready', 'updating', 'failed'];

export const newCode = () => randomBytes(18).toString('base64url');
export const startOfHour = (date = new Date()) => new Date(Math.floor(date.getTime() / 3_600_000) * 3_600_000);

// The form AWS posts: application/x-www-form-urlencoded, maybe base64 through API Gateway.
export function tokenFrom(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  const token = new URLSearchParams(raw).get('x-amzn-marketplace-token');
  return token && token.length < 4096 ? token : null;
}

// The plan an entitlement list gives (null: none active).
export function planFromEntitlements(entitlements, now = new Date()) {
  const active = (entitlements || []).filter((e) => {
    const value = e.Value || {};
    const on = value.IntegerValue === undefined && value.BooleanValue === undefined ? true : (value.IntegerValue ?? 0) > 0 || value.BooleanValue === true;
    return on && (!e.ExpirationDate || new Date(e.ExpirationDate).getTime() > now.getTime());
  });
  for (const [dimension, plan] of Object.entries(CONTRACT_DIMENSIONS)) {
    const match = active.find((e) => e.Dimension === dimension);
    if (match) return { plan, expiresAt: match.ExpirationDate ? new Date(match.ExpirationDate).toISOString() : null };
  }
  return null;
}

// What to write to the account profile for this entitlement result (null: leave the profile alone).
// Marketplace never takes a plan away that it didn't give, and a staff-set Enterprise stays.
export function profileChange(profile, entitled) {
  if (entitled) {
    if (profile.plan === 'enterprise' && profile.planSource !== 'marketplace' && entitled.plan !== 'enterprise') return null;
    return { plan: entitled.plan, planSource: 'marketplace', planPaidThrough: entitled.expiresAt };
  }
  return profile.planSource === 'marketplace' ? { plan: 'launch', planSource: null, planPaidThrough: null } : null;
}

// The usage record for one buyer and hour, or null when there's nothing to bill.
export function usageRecord(link, clusters, hour) {
  const count = clusters.filter((c) => c.kind === 'kubernetes' && c.billing === 'marketplace' && METERED_STATUSES.includes(c.status)).length;
  if (!count) return null;
  return { Timestamp: hour, CustomerAWSAccountId: link.awsAccountId, LicenseArn: link.licenseArn, Dimension: USAGE_DIMENSION, QuantityAsDecimal: String(count) };
}
