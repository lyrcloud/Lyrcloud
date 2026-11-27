// Linux servers (virtual machines) in the customer's own cloud, reached over SSH with their own key.
//   AWS           a CloudFormation stack: small VPC, security group, key pair and an EC2 instance
//   Google Cloud  a Compute Engine VM on the default network, with a lyrcloud-ssh firewall rule
//   Azure         an ARM deployment: shared lyrcloud VNet per region, an NSG, and a VM that owns its disk,
//                 network card and public IP (deleteOption: Delete), so deleting the VM removes them
// Statuses as for clusters: creating, ready, failed, deleting, deleted.
import { azureGroup } from './federation.mjs';
import { ProviderError, remoteName } from './providers.mjs';

export const IMAGES = {
  ubuntu: { label: 'Ubuntu 24.04 LTS', user: 'ubuntu' },
  debian: { label: 'Debian 12', user: 'admin' },
  'amazon-linux': { label: 'Amazon Linux 2023', user: 'ec2-user', only: 'aws' },
};
export const SERVER_SIZES = {
  small: { label: '2 vCPU · 2 GB', aws: 't3.small', gcp: 'e2-small', azure: 'Standard_B1ms', monthly: { aws: 15.2, gcp: 12.2, azure: 15.1 } },
  medium: { label: '2 vCPU · 4 GB', aws: 't3.medium', gcp: 'e2-medium', azure: 'Standard_B2s', monthly: { aws: 30.4, gcp: 24.5, azure: 30.4 } },
  large: { label: '2 vCPU · 8 GB', aws: 't3.large', gcp: 'e2-standard-2', azure: 'Standard_B2ms', monthly: { aws: 60.7, gcp: 48.9, azure: 60.7 } },
};
export const DISK_GB = 30;
export const SERVERS_LIMIT = { launch: 1, scale: 5, enterprise: 50 };

const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]{60,4000}( [^\n]{0,200})?$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;

// Returns [status, message] or null.
export function serverError(body, region) {
  if (!body || typeof body !== 'object') return [400, 'Invalid JSON body.'];
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(String(body.name || ''))) return [400, 'Name the server with 3–32 lowercase letters, digits and hyphens, starting with a letter.'];
  if (!['aws', 'gcp', 'azure'].includes(body.provider) || !region || region.provider !== body.provider) return [400, 'Pick a cloud you’ve connected and one of its regions.'];
  const image = IMAGES[body.image || 'ubuntu'];
  if (!image) return [400, `Image must be one of ${Object.keys(IMAGES).join(', ')}.`];
  if (image.only && image.only !== body.provider) return [400, `${image.label} runs on AWS only.`];
  if (!SERVER_SIZES[body.size || 'small']) return [400, `Size must be one of ${Object.keys(SERVER_SIZES).join(', ')}.`];
  if (!SSH_KEY_RE.test(String(body.sshKey || '').trim())) return [400, 'Paste your SSH public key (the one line in ~/.ssh/id_ed25519.pub, starting ssh-ed25519 or ssh-rsa).'];
  const from = String(body.sshFrom || '0.0.0.0/0').trim();
  if (!CIDR_RE.test(from) || from.split(/[./]/).slice(0, 4).some((n) => Number(n) > 255)) return [400, 'SSH access from must be an IPv4 range like 203.0.113.7/32, or 0.0.0.0/0 for anywhere.'];
  return null;
}

export const serverEstimate = ({ provider, size }) => ({ monthly: SERVER_SIZES[size]?.monthly[provider] ?? 0, lines: [[`${SERVER_SIZES[size]?.label} server`, SERVER_SIZES[size]?.monthly[provider] ?? 0], [`${DISK_GB} GB disk and a public IP`, provider === 'gcp' ? 4.2 : 6.1]] });

// ---------------------------------------------------------------- AWS (CloudFormation)

const AWS_AMIS = {
  ubuntu: '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
  debian: '/aws/service/debian/release/12/latest/amd64',
  'amazon-linux': '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
};

export function awsServerTemplate({ id, name, image = 'ubuntu', size = 'small', sshKey, sshFrom = '0.0.0.0/0' }) {
  const full = `lyrcloud-${id}`;
  const tag = (suffix = '') => [{ Key: 'Name', Value: `${full}${suffix}` }, { Key: 'lyrcloud', Value: 'managed' }];
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Lyrcloud Linux server ${name}. Managed from the Lyrcloud dashboard.`,
    Parameters: { Image: { Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>', Default: AWS_AMIS[image] } },
    Resources: {
      Vpc: { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.80.0.0/16', EnableDnsHostnames: true, EnableDnsSupport: true, Tags: tag() } },
      Gateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: tag() } },
      Attach: { Type: 'AWS::EC2::VPCGatewayAttachment', Properties: { VpcId: { Ref: 'Vpc' }, InternetGatewayId: { Ref: 'Gateway' } } },
      Subnet: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: { Ref: 'Vpc' }, CidrBlock: '10.80.0.0/24', MapPublicIpOnLaunch: true, AvailabilityZone: { 'Fn::Select': [0, { 'Fn::GetAZs': '' }] }, Tags: tag() } },
      Routes: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: { Ref: 'Vpc' }, Tags: tag() } },
      Internet: { Type: 'AWS::EC2::Route', DependsOn: 'Attach', Properties: { RouteTableId: { Ref: 'Routes' }, DestinationCidrBlock: '0.0.0.0/0', GatewayId: { Ref: 'Gateway' } } },
      SubnetRoutes: { Type: 'AWS::EC2::SubnetRouteTableAssociation', Properties: { SubnetId: { Ref: 'Subnet' }, RouteTableId: { Ref: 'Routes' } } },
      Firewall: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: `${full}: SSH from ${sshFrom}, web from anywhere`, VpcId: { Ref: 'Vpc' }, Tags: tag(),
          SecurityGroupIngress: [
            { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: sshFrom },
            { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
          ],
        },
      },
      Key: { Type: 'AWS::EC2::KeyPair', Properties: { KeyName: full, PublicKeyMaterial: String(sshKey).trim(), Tags: tag() } },
      Server: {
        Type: 'AWS::EC2::Instance',
        DependsOn: 'Internet',
        Properties: {
          ImageId: { Ref: 'Image' }, InstanceType: SERVER_SIZES[size].aws, KeyName: { Ref: 'Key' }, SubnetId: { Ref: 'Subnet' }, SecurityGroupIds: [{ Ref: 'Firewall' }],
          BlockDeviceMappings: [{ DeviceName: image === 'amazon-linux' ? '/dev/xvda' : '/dev/sda1', Ebs: { VolumeSize: DISK_GB, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true } }],
          MetadataOptions: { HttpTokens: 'required' },
          Tags: [{ Key: 'Name', Value: name }, { Key: 'lyrcloud', Value: 'managed' }],
        },
      },
    },
    Outputs: { PublicIp: { Value: { 'Fn::GetAtt': ['Server', 'PublicIp'] } }, InstanceId: { Value: { Ref: 'Server' } } },
  };
}

// ---------------------------------------------------------------- Google Cloud (Compute Engine)

const GCE = 'https://compute.googleapis.com/compute/v1';
const GCP_IMAGES = { ubuntu: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64', debian: 'projects/debian-cloud/global/images/family/debian-12' };
export const gcpZone = (region) => `${region}-b`;
export const vmName = (server) => remoteName(['lyrcloud', server.name], 60);

export function gceBody(server) {
  const zone = gcpZone(server.region);
  return {
    name: vmName(server),
    machineType: `zones/${zone}/machineTypes/${SERVER_SIZES[server.size].gcp}`,
    labels: { lyrcloud: 'managed' },
    tags: { items: ['lyrcloud-ssh'] },
    disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: GCP_IMAGES[server.image], diskSizeGb: String(DISK_GB) } }],
    networkInterfaces: [{ network: 'global/networks/default', accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }],
    metadata: { items: [{ key: 'ssh-keys', value: `${IMAGES[server.image].user}:${server.sshKey}` }] },
  };
}

const GCE_STATES = { PROVISIONING: 'creating', STAGING: 'creating', RUNNING: 'ready', STOPPING: 'deleting', SUSPENDING: 'updating', SUSPENDED: 'failed', TERMINATED: 'failed', REPAIRING: 'updating' };

async function gceCall(ctx, method, url, body) {
  const res = await (ctx.fetchImpl || fetch)(url, { method, headers: { authorization: `Bearer ${ctx.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(res.status === 409 && method === 'POST' && url.includes('/firewalls'))) throw new ProviderError(res.status === 403 ? 403 : 400, String(data.error?.message || res.status).slice(0, 500));
  return data;
}

export const gcpServers = {
  async create(ctx, server) {
    const project = `${GCE}/projects/${ctx.connection.projectId}`;
    // One firewall rule for every Lyrcloud server in the project (SSH from the first server's range, web from anywhere).
    if (!(await gceCall(ctx, 'GET', `${project}/global/firewalls/lyrcloud-ssh`))) {
      await gceCall(ctx, 'POST', `${project}/global/firewalls`, {
        name: 'lyrcloud-ssh', network: 'global/networks/default', direction: 'INGRESS', targetTags: ['lyrcloud-ssh'],
        allowed: [{ IPProtocol: 'tcp', ports: ['22', '80', '443'] }], sourceRanges: [server.sshFrom], description: 'Lyrcloud servers: SSH and web',
      });
    }
    await gceCall(ctx, 'POST', `${project}/zones/${gcpZone(server.region)}/instances`, gceBody(server));
    return { status: 'creating' };
  },
  async refresh(ctx, server) {
    const data = await gceCall(ctx, 'GET', `${GCE}/projects/${ctx.connection.projectId}/zones/${gcpZone(server.region)}/instances/${vmName(server)}`);
    if (!data) return { status: 'deleted' };
    const status = GCE_STATES[data.status] || 'updating';
    return { status, outputs: { PublicIp: data.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || '' }, failureReason: status === 'failed' ? `The server is ${data.status.toLowerCase()}.` : null };
  },
  async remove(ctx, server) {
    await gceCall(ctx, 'DELETE', `${GCE}/projects/${ctx.connection.projectId}/zones/${gcpZone(server.region)}/instances/${vmName(server)}`);
    return { status: 'deleting' };
  },
};

// ---------------------------------------------------------------- Azure (one ARM deployment)

const AZURE_IMAGES = {
  ubuntu: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: 'latest' },
  debian: { publisher: 'Debian', offer: 'debian-12', sku: '12-gen2', version: 'latest' },
};
const ARM = 'https://management.azure.com';
const groupUrl = (c) => `${ARM}/subscriptions/${c.subscriptionId}/resourceGroups/${azureGroup(c.connectionId)}`;

export function azureServerTemplate(server) {
  const vm = vmName(server);
  const vnet = `lyrcloud-net-${server.region}`;
  const user = IMAGES[server.image].user;
  const rule = (name, priority, port, from) => ({ name, properties: { priority, access: 'Allow', direction: 'Inbound', protocol: 'Tcp', sourceAddressPrefix: from, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: String(port) } });
  return {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    resources: [
      { type: 'Microsoft.Network/virtualNetworks', apiVersion: '2023-09-01', name: vnet, location: server.region, tags: { lyrcloud: 'managed' },
        properties: { addressSpace: { addressPrefixes: ['10.81.0.0/16'] }, subnets: [{ name: 'servers', properties: { addressPrefix: '10.81.0.0/24' } }] } },
      { type: 'Microsoft.Network/networkSecurityGroups', apiVersion: '2023-09-01', name: `${vm}-nsg`, location: server.region, tags: { lyrcloud: 'managed' },
        properties: { securityRules: [rule('ssh', 100, 22, server.sshFrom), rule('http', 110, 80, '*'), rule('https', 120, 443, '*')] } },
      {
        type: 'Microsoft.Compute/virtualMachines', apiVersion: '2024-03-01', name: vm, location: server.region, tags: { lyrcloud: 'managed' },
        dependsOn: [`[resourceId('Microsoft.Network/virtualNetworks', '${vnet}')]`, `[resourceId('Microsoft.Network/networkSecurityGroups', '${vm}-nsg')]`],
        properties: {
          hardwareProfile: { vmSize: SERVER_SIZES[server.size].azure },
          storageProfile: { imageReference: AZURE_IMAGES[server.image], osDisk: { createOption: 'FromImage', deleteOption: 'Delete', diskSizeGB: DISK_GB, managedDisk: { storageAccountType: 'StandardSSD_LRS' } } },
          osProfile: { computerName: server.name, adminUsername: user, linuxConfiguration: { disablePasswordAuthentication: true, ssh: { publicKeys: [{ path: `/home/${user}/.ssh/authorized_keys`, keyData: server.sshKey }] } } },
          networkProfile: {
            networkApiVersion: '2023-09-01',
            networkInterfaceConfigurations: [{
              name: `${vm}-nic`,
              properties: {
                primary: true, deleteOption: 'Delete',
                networkSecurityGroup: { id: `[resourceId('Microsoft.Network/networkSecurityGroups', '${vm}-nsg')]` },
                ipConfigurations: [{ name: 'ip', properties: { subnet: { id: `[resourceId('Microsoft.Network/virtualNetworks/subnets', '${vnet}', 'servers')]` }, publicIPAddressConfiguration: { name: `${vm}-ip`, properties: { deleteOption: 'Delete', publicIPAllocationMethod: 'Static' }, sku: { name: 'Standard' } } } }],
              },
            }],
          },
        },
      },
    ],
  };
}

const ARM_STATES = { Succeeded: 'ready', Failed: 'failed', Canceled: 'failed', Running: 'creating', Accepted: 'creating', Creating: 'creating', Deleting: 'deleting', Updating: 'updating' };

async function armCall(ctx, method, url, body) {
  const res = await (ctx.fetchImpl || fetch)(url, { method, headers: { authorization: `Bearer ${ctx.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(res.status === 403 ? 403 : 400, String(data.error?.message || res.status).slice(0, 500));
  return data;
}

export const azureServers = {
  async create(ctx, server) {
    await armCall(ctx, 'PUT', `${groupUrl(ctx.connection)}/providers/Microsoft.Resources/deployments/${vmName(server)}?api-version=2021-04-01`, { properties: { mode: 'Incremental', template: azureServerTemplate(server) } });
    return { status: 'creating' };
  },
  async refresh(ctx, server) {
    const base = groupUrl(ctx.connection);
    if (server.status === 'deleting') {
      // The VM takes its disk, card and IP with it; then its firewall goes (the regional network stays, free).
      if (await armCall(ctx, 'GET', `${base}/providers/Microsoft.Compute/virtualMachines/${vmName(server)}?api-version=2024-03-01`)) return { status: 'deleting' };
      await armCall(ctx, 'DELETE', `${base}/providers/Microsoft.Network/networkSecurityGroups/${vmName(server)}-nsg?api-version=2023-09-01`).catch(() => null);
      return { status: 'deleted' };
    }
    const deployment = await armCall(ctx, 'GET', `${base}/providers/Microsoft.Resources/deployments/${vmName(server)}?api-version=2021-04-01`);
    if (!deployment) return { status: 'deleted' };
    const status = ARM_STATES[deployment.properties?.provisioningState] || 'creating';
    if (status !== 'ready') return { status, failureReason: status === 'failed' ? String(deployment.properties?.error?.details?.[0]?.message || deployment.properties?.error?.message || 'Azure couldn’t create the server.').slice(0, 500) : null };
    const ip = await armCall(ctx, 'GET', `${base}/providers/Microsoft.Network/publicIPAddresses/${vmName(server)}-ip?api-version=2023-09-01`);
    return { status: 'ready', outputs: { PublicIp: ip?.properties?.ipAddress || '' }, failureReason: null };
  },
  async remove(ctx, server) {
    await armCall(ctx, 'DELETE', `${groupUrl(ctx.connection)}/providers/Microsoft.Compute/virtualMachines/${vmName(server)}?api-version=2024-03-01`);
    return { status: 'deleting' };
  },
};

export const SERVER_OPS = { gcp: gcpServers, azure: azureServers };
export const sshCommand = (server) => (server.outputs?.PublicIp ? `ssh ${IMAGES[server.image].user}@${server.outputs.PublicIp}` : null);
