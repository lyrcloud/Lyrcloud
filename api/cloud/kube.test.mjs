// Kubernetes manifests: reading them, the API paths they go to, and applying over HTTPS to a fake API server
// that has its own certificate authority (made with openssl for the test).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyManifests, fromKubeconfig, KubeError, parseManifests, resourcePath, workloads } from './kube.mjs';

const MANIFESTS = `# a web app
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  labels: { app: web }
spec:
  replicas: 2
---
apiVersion: v1
kind: Service
metadata:
    name: "web"
spec:
  type: LoadBalancer
---
apiVersion: v1
kind: Namespace
metadata:
  name: shop
`;

test('manifests: several per paste, names and namespaces read, unknown kinds refused', () => {
  const docs = parseManifests(MANIFESTS);
  assert.deepEqual(docs.map(({ kind, name, namespace }) => [kind, name, namespace]), [['Deployment', 'web', 'shop'], ['Service', 'web', 'default'], ['Namespace', 'shop', null]]);
  assert.deepEqual(docs.map(resourcePath), ['/apis/apps/v1/namespaces/shop/deployments/web', '/api/v1/namespaces/default/services/web', '/api/v1/namespaces/shop']);
  assert.match(docs[0].body, /replicas: 2/, 'the YAML goes to Kubernetes unchanged');
  const json = parseManifests(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg' } }] }));
  assert.equal(resourcePath(json[0]), '/api/v1/namespaces/default/configmaps/cfg');
  assert.throws(() => parseManifests('apiVersion: v1\nkind: Widget\nmetadata:\n  name: x\n'), KubeError);
  assert.throws(() => parseManifests('apiVersion: v1\nkind: Service\nmetadata:\n  name: Bad_Name\n'), KubeError);
  assert.throws(() => parseManifests('apiVersion: v1\nkind: Deployment\nmetadata:\n  name: web\n'), /apps\/v1/);
  assert.throws(() => parseManifests(''), KubeError);
});

test('an AKS kubeconfig gives the address, CA and client certificate', () => {
  const b = (text) => Buffer.from(text).toString('base64');
  const conn = fromKubeconfig(`clusters:\n- cluster:\n    certificate-authority-data: ${b('CA')}\n    server: https://kube.example:443\nusers:\n- user:\n    client-certificate-data: ${b('CERT')}\n    client-key-data: ${b('KEY')}\n`);
  assert.deepEqual(conn, { server: 'https://kube.example:443', ca: 'CA', cert: 'CERT', key: 'KEY', token: undefined });
});

test('applying talks to the cluster over HTTPS with its own CA, and lists what runs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kube-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  } catch {
    t.skip('openssl isn’t available');
    return;
  }
  const seen = [];
  const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer t0ken') return res.writeHead(401).end('{"message":"Unauthorized"}');
      if (req.url.startsWith('/api/v1/namespaces/default/services/web')) return res.writeHead(422).end('{"message":"Service \\"web\\" is invalid: spec.ports: Required value"}');
      if (req.url === '/apis/apps/v1/deployments') return res.end(JSON.stringify({ items: [{ metadata: { namespace: 'shop', name: 'web' }, spec: { replicas: 2, template: { spec: { containers: [{ image: 'nginx' }] } } }, status: { readyReplicas: 1 } }, { metadata: { namespace: 'kube-system', name: 'coredns' }, spec: {}, status: {} }] }));
      if (req.url === '/api/v1/services') return res.end(JSON.stringify({ items: [{ metadata: { namespace: 'default', name: 'kubernetes' }, spec: {} }, { metadata: { namespace: 'shop', name: 'web' }, spec: { type: 'LoadBalancer', ports: [{ port: 80 }] }, status: { loadBalancer: { ingress: [{ hostname: 'lb.example' }] } } }] }));
      res.writeHead(req.url.includes('/namespaces/shop/deployments/') ? 201 : 200).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const conn = { server: `https://localhost:${server.address().port}`, ca: readFileSync(join(dir, 'cert.pem'), 'utf8'), token: 't0ken' };
  try {
    const results = await applyManifests(conn, parseManifests(MANIFESTS));
    assert.deepEqual(results.map((r) => [r.kind, r.ok, r.result]), [['Deployment', true, 'created'], ['Service', false, 'Service "web" is invalid: spec.ports: Required value'], ['Namespace', true, 'applied']]);
    assert.equal(seen[0].method, 'PATCH');
    assert.equal(seen[0].type, 'application/apply-patch+yaml');
    assert.equal(seen[0].url, '/apis/apps/v1/namespaces/shop/deployments/web?fieldManager=lyrcloud&force=true');
    const running = await workloads(conn);
    assert.deepEqual(running.deployments, [{ namespace: 'shop', name: 'web', ready: 1, wanted: 2, image: 'nginx' }], 'system namespaces are left out');
    assert.deepEqual(running.services, [{ namespace: 'shop', name: 'web', type: 'LoadBalancer', address: 'lb.example', ports: '80' }]);
    // A server with a certificate the cluster's CA didn't sign is refused.
    const strange = await applyManifests({ ...conn, ca: undefined }, parseManifests(MANIFESTS).slice(0, 1));
    assert.equal(strange[0].ok, false);
    assert.match(strange[0].result, /certificate/i);
  } finally {
    server.close();
  }
});
