// Keyless sign-in to customers' Google Cloud and Azure accounts. AWS STS signs a short-lived OIDC token for
// this Lambda (IAM outbound identity federation, GetWebIdentityToken); the customer's cloud trusts Lyrcloud's
// token issuer, and Google/Azure swap it for their own access token. No customer key is ever stored.
//
// One customer can't reach another's account:
//   Google Cloud  every token carries the tag lyrcloud_connection=<connection ID>, and the customer's
//                 workload identity provider only accepts tokens with their own ID (attribute condition).
//   Azure         federated credentials can't check custom claims, so Lyrcloud only ever works inside the
//                 resource group lyrcloud-<connection ID>, the only place the customer gave its app access.
//   Alibaba Cloud each connection has its own RAM OIDC provider whose only client ID (token audience) is
//                 lyrcloud-<connection ID>; the role trusts only that provider and audience.
import { connect } from 'node:tls';
import { GetWebIdentityTokenCommand } from '@aws-sdk/client-sts';

export const GCP_POOL = 'lyrcloud';
export const GCP_SERVICE_ACCOUNT = 'lyrcloud-access';
export const AZURE_AUDIENCE = 'api://AzureADTokenExchange';
export const CONNECTION_RE = /^lyr[a-f0-9]{10}$/;

export const azureGroup = (connectionId) => `lyrcloud-${connectionId}`;
// Alibaba Cloud: the OIDC provider, role and token audience are all named after the connection.
export const alibabaName = (connectionId) => `lyrcloud-${connectionId}`;
export const ALIBABA_POLICIES = ['AliyunFCFullAccess', 'AliyunCSFullAccess', 'AliyunECSFullAccess', 'AliyunVPCFullAccess', 'AliyunSLBFullAccess', 'AliyunEIPFullAccess'];
export const gcpProviderPath = (projectNumber, connectionId) =>
  `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${GCP_POOL}/providers/${connectionId}`;
export const gcpServiceAccount = (projectId) => `${GCP_SERVICE_ACCOUNT}@${projectId}.iam.gserviceaccount.com`;

export class FederationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A token from AWS STS saying "this is Lyrcloud, acting for connection <id>".
export async function awsToken(sts, audience, connectionId) {
  const { WebIdentityToken } = await sts.send(new GetWebIdentityTokenCommand({
    Audience: [audience], SigningAlgorithm: 'RS256', DurationSeconds: 300,
    Tags: [{ Key: 'lyrcloud_connection', Value: connectionId }],
  }));
  return WebIdentityToken;
}

// The issuer and subject customers' clouds must trust: read from a token of our own.
export async function identity(sts) {
  const token = await awsToken(sts, 'lyrcloud-setup', 'lyr0000000000');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  return { issuer: claims.iss, subject: claims.sub };
}

async function postForm(fetchImpl, url, form, what) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new FederationError(403, `${what}: ${data.error_description || data.error?.message || data.error || res.status}`.slice(0, 400));
  return data;
}

// Google Cloud: AWS token -> federated token (sts.googleapis.com) -> the lyrcloud-access service account's token.
export async function gcpAccessToken({ sts, fetchImpl = fetch }, connection) {
  const provider = gcpProviderPath(connection.projectNumber, connection.connectionId);
  const subject = await awsToken(sts, `https:${provider}`, connection.connectionId);
  const federated = await postForm(fetchImpl, 'https://sts.googleapis.com/v1/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', audience: provider, scope: 'https://www.googleapis.com/auth/cloud-platform',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token', subject_token: subject, subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  }, 'Google didn’t accept Lyrcloud’s sign-in. Run the setup script again in this project');
  const res = await fetchImpl(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${gcpServiceAccount(connection.projectId)}:generateAccessToken`, {
    method: 'POST', headers: { authorization: `Bearer ${federated.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '900s' }), signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new FederationError(403, `Lyrcloud signed in but can’t act as ${gcpServiceAccount(connection.projectId)}: ${data.error?.message || res.status}`.slice(0, 400));
  return data.accessToken;
}

// Azure: AWS token as the client assertion of the customer's Lyrcloud app (client credentials flow).
export async function azureAccessToken({ sts, fetchImpl = fetch }, connection) {
  const assertion = await awsToken(sts, AZURE_AUDIENCE, connection.connectionId);
  const data = await postForm(fetchImpl, `https://login.microsoftonline.com/${encodeURIComponent(connection.tenantId)}/oauth2/v2.0/token`, {
    client_id: connection.clientId, scope: 'https://management.azure.com/.default', grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion,
  }, 'Azure didn’t accept Lyrcloud’s sign-in. Check the tenant and client IDs, or run the setup script again');
  return data.access_token;
}

// Alibaba Cloud: AWS token -> AssumeRoleWithOIDC (an anonymous STS call: the token is the proof) -> STS keys.
export async function alibabaCredentials({ sts, fetchImpl = fetch }, connection) {
  const name = alibabaName(connection.connectionId);
  const token = await awsToken(sts, name, connection.connectionId);
  const params = new URLSearchParams({
    Action: 'AssumeRoleWithOIDC', Version: '2015-04-01', Format: 'JSON', Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    OIDCProviderArn: `acs:ram::${connection.accountId}:oidc-provider/${name}`, RoleArn: `acs:ram::${connection.accountId}:role/${name}`,
    RoleSessionName: 'lyrcloud', DurationSeconds: '900', OIDCToken: token,
  });
  const res = await fetchImpl('https://sts.aliyuncs.com/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(15_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.Credentials) throw new FederationError(403, `Alibaba Cloud didn’t accept Lyrcloud’s sign-in. Check the account ID, or run the setup script again: ${data.Code || res.status} ${data.Message || ''}`.trim().slice(0, 400));
  const c = data.Credentials;
  return { accessKeyId: c.AccessKeyId, accessKeySecret: c.AccessKeySecret, securityToken: c.SecurityToken };
}

// SHA-1 fingerprints of the issuer's certificate chain, for Alibaba's OIDC provider (up to five; leaf first).
export function issuerFingerprints(issuer, { connectImpl = connect } = {}) {
  const host = new URL(issuer).hostname;
  return new Promise((resolve, reject) => {
    const socket = connectImpl(443, host, { servername: host }, () => {
      const prints = [];
      for (let cert = socket.getPeerCertificate(true); cert?.fingerprint && !prints.includes(cert.fingerprint.replace(/:/g, '')) && prints.length < 5; cert = cert.issuerCertificate) {
        prints.push(cert.fingerprint.replace(/:/g, ''));
      }
      socket.end();
      resolve(prints);
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error('Timed out reading the token issuer’s certificate.')));
    socket.on('error', reject);
  });
}

// ---------------------------------------------------------------- setup scripts (pasted into Cloud Shell)

export function gcpSetupScript({ connectionId, issuer }) {
  const condition = `assertion['https://sts.amazonaws.com/'].request_tags.lyrcloud_connection == '${connectionId}'`;
  return `# Lyrcloud: connect this Google Cloud project (run in Cloud Shell, in the project you want to use)
set -e
PROJECT=$(gcloud config get-value project 2>/dev/null)
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA=${GCP_SERVICE_ACCOUNT}@$PROJECT.iam.gserviceaccount.com
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com run.googleapis.com container.googleapis.com compute.googleapis.com
gcloud iam workload-identity-pools describe ${GCP_POOL} --location=global >/dev/null 2>&1 || \\
  gcloud iam workload-identity-pools create ${GCP_POOL} --location=global --display-name=Lyrcloud
gcloud iam workload-identity-pools providers create-oidc ${connectionId} --location=global --workload-identity-pool=${GCP_POOL} \\
  --display-name="Lyrcloud ${connectionId}" --issuer-uri="${issuer}" \\
  --attribute-mapping="google.subject=assertion.sub,attribute.connection=assertion['https://sts.amazonaws.com/'].request_tags.lyrcloud_connection" \\
  --attribute-condition="${condition}"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || gcloud iam service-accounts create ${GCP_SERVICE_ACCOUNT} --display-name=Lyrcloud
for ROLE in roles/run.admin roles/container.admin roles/compute.instanceAdmin.v1 roles/compute.securityAdmin roles/iam.serviceAccountUser roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="$ROLE" --condition=None >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$SA" --role=roles/iam.workloadIdentityUser \\
  --member="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/${GCP_POOL}/attribute.connection/${connectionId}" >/dev/null
echo; echo "Done. Paste these into Lyrcloud:"; echo "  Project ID:     $PROJECT"; echo "  Project number: $NUMBER"
`;
}

export function azureSetupScript({ connectionId, issuer, subject, location = 'eastus' }) {
  const group = azureGroup(connectionId);
  const credential = JSON.stringify({ name: 'lyrcloud', issuer, subject, audiences: [AZURE_AUDIENCE] });
  return `# Lyrcloud: connect this Azure subscription (run in Azure Cloud Shell, Bash)
set -e
SUB=$(az account show --query id -o tsv); TENANT=$(az account show --query tenantId -o tsv)
for NS in Microsoft.App Microsoft.ContainerService Microsoft.OperationalInsights; do az provider register --namespace $NS >/dev/null; done
az group create --name ${group} --location ${location} >/dev/null
APP=$(az ad app create --display-name "Lyrcloud ${connectionId}" --query appId -o tsv)
az ad sp create --id "$APP" >/dev/null 2>&1 || true
az ad app federated-credential create --id "$APP" --parameters '${credential}' >/dev/null
sleep 30 # let the new app reach Azure's role service
az role assignment create --assignee "$APP" --role Contributor --scope "/subscriptions/$SUB/resourceGroups/${group}" >/dev/null
echo; echo "Done. Paste these into Lyrcloud:"; echo "  Tenant ID:       $TENANT"; echo "  Subscription ID: $SUB"; echo "  Client ID:       $APP"
`;
}

export function alibabaSetupScript({ connectionId, issuer, fingerprints }) {
  const name = alibabaName(connectionId);
  // Alibaba's trust policy language wants Version "1" and condition keys oidc:iss / oidc:aud.
  const trust = JSON.stringify({
    Version: '1',
    Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Federated: ['acs:ram::ACCOUNT:oidc-provider/' + name] }, Condition: { StringEquals: { 'oidc:iss': issuer, 'oidc:aud': name } } }],
  });
  return `# Lyrcloud: connect this Alibaba Cloud account (run in Cloud Shell: shell.alibabacloud.com)
set -e
ACCOUNT=$(aliyun sts GetCallerIdentity | sed -n 's/.*"AccountId": *"\\([0-9]*\\)".*/\\1/p')
# Switch on Function Compute and Container Service (both pay-as-you-go, nothing runs until you create it)
aliyun fc-open OpenFunctionComputeService --Type Open >/dev/null 2>&1 || true
aliyun cs POST /service/open --type propayasgo >/dev/null 2>&1 || true
aliyun ims CreateOIDCProvider --OIDCProviderName ${name} --IssuerUrl "${issuer}" \\
  --Fingerprints "${fingerprints.join(',')}" --ClientIds ${name} --Description "Lyrcloud ${connectionId}" >/dev/null
aliyun ram CreateRole --RoleName ${name} --Description "Lyrcloud builds here for connection ${connectionId}" --MaxSessionDuration 3600 \\
  --AssumeRolePolicyDocument "$(echo '${trust}' | sed "s/ACCOUNT/$ACCOUNT/")" >/dev/null
for POLICY in ${ALIBABA_POLICIES.join(' ')}; do
  aliyun ram AttachPolicyToRole --PolicyType System --PolicyName $POLICY --RoleName ${name} >/dev/null
done
echo; echo "Done. Paste this into Lyrcloud:"; echo "  Account ID: $ACCOUNT"
`;
}
