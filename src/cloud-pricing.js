// Cluster and service sizes with rough monthly cost estimates (on-demand prices in us-east-1, USD).
// Shared by the cloud API (api/cloud/rules.mjs) and the dashboard, so both show the same numbers.
// Other regions cost up to about 40% more; data transfer is extra.

// Kubernetes worker sizes, with on-demand prices in us-east-1 (USD/hour).
export const NODE_TYPES = {
  't3.small': { vcpu: 2, memory: 2, hourly: 0.0208 },
  't3.medium': { vcpu: 2, memory: 4, hourly: 0.0416 },
  't3.large': { vcpu: 2, memory: 8, hourly: 0.0832 },
  'm6i.large': { vcpu: 2, memory: 8, hourly: 0.096 },
  'c6i.large': { vcpu: 2, memory: 4, hourly: 0.085 },
  'm6i.xlarge': { vcpu: 4, memory: 16, hourly: 0.192 },
};
// Fargate task sizes (valid CPU/memory pairs).
export const SERVICE_SIZES = {
  small: { cpu: 256, memory: 512, label: '0.25 vCPU · 0.5 GB' },
  medium: { cpu: 512, memory: 1024, label: '0.5 vCPU · 1 GB' },
  large: { cpu: 1024, memory: 2048, label: '1 vCPU · 2 GB' },
  xlarge: { cpu: 2048, memory: 4096, label: '2 vCPU · 4 GB' },
};
const HOURS = 730;
const PRICES = {
  eksControlPlane: 0.10,
  publicIpv4: 0.005,
  fargateVcpu: 0.04048,
  fargateGb: 0.004445,
  albHourly: 0.0225,
  albLcuMinimum: 0.008, // one LCU, roughly what a quiet service uses
};

const money = (usd) => Math.round(usd * 100) / 100;

// Rough monthly cost (USD) of a cluster in us-east-1, before any services or data transfer.
export function clusterEstimate({ kind, nodeType = 't3.medium', nodes = 2 }) {
  if (kind === 'serverless') return { monthly: 0, lines: [['Fargate cluster', 0]] };
  const node = NODE_TYPES[nodeType];
  const lines = [
    ['Kubernetes control plane (EKS)', money(PRICES.eksControlPlane * HOURS)],
    [`${nodes} × ${nodeType} worker${nodes === 1 ? '' : 's'}`, money(node.hourly * HOURS * nodes)],
    [`${nodes} public IPv4 address${nodes === 1 ? '' : 'es'}`, money(PRICES.publicIpv4 * HOURS * nodes)],
  ];
  return { monthly: money(lines.reduce((sum, [, usd]) => sum + usd, 0)), lines };
}

// Rough monthly cost (USD) of a Fargate service in us-east-1.
export function serviceEstimate({ size = 'small', count = 1 }) {
  const { cpu, memory } = SERVICE_SIZES[size];
  const task = (cpu / 1024) * PRICES.fargateVcpu + (memory / 1024) * PRICES.fargateGb;
  const lines = [
    [`${count} × ${SERVICE_SIZES[size].label} container${count === 1 ? '' : 's'}`, money(task * HOURS * count)],
    [`${count} public IPv4 address${count === 1 ? '' : 'es'}`, money(PRICES.publicIpv4 * HOURS * count)],
    ['Load balancer', money((PRICES.albHourly + PRICES.albLcuMinimum) * HOURS)],
  ];
  return { monthly: money(lines.reduce((sum, [, usd]) => sum + usd, 0)), lines };
}
