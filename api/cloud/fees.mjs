// How Lyrcloud earns from clusters in customers' own clouds: the cloud bills the customer for what runs, and
// Lyrcloud charges for managing it.
//   - Plan limits: how many clusters and services each Lyrcloud plan manages.
//   - Kubernetes management fee: $49 a month per Kubernetes cluster, paid with Lyrpay before Lyrcloud builds it
//     and renewed monthly. If it lapses, Lyrcloud stops changing the cluster (the customer's cluster keeps
//     running in their account; they can still delete it through Lyrcloud).
// Lyrcloud staff are exempt, so they can test.
export const CLOUD_LIMITS = {
  launch: { clusters: 1, kubernetes: 0, services: 2 },
  scale: { clusters: 3, kubernetes: 3, services: 10 },
  enterprise: { clusters: 20, kubernetes: 20, services: 50 },
};
export const KUBERNETES_FEE_CENTS = 4900;
export const RENEW_DAYS = 7; // "renew" shows this many days before the end

export const limitsFor = (plan) => CLOUD_LIMITS[plan] || CLOUD_LIMITS.launch;

// Why this plan can't add another cluster of this kind, or null.
export function clusterLimitError(plan, clusters, kind, staff = false) {
  if (staff) return null;
  const limits = limitsFor(plan);
  const live = clusters.filter((c) => c.status !== 'deleted');
  if (kind === 'kubernetes' && limits.kubernetes === 0) return [402, 'Kubernetes clusters need the Scale plan or higher. Upgrade on the Plans page, then try again.'];
  if (live.length >= limits.clusters) return [402, `Your plan manages up to ${limits.clusters} cluster${limits.clusters === 1 ? '' : 's'}. Upgrade on the Plans page for more.`];
  if (kind === 'kubernetes' && live.filter((c) => c.kind === 'kubernetes').length >= limits.kubernetes) return [402, `Your plan manages up to ${limits.kubernetes} Kubernetes clusters.`];
  return null;
}

export function serviceLimitError(plan, services, staff = false) {
  if (staff) return null;
  const { services: max } = limitsFor(plan);
  return services.filter((s) => s.status !== 'deleted').length >= max ? [402, `Your plan runs up to ${max} services across your clusters. Upgrade on the Plans page for more.`] : null;
}

// Whether Lyrcloud may change a cluster: Kubernetes needs its fee paid (or staff).
export function feeState(cluster, now = new Date(), staff = false) {
  if (cluster.kind !== 'kubernetes' || staff || cluster.feeExempt) return { needsFee: false, active: true };
  const paidThrough = cluster.paidThrough ? Date.parse(cluster.paidThrough) : 0;
  return {
    needsFee: true,
    active: paidThrough > now.getTime(),
    paidThrough: cluster.paidThrough || null,
    renewSoon: paidThrough - now.getTime() < RENEW_DAYS * 864e5,
    monthlyCents: KUBERNETES_FEE_CENTS,
  };
}

// One more month: from the end of the paid time if it hasn't run out, else from now.
export function addMonth(paidThrough, now = new Date()) {
  const start = paidThrough && Date.parse(paidThrough) > now.getTime() ? new Date(paidThrough) : new Date(now);
  const day = start.getUTCDate();
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()));
  next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  return next.toISOString();
}

export const feeReference = (clusterId, n) => `cloudk-${clusterId}-${n}`;
