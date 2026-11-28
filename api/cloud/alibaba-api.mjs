// Alibaba Cloud OpenAPI over fetch, signed with ACS3-HMAC-SHA256 (the v3 signature): no SDK needed.
//   RPC style (ECS, VPC, STS, RAM): parameters in the query string, path "/".
//   ROA style (ACK "cs", Function Compute 3.0): a REST path and a JSON body.
// Credentials are { accessKeyId, accessKeySecret, securityToken? }; STS credentials carry the token.
import { createHash, createHmac, randomUUID } from 'node:crypto';

export class AlibabaError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
// RFC 3986 percent-encoding, as Alibaba's canonical query string wants it.
export const encode = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Flattens nested parameters the way RPC APIs read them: Tag.1.Key, SecurityGroupIds.1, …
export function flatten(params, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) value.forEach((item, i) => (item && typeof item === 'object' ? flatten(item, `${name}.${i + 1}`, out) : (out[`${name}.${i + 1}`] = String(item))));
    else if (typeof value === 'object') flatten(value, name, out);
    else out[name] = String(value);
  }
  return out;
}

export function canonicalQuery(query) {
  return Object.keys(query).sort().map((key) => `${encode(key)}=${encode(query[key])}`).join('&');
}

// Signs one request; returns the headers to send. `date` and `nonce` are only fixed by tests.
export function sign({ method, host, path = '/', query = {}, body = '', action, version, credentials, contentType, date, nonce }) {
  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-version': version,
    'x-acs-date': date || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': nonce || randomUUID(),
    'x-acs-content-sha256': sha256(body),
    ...(credentials.securityToken ? { 'x-acs-security-token': credentials.securityToken } : {}),
    ...(contentType ? { 'content-type': contentType } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalPath = path.split('/').map(encode).join('/');
  const request = [method, canonicalPath, canonicalQuery(query), canonicalHeaders, signedHeaders, headers['x-acs-content-sha256']].join('\n');
  const signature = createHmac('sha256', credentials.accessKeySecret).update(`ACS3-HMAC-SHA256\n${sha256(request)}`).digest('hex');
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${credentials.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return headers;
}

async function send(fetchImpl, { method, host, path, query, body, headers }) {
  const qs = canonicalQuery(query);
  const res = await fetchImpl(`https://${host}${path}${qs ? `?${qs}` : ''}`, { method, headers, body: body || undefined, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { Message: text.slice(0, 300) };
  }
  if (res.status === 404 && /NotFound|NotExist/i.test(data.Code || data.code || 'NotFound')) return null;
  if (!res.ok) {
    const code = data.Code || data.code || String(res.status);
    const message = data.Message || data.message || code;
    const status = res.status === 403 || res.status === 401 || /Forbidden|NoPermission|InvalidAccessKey|SignatureDoesNotMatch/i.test(code) ? 403 : res.status === 409 ? 409 : 400;
    throw new AlibabaError(status, `${code}: ${message}`.slice(0, 500), code);
  }
  return data;
}

// An RPC-style call, e.g. rpc(ctx, 'ecs.cn-hangzhou.aliyuncs.com', '2014-05-26', 'DescribeInstances', { RegionId: 'cn-hangzhou' }).
export function rpc({ credentials, fetchImpl = fetch }, host, version, action, params = {}) {
  const query = flatten(params);
  const headers = sign({ method: 'POST', host, query, action, version, credentials });
  return send(fetchImpl, { method: 'POST', host, path: '/', query, headers });
}

// A ROA-style call with a JSON body, e.g. roa(ctx, 'cs.cn-hangzhou.aliyuncs.com', '2015-12-15', 'POST', '/clusters', 'CreateCluster', {...}).
export function roa({ credentials, fetchImpl = fetch }, host, version, method, path, action, body = null, query = {}) {
  const payload = body ? JSON.stringify(body) : '';
  const headers = sign({ method, host, path, query, body: payload, action, version, credentials, contentType: body ? 'application/json' : undefined });
  return send(fetchImpl, { method, host, path, query, body: payload, headers });
}
