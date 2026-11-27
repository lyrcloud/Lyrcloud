// Kubernetes from the dashboard: paste manifests (YAML, several separated by ---) and Lyrcloud applies them to
// a Kubernetes cluster with server-side apply, then lists what's running. Works on EKS, GKE and AKS:
//   EKS  a token from a presigned STS GetCallerIdentity (as the LyrcloudAccess role, which created the
//        cluster and so is its admin), checked against the cluster's own certificate
//   GKE  the lyrcloud-access service account's Google token (Kubernetes Engine Admin)
//   AKS  the cluster's admin credentials (listClusterAdminCredential, allowed by Contributor)
// Helm charts aren't run here; render them first (helm template) and paste the result.
import { request as httpsRequest } from 'node:https';

export const MANIFEST_MAX = 200_000;
export const DOCS_MAX = 50;

// kind -> [API group path, plural, namespaced]
export const KINDS = {
  Namespace: ['api/v1', 'namespaces', false],
  Pod: ['api/v1', 'pods', true],
  Service: ['api/v1', 'services', true],
  ConfigMap: ['api/v1', 'configmaps', true],
  Secret: ['api/v1', 'secrets', true],
  ServiceAccount: ['api/v1', 'serviceaccounts', true],
  PersistentVolumeClaim: ['api/v1', 'persistentvolumeclaims', true],
  Deployment: ['apis/apps/v1', 'deployments', true],
  StatefulSet: ['apis/apps/v1', 'statefulsets', true],
  DaemonSet: ['apis/apps/v1', 'daemonsets', true],
  Job: ['apis/batch/v1', 'jobs', true],
  CronJob: ['apis/batch/v1', 'cronjobs', true],
  Ingress: ['apis/networking.k8s.io/v1', 'ingresses', true],
  NetworkPolicy: ['apis/networking.k8s.io/v1', 'networkpolicies', true],
  HorizontalPodAutoscaler: ['apis/autoscaling/v2', 'horizontalpodautoscalers', true],
  PodDisruptionBudget: ['apis/policy/v1', 'poddisruptionbudgets', true],
  Role: ['apis/rbac.authorization.k8s.io/v1', 'roles', true],
  RoleBinding: ['apis/rbac.authorization.k8s.io/v1', 'rolebindings', true],
  ClusterRole: ['apis/rbac.authorization.k8s.io/v1', 'clusterroles', false],
  ClusterRoleBinding: ['apis/rbac.authorization.k8s.io/v1', 'clusterrolebindings', false],
};

export class KubeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const unquote = (value) => String(value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');

// Splits manifests and reads what apply needs from each: apiVersion, kind, metadata.name and namespace.
// A light reader for the header keys only; the YAML itself goes to Kubernetes unchanged.
export function parseManifests(text) {
  const source = String(text ?? '');
  if (!source.trim()) throw new KubeError(400, 'Paste at least one Kubernetes manifest.');
  if (source.length > MANIFEST_MAX) throw new KubeError(400, 'Manifests are limited to 200 KB at a time.');
  if (/^\s*[{[]/.test(source)) {
    let data;
    try {
      data = JSON.parse(source);
    } catch {
      throw new KubeError(400, 'That JSON isn’t valid.');
    }
    const items = Array.isArray(data) ? data : data.kind === 'List' ? data.items : [data];
    return items.map((item) => described(item?.apiVersion, item?.kind, item?.metadata?.name, item?.metadata?.namespace, JSON.stringify(item)));
  }
  const docs = source.split(/^---\s*$/m).map((doc) => doc.replace(/^\s*#.*$/gm, '')).filter((doc) => doc.trim());
  if (docs.length > DOCS_MAX) throw new KubeError(400, `At most ${DOCS_MAX} manifests at a time.`);
  return docs.map((doc) => {
    const top = (key) => unquote(doc.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]);
    const meta = doc.match(/^metadata:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] || '';
    const indent = meta.match(/^([ \t]+)\S/)?.[1] || '  ';
    const field = (key) => unquote(meta.match(new RegExp(`^${indent}${key}:\\s*(.+)$`, 'm'))?.[1]);
    return described(top('apiVersion'), top('kind'), field('name'), field('namespace'), doc);
  });
}

function described(apiVersion, kind, name, namespace, body) {
  const known = KINDS[kind];
  if (!kind || !apiVersion) throw new KubeError(400, 'Every manifest needs apiVersion and kind.');
  if (!known) throw new KubeError(400, `Lyrcloud can apply ${Object.keys(KINDS).join(', ')}; ${kind} isn’t one of them. Use kubectl for it.`);
  const expectedGroup = known[0].replace(/^apis?\//, '');
  if (apiVersion !== expectedGroup && !(known[0] === 'api/v1' && apiVersion === 'v1') && !(kind === 'HorizontalPodAutoscaler' && apiVersion === 'autoscaling/v1')) {
    throw new KubeError(400, `${kind} needs apiVersion ${known[0] === 'api/v1' ? 'v1' : expectedGroup} here.`);
  }
  if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(name || '')) throw new KubeError(400, `${kind} needs metadata.name (lowercase letters, digits, - and .).`);
  const ns = known[2] ? namespace || 'default' : null;
  if (ns && !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(ns)) throw new KubeError(400, `“${ns}” isn’t a valid namespace.`);
  return { apiVersion, kind, name, namespace: ns, body };
}

export function resourcePath({ kind, name, namespace, apiVersion }) {
  const [group, plural] = KINDS[kind];
  const base = kind === 'HorizontalPodAutoscaler' && apiVersion === 'autoscaling/v1' ? 'apis/autoscaling/v1' : group;
  return `/${base}/${namespace ? `namespaces/${namespace}/` : ''}${plural}/${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------- talking to the cluster

// One HTTPS call to the Kubernetes API, trusting only the cluster's own certificate authority.
export function kubeCall(conn, method, path, body, contentType = 'application/json') {
  const url = new URL(path, conn.server);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method,
      ca: conn.ca,
      cert: conn.cert,
      key: conn.key,
      timeout: 15_000,
      headers: { accept: 'application/json', ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}), ...(body ? { 'content-type': contentType } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          parsed = { message: data.slice(0, 300) };
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('The cluster didn’t answer in time.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// EKS: the token aws eks get-token makes, from the LyrcloudAccess role's credentials.
// The signer comes with the AWS SDK in the Lambda runtime; loaded here only, so a missing package can't
// stop the whole cloud API from starting.
export async function eksToken(credentials, region, clusterName) {
  const [{ SignatureV4 }, { Sha256 }] = await Promise.all([import('@smithy/signature-v4'), import('@aws-crypto/sha256-js')]);
  const signer = new SignatureV4({ credentials, region, service: 'sts', sha256: Sha256 });
  const signed = await signer.presign({
    method: 'GET', protocol: 'https:', hostname: `sts.${region}.amazonaws.com`, path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { host: `sts.${region}.amazonaws.com`, 'x-k8s-aws-id': clusterName },
  }, { expiresIn: 60 });
  const query = Object.entries(signed.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `k8s-aws-v1.${Buffer.from(`https://${signed.hostname}/?${query}`).toString('base64url')}`;
}

// AKS: server, CA and client certificate (or token) from the admin kubeconfig.
export function fromKubeconfig(yaml) {
  const get = (key) => yaml.match(new RegExp(`${key}:\\s*(\\S+)`))?.[1];
  const b64 = (key) => (get(key) ? Buffer.from(get(key), 'base64').toString('utf8') : undefined);
  const server = get('server');
  if (!server) throw new KubeError(502, 'The cluster’s credentials didn’t include its address.');
  return { server, ca: b64('certificate-authority-data'), cert: b64('client-certificate-data'), key: b64('client-key-data'), token: get('token') };
}

// Applies every manifest; returns one line per manifest (created / configured / error).
export async function applyManifests(conn, docs) {
  const results = [];
  for (const doc of docs) {
    const path = `${resourcePath(doc)}?fieldManager=lyrcloud&force=true`;
    const res = await kubeCall(conn, 'PATCH', path, doc.body, 'application/apply-patch+yaml').catch((err) => ({ status: 0, body: { message: err.message } }));
    results.push({
      kind: doc.kind, name: doc.name, namespace: doc.namespace,
      ok: res.status >= 200 && res.status < 300,
      result: res.status === 201 ? 'created' : res.status >= 200 && res.status < 300 ? 'applied' : (res.body.message || `HTTP ${res.status}`).slice(0, 300),
    });
  }
  return results;
}

// What's running: deployments (ready / wanted) and services (type and public address), outside kube-system.
export async function workloads(conn) {
  const [deployments, services] = await Promise.all([kubeCall(conn, 'GET', '/apis/apps/v1/deployments'), kubeCall(conn, 'GET', '/api/v1/services')]);
  if (deployments.status === 401 || deployments.status === 403) throw new KubeError(403, 'The cluster refused Lyrcloud’s sign-in.');
  const own = (item) => !['kube-system', 'kube-public', 'kube-node-lease', 'gmp-system', 'gke-managed-system', 'gke-gmp-system'].includes(item.metadata.namespace);
  return {
    deployments: (deployments.body.items || []).filter(own).map((d) => ({ namespace: d.metadata.namespace, name: d.metadata.name, ready: d.status?.readyReplicas || 0, wanted: d.spec?.replicas ?? 0, image: d.spec?.template?.spec?.containers?.[0]?.image || '' })),
    services: (services.body.items || []).filter(own).filter((s) => !(s.metadata.namespace === 'default' && s.metadata.name === 'kubernetes')).map((s) => ({
      namespace: s.metadata.namespace, name: s.metadata.name, type: s.spec?.type,
      address: s.status?.loadBalancer?.ingress?.map((i) => i.hostname || i.ip).filter(Boolean).join(', ') || '', ports: (s.spec?.ports || []).map((p) => p.port).join(', '),
    })),
  };
}
