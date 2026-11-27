// Clusters and services in customers' Google Cloud and Azure accounts, over each cloud's REST API with a
// short-lived token from federation.mjs. Same shapes as the AWS side (index.mjs), so the dashboard treats all
// providers alike:
//                 serverless cluster                       Kubernetes cluster
//   Google Cloud  a Cloud Run region (nothing to build)    GKE Autopilot (Google runs the nodes)
//   Azure         a Container Apps environment             AKS with a system node pool
// Services (serverless clusters only) are Cloud Run services / container apps with a public HTTPS address.
// Statuses: creating, updating, ready, failed, deleting, deleted.
import { azureGroup } from './federation.mjs';

export const GKE_API = 'https://container.googleapis.com/v1';
export const RUN_API = 'https://run.googleapis.com/v2';
export const ARM = 'https://management.azure.com';
const AKS_VERSION = '2024-09-01';
const APP_VERSION = '2024-03-01';
const GROUP_VERSION = '2021-04-01';

// Cloud Run and Container Apps sizes for the shared size names.
export const RUN_SIZES = { small: { cpu: '1', memory: '512Mi' }, medium: { cpu: '1', memory: '1Gi' }, large: { cpu: '1', memory: '2Gi' }, xlarge: { cpu: '2', memory: '4Gi' } };
export const ACA_SIZES = { small: { cpu: 0.25, memory: '0.5Gi' }, medium: { cpu: 0.5, memory: '1Gi' }, large: { cpu: 1, memory: '2Gi' }, xlarge: { cpu: 2, memory: '4Gi' } };

export class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// "nginx:latest" -> "docker.io/library/nginx:latest": Cloud Run and Container Apps want the registry spelled out.
export function fullImage(image) {
  const text = String(image).trim();
  const first = text.split('/')[0];
  if (text.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) return text;
  return `docker.io/${text.includes('/') ? text : `library/${text}`}`;
}

const envList = (env) => Object.entries(env || {}).map(([name, value]) => ({ name, value: String(value) }));
// Names inside the customer's cloud: lowercase, letters first, length limits per service.
export const remoteName = (parts, max) => parts.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, max).replace(/-+$/, '');

async function call(ctx, method, url, body) {
  const res = await (ctx.fetchImpl || fetch)(url, {
    method,
    headers: { authorization: `Bearer ${ctx.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || data.message || `${res.status}`;
    throw new ProviderError(res.status === 403 || res.status === 401 ? 403 : 400, String(message).slice(0, 500));
  }
  return data;
}

// ================================================================ Google Cloud

const gcpLocation = (c, cluster) => `projects/${c.projectId}/locations/${cluster.region}`;
export const gkeName = (cluster) => remoteName(['lyrcloud', cluster.name], 40);
export const runName = (cluster, service) => remoteName([cluster.name, service.name], 49);

export function gkeBody(cluster) {
  return { cluster: { name: gkeName(cluster), autopilot: { enabled: true }, releaseChannel: { channel: 'REGULAR' }, resourceLabels: { lyrcloud: 'managed' } } };
}

export function runBody(service) {
  const port = service.port || 80;
  return {
    labels: { lyrcloud: 'managed' },
    ingress: 'INGRESS_TRAFFIC_ALL',
    template: {
      scaling: { minInstanceCount: service.count, maxInstanceCount: Math.max(3, service.count) },
      containers: [{
        image: fullImage(service.image),
        ports: [{ containerPort: port }],
        env: envList(service.env),
        resources: { limits: RUN_SIZES[service.size] || RUN_SIZES.small },
        startupProbe: { httpGet: { path: service.healthPath || '/', port } },
      }],
    },
  };
}

const GKE_STATES = { PROVISIONING: 'creating', RUNNING: 'ready', RECONCILING: 'updating', STOPPING: 'deleting', ERROR: 'failed', DEGRADED: 'failed' };

export const gcp = {
  async verify(ctx) {
    // Any read in the project proves the sign-in and the service account's roles.
    await call(ctx, 'GET', `${RUN_API}/projects/${ctx.connection.projectId}/locations/us-central1/services?pageSize=1`);
  },
  async createCluster(ctx, cluster) {
    if (cluster.kind === 'serverless') return { status: 'ready', outputs: { Project: ctx.connection.projectId } };
    await call(ctx, 'POST', `${GKE_API}/${gcpLocation(ctx.connection, cluster)}/clusters`, gkeBody(cluster));
    return { status: 'creating', outputs: { ClusterName: gkeName(cluster), Project: ctx.connection.projectId } };
  },
  async refreshCluster(ctx, cluster) {
    if (cluster.kind === 'serverless') return { status: cluster.status === 'deleting' ? 'deleted' : 'ready', outputs: cluster.outputs };
    const data = await call(ctx, 'GET', `${GKE_API}/${gcpLocation(ctx.connection, cluster)}/clusters/${gkeName(cluster)}`);
    if (!data) return { status: 'deleted' };
    const status = GKE_STATES[data.status] || 'updating';
    return { status, outputs: { ...cluster.outputs, Endpoint: data.endpoint || '' }, failureReason: status === 'failed' ? data.statusMessage || 'GKE reported an error.' : null };
  },
  async resizeCluster() {
    throw new ProviderError(400, 'GKE Autopilot sizes itself to your pods; there are no nodes to resize.');
  },
  async deleteCluster(ctx, cluster) {
    if (cluster.kind === 'serverless') return { status: 'deleted' };
    await call(ctx, 'DELETE', `${GKE_API}/${gcpLocation(ctx.connection, cluster)}/clusters/${gkeName(cluster)}`);
    return { status: 'deleting' };
  },
  async deployService(ctx, cluster, service, { create }) {
    const base = `${RUN_API}/${gcpLocation(ctx.connection, cluster)}/services`;
    if (create) await call(ctx, 'POST', `${base}?serviceId=${runName(cluster, service)}`, runBody(service));
    else await call(ctx, 'PATCH', `${base}/${runName(cluster, service)}`, runBody(service));
    return { status: create ? 'creating' : 'updating' };
  },
  async refreshService(ctx, cluster, service) {
    const url = `${RUN_API}/${gcpLocation(ctx.connection, cluster)}/services/${runName(cluster, service)}`;
    const data = await call(ctx, 'GET', url);
    if (!data) return { status: 'deleted' };
    const state = data.terminalCondition?.state;
    if (data.reconciling || !state || state === 'CONDITION_PENDING' || state === 'CONDITION_RECONCILING') return { status: service.status === 'creating' ? 'creating' : 'updating', outputs: { Url: data.uri || '' } };
    if (state === 'CONDITION_FAILED') return { status: 'failed', failureReason: data.terminalCondition.message || 'Cloud Run couldn’t start the container.', outputs: { Url: data.uri || '' } };
    // Ready: open it to the internet once (anyone can call it, like the AWS load balancer).
    if (!service.public) {
      await call(ctx, 'POST', `${url}:setIamPolicy`, { policy: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] } }).catch((err) => {
        throw new ProviderError(400, `The service runs, but Google refused to make it public (an organization policy may block “allUsers”): ${err.message}`);
      });
    }
    return { status: 'ready', public: true, outputs: { Url: data.uri || '' }, failureReason: null };
  },
  async deleteService(ctx, cluster, service) {
    await call(ctx, 'DELETE', `${RUN_API}/${gcpLocation(ctx.connection, cluster)}/services/${runName(cluster, service)}`);
    return { status: 'deleting' };
  },
  kubectl: (cluster, connection) => `gcloud container clusters get-credentials ${gkeName(cluster)} --region ${cluster.region} --project ${connection.projectId}\nkubectl get nodes`,
};

// ================================================================ Azure

const groupUrl = (c) => `${ARM}/subscriptions/${c.subscriptionId}/resourceGroups/${azureGroup(c.connectionId)}`;
export const aksName = (cluster) => remoteName(['lyrcloud', cluster.name], 63);
export const envName = (cluster) => remoteName(['lyrcloud', cluster.name], 60);
export const appName = (cluster, service) => remoteName([cluster.name, service.name], 32);

export function aksBody(cluster) {
  return {
    location: cluster.region,
    tags: { lyrcloud: 'managed' },
    identity: { type: 'SystemAssigned' },
    sku: { name: 'Base', tier: 'Free' },
    properties: {
      dnsPrefix: remoteName(['lyr', cluster.name], 54),
      agentPoolProfiles: [{ name: 'system', mode: 'System', osType: 'Linux', type: 'VirtualMachineScaleSets', count: cluster.nodes, vmSize: cluster.nodeType }],
    },
  };
}

export function containerAppBody(cluster, service) {
  const port = service.port || 80;
  return {
    location: cluster.region,
    tags: { lyrcloud: 'managed' },
    properties: {
      environmentId: cluster.outputs.EnvironmentId,
      workloadProfileName: 'Consumption',
      configuration: { ingress: { external: true, targetPort: port, transport: 'auto' } },
      template: {
        containers: [{
          name: 'app',
          image: fullImage(service.image),
          env: envList(service.env),
          resources: ACA_SIZES[service.size] || ACA_SIZES.small,
          probes: [{ type: 'Startup', httpGet: { path: service.healthPath || '/', port } }],
        }],
        scale: { minReplicas: service.count, maxReplicas: Math.max(3, service.count) },
      },
    },
  };
}

const ARM_STATES = { Succeeded: 'ready', Failed: 'failed', Canceled: 'failed', Deleting: 'deleting', Creating: 'creating', InProgress: 'creating', Updating: 'updating', Scaling: 'updating', Upgrading: 'updating', Starting: 'updating', ScheduledForDelete: 'deleting' };
const armState = (data, fallback) => ARM_STATES[data?.properties?.provisioningState] || fallback;

export const azure = {
  async verify(ctx) {
    const group = await call(ctx, 'GET', `${groupUrl(ctx.connection)}?api-version=${GROUP_VERSION}`);
    if (!group) throw new ProviderError(403, `Lyrcloud can’t see the resource group ${azureGroup(ctx.connection.connectionId)}. Run the setup script again; it must use your connection ID.`);
  },
  async createCluster(ctx, cluster) {
    if (cluster.kind === 'kubernetes') {
      await call(ctx, 'PUT', `${groupUrl(ctx.connection)}/providers/Microsoft.ContainerService/managedClusters/${aksName(cluster)}?api-version=${AKS_VERSION}`, aksBody(cluster));
      return { status: 'creating', outputs: { ClusterName: aksName(cluster), ResourceGroup: azureGroup(ctx.connection.connectionId) } };
    }
    const data = await call(ctx, 'PUT', `${groupUrl(ctx.connection)}/providers/Microsoft.App/managedEnvironments/${envName(cluster)}?api-version=${APP_VERSION}`, {
      location: cluster.region, tags: { lyrcloud: 'managed' }, properties: { workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }] },
    });
    return { status: 'creating', outputs: { EnvironmentId: data?.id || `/subscriptions/${ctx.connection.subscriptionId}/resourceGroups/${azureGroup(ctx.connection.connectionId)}/providers/Microsoft.App/managedEnvironments/${envName(cluster)}`, ResourceGroup: azureGroup(ctx.connection.connectionId) } };
  },
  async refreshCluster(ctx, cluster) {
    const url = cluster.kind === 'kubernetes'
      ? `${groupUrl(ctx.connection)}/providers/Microsoft.ContainerService/managedClusters/${aksName(cluster)}?api-version=${AKS_VERSION}`
      : `${groupUrl(ctx.connection)}/providers/Microsoft.App/managedEnvironments/${envName(cluster)}?api-version=${APP_VERSION}`;
    const data = await call(ctx, 'GET', url);
    if (!data) return { status: 'deleted' };
    const status = armState(data, 'updating');
    return { status, outputs: { ...cluster.outputs, ...(data.properties?.fqdn ? { Endpoint: data.properties.fqdn } : {}) }, failureReason: status === 'failed' ? 'Azure couldn’t finish it. Open the resource group in the Azure portal for details.' : null };
  },
  async resizeCluster(ctx, cluster, nodes) {
    await call(ctx, 'PUT', `${groupUrl(ctx.connection)}/providers/Microsoft.ContainerService/managedClusters/${aksName(cluster)}/agentPools/system?api-version=${AKS_VERSION}`, {
      properties: { count: nodes, vmSize: cluster.nodeType, mode: 'System', osType: 'Linux', type: 'VirtualMachineScaleSets' },
    });
    return { status: 'updating' };
  },
  async deleteCluster(ctx, cluster) {
    const url = cluster.kind === 'kubernetes'
      ? `${groupUrl(ctx.connection)}/providers/Microsoft.ContainerService/managedClusters/${aksName(cluster)}?api-version=${AKS_VERSION}`
      : `${groupUrl(ctx.connection)}/providers/Microsoft.App/managedEnvironments/${envName(cluster)}?api-version=${APP_VERSION}`;
    await call(ctx, 'DELETE', url);
    return { status: 'deleting' };
  },
  async deployService(ctx, cluster, service, { create }) {
    await call(ctx, 'PUT', `${groupUrl(ctx.connection)}/providers/Microsoft.App/containerApps/${appName(cluster, service)}?api-version=${APP_VERSION}`, containerAppBody(cluster, service));
    return { status: create ? 'creating' : 'updating' };
  },
  async refreshService(ctx, cluster, service) {
    const data = await call(ctx, 'GET', `${groupUrl(ctx.connection)}/providers/Microsoft.App/containerApps/${appName(cluster, service)}?api-version=${APP_VERSION}`);
    if (!data) return { status: 'deleted' };
    const status = armState(data, 'updating');
    const fqdn = data.properties?.configuration?.ingress?.fqdn;
    return { status, outputs: { Url: fqdn ? `https://${fqdn}` : '' }, failureReason: status === 'failed' ? 'Azure couldn’t start the container. Check the image name and port.' : null };
  },
  async deleteService(ctx, cluster, service) {
    await call(ctx, 'DELETE', `${groupUrl(ctx.connection)}/providers/Microsoft.App/containerApps/${appName(cluster, service)}?api-version=${APP_VERSION}`);
    return { status: 'deleting' };
  },
  kubectl: (cluster, connection) => `az aks get-credentials --resource-group ${azureGroup(connection.connectionId)} --name ${aksName(cluster)} --subscription ${connection.subscriptionId}\nkubectl get nodes`,
};

export const PROVIDER_OPS = { gcp, azure };
