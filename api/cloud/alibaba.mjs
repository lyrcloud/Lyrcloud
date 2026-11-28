// Clusters, services and Linux servers in a customer's Alibaba Cloud account, over its OpenAPI (alibaba-api.mjs)
// with short-lived STS keys from federation.mjs. Same shapes as providers.mjs and servers.mjs:
//   serverless cluster  a Function Compute region (nothing to build); services are custom-container functions
//                       with a public HTTP trigger (https://….fcapp.run)
//   Kubernetes cluster  ACK managed (Pro) with one node pool, nodes with public IPs (no NAT gateway to pay for)
//   Linux server        an ECS instance with its own security group, the SSH key put in by cloud-init
// Networking: one VPC called "lyrcloud" per region (free), with a vSwitch per zone as needed.
import { randomBytes } from 'node:crypto';
import { AlibabaError, roa, rpc } from './alibaba-api.mjs';
import { KubeError, fromKubeconfig } from './kube.mjs';
import { ProviderError, remoteName } from './providers.mjs';

const ECS = '2014-05-26';
const VPC = '2016-04-28';
const CS = '2015-12-15';
const FC = '2023-03-30';
export const VPC_CIDR = '10.82.0.0/16';
const host = (service, region) => `${service}.${region}.aliyuncs.com`;
const fcHost = (ctx, region) => `${ctx.connection.accountId}.${region}.fc.aliyuncs.com`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Turns Alibaba errors into the messages the dashboard shows; the rest pass through.
async function guard(promise, what) {
  try {
    return await promise;
  } catch (err) {
    if (!(err instanceof AlibabaError)) throw err;
    if (/FC service is not enabled|ServiceNotEnable|NotOpen/i.test(err.message)) throw new ProviderError(400, 'Function Compute isn’t switched on in your Alibaba Cloud account. Run the setup script again, or open Function Compute once in the console.');
    if (/ErrorCheckRole|AliyunCS.*Role|RoleNotExist|EntityNotExist\.Role/i.test(err.message)) throw new ProviderError(400, 'Container Service for Kubernetes needs its one-time authorization: open cs.console.alibabacloud.com, accept the roles it asks for, then try again.');
    if (/InvalidPaymentMethod|NotEnoughBalance|InsufficientBalance|InDebt/i.test(err.message)) throw new ProviderError(402, 'Your Alibaba Cloud account needs a payment method or balance before it can create this.');
    throw new ProviderError(err.status === 403 ? 403 : 400, `${what}: ${err.message}`.slice(0, 500));
  }
}

// ================================================================ network

// The zones in a region where an ECS instance type is in stock, best first.
export async function zonesFor(ctx, region, instanceType) {
  const data = await rpc(ctx, host('ecs', region), ECS, 'DescribeAvailableResource', {
    RegionId: region, DestinationResource: 'InstanceType', InstanceType: instanceType, InstanceChargeType: 'PostPaid', IoOptimized: 'optimized', ResourceType: 'instance',
  });
  const zones = (data?.AvailableZones?.AvailableZone || []).filter((z) => z.Status === 'Available' && z.StatusCategory !== 'SoldOut').map((z) => z.ZoneId).sort();
  if (!zones.length) throw new ProviderError(400, `${instanceType} isn’t available in ${region} right now. Pick another size or region.`);
  return zones;
}

async function waitAvailable(read) {
  for (let i = 0; i < 12; i += 1) {
    const item = await read();
    if (item?.Status === 'Available') return item;
    await sleep(1000);
  }
  throw new ProviderError(503, 'Alibaba Cloud is still setting up the network. Try again in a minute.');
}

// The region's lyrcloud VPC and a vSwitch in each zone asked for (created the first time).
export async function network(ctx, region, zones) {
  const vpcHost = host('vpc', region);
  let vpc = (await rpc(ctx, vpcHost, VPC, 'DescribeVpcs', { RegionId: region, VpcName: 'lyrcloud' }))?.Vpcs?.Vpc?.[0];
  if (!vpc) {
    const { VpcId } = await rpc(ctx, vpcHost, VPC, 'CreateVpc', { RegionId: region, VpcName: 'lyrcloud', CidrBlock: VPC_CIDR, Description: 'Lyrcloud clusters and servers', ClientToken: `lyrcloud-vpc-${region}` });
    vpc = await waitAvailable(async () => (await rpc(ctx, vpcHost, VPC, 'DescribeVpcs', { RegionId: region, VpcId }))?.Vpcs?.Vpc?.[0]);
  }
  const existing = (await rpc(ctx, vpcHost, VPC, 'DescribeVSwitches', { RegionId: region, VpcId: vpc.VpcId, PageSize: 50 }))?.VSwitches?.VSwitch || [];
  const used = new Set(existing.map((v) => Number(String(v.CidrBlock).split('.')[2])));
  const vswitches = [];
  for (const zone of zones) {
    let vswitch = existing.find((v) => v.ZoneId === zone && v.VSwitchName === `lyrcloud-${zone}`);
    if (!vswitch) {
      let octet = 0;
      while (used.has(octet)) octet += 1;
      used.add(octet);
      const { VSwitchId } = await rpc(ctx, vpcHost, VPC, 'CreateVSwitch', { RegionId: region, VpcId: vpc.VpcId, ZoneId: zone, CidrBlock: `10.82.${octet}.0/24`, VSwitchName: `lyrcloud-${zone}` });
      vswitch = await waitAvailable(async () => (await rpc(ctx, vpcHost, VPC, 'DescribeVSwitches', { RegionId: region, VSwitchId }))?.VSwitches?.VSwitch?.[0]);
    }
    vswitches.push(vswitch.VSwitchId);
  }
  return { vpcId: vpc.VpcId, vswitches };
}

// ================================================================ Function Compute (serverless services)

export const FC_SIZES = { small: { cpu: 0.25, memorySize: 512 }, medium: { cpu: 0.5, memorySize: 1024 }, large: { cpu: 1, memorySize: 2048 }, xlarge: { cpu: 2, memorySize: 4096 } };
export const functionName = (cluster, service) => remoteName(['lyrcloud', cluster.name, service.name], 64);
const HTTP_TRIGGER = 'http';

export function functionBody(cluster, service, registry = null) {
  const port = service.port || 80;
  return {
    functionName: functionName(cluster, service),
    description: `Lyrcloud service ${service.name} on ${cluster.name}`,
    runtime: 'custom-container',
    handler: 'index.handler',
    ...(FC_SIZES[service.size] || FC_SIZES.small),
    diskSize: 512,
    timeout: 300,
    instanceConcurrency: 20,
    environmentVariables: service.env || {},
    customContainerConfig: {
      image: service.image,
      port,
      healthCheckConfig: { httpGetUrl: service.healthPath || '/', initialDelaySeconds: 1, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 6, successThreshold: 1 },
      ...(registry ? { registryConfig: { authConfig: { userName: registry.username.trim(), password: registry.password } } } : {}),
    },
    tags: [{ key: 'lyrcloud', value: 'managed' }],
  };
}

const fn = (ctx, cluster, method, path, action, body, query) => roa(ctx, fcHost(ctx, cluster.region), FC, method, `/${FC}/functions${path}`, action, body, query);

// Copies that are always warm: Function Compute's provisioned instances (count 0 scales to zero).
async function setWarm(ctx, cluster, name, count) {
  if (count > 0) await fn(ctx, cluster, 'PUT', `/${name}/provision-config`, 'PutProvisionConfig', { target: count }, { qualifier: 'LATEST' });
  else await fn(ctx, cluster, 'DELETE', `/${name}/provision-config`, 'DeleteProvisionConfig', null, { qualifier: 'LATEST' }).catch(() => null);
}

// ================================================================ ACK (Kubernetes)

export const ackName = (cluster) => remoteName(['lyrcloud', cluster.name], 63);
const ACK_STATES = { initial: 'creating', running: 'ready', updating: 'updating', scaling: 'updating', upgrading: 'updating', waiting: 'updating', removing: 'updating', migrating: 'updating', failed: 'failed', delete_failed: 'failed', deleting: 'deleting', deleted: 'deleted', stopped: 'failed', unavailable: 'failed' };

// Nobody logs in to the nodes with it (kubectl only); ACK just insists on a key pair or a password.
const nodePassword = () => `Ly${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}#7c`;

export function ackBody(cluster, net) {
  return {
    name: ackName(cluster),
    cluster_type: 'ManagedKubernetes',
    cluster_spec: 'ack.pro.small',
    region_id: cluster.region,
    vpcid: net.vpcId,
    vswitch_ids: net.vswitches,
    container_cidr: '172.20.0.0/16',
    service_cidr: '172.21.0.0/20',
    snat_entry: false,
    endpoint_public_access: true,
    is_enterprise_security_group: true,
    deletion_protection: false,
    addons: [{ name: 'flannel' }],
    tags: [{ key: 'lyrcloud', value: 'managed' }],
    nodepools: [{
      nodepool_info: { name: 'system' },
      scaling_group: {
        instance_types: [cluster.nodeType],
        vswitch_ids: net.vswitches,
        desired_size: cluster.nodes,
        system_disk_category: 'cloud_essd',
        system_disk_size: 40,
        image_type: 'AliyunLinux3',
        instance_charge_type: 'PostPaid',
        // A public IP per node so it can pull images from the internet without a NAT gateway.
        internet_charge_type: 'PayByTraffic',
        internet_max_bandwidth_out: 10,
        login_password: nodePassword(),
      },
    }],
  };
}

const ack = (ctx, cluster, method, path, action, body, query) => roa(ctx, host('cs', cluster.region), CS, method, path, action, body, query);

export const alibaba = {
  async verify(ctx) {
    // Any read proves the sign-in and the role's policies.
    await guard(rpc(ctx, host('ecs', 'us-east-1'), ECS, 'DescribeRegions', { RegionId: 'us-east-1' }), 'Lyrcloud signed in but can’t read ECS');
  },
  async createCluster(ctx, cluster) {
    if (cluster.kind === 'serverless') return { status: 'ready', outputs: { Account: ctx.connection.accountId } };
    const zones = (await guard(zonesFor(ctx, cluster.region, cluster.nodeType), 'Checking node stock')).slice(0, 2);
    const net = await guard(network(ctx, cluster.region, zones), 'Setting up the network');
    const data = await guard(ack(ctx, cluster, 'POST', '/clusters', 'CreateCluster', ackBody(cluster, net)), 'Alibaba Cloud refused the cluster');
    return { status: 'creating', outputs: { ClusterId: data.cluster_id, ClusterName: ackName(cluster), VpcId: net.vpcId } };
  },
  async refreshCluster(ctx, cluster) {
    if (cluster.kind === 'serverless') return { status: cluster.status === 'deleting' ? 'deleted' : 'ready', outputs: cluster.outputs };
    if (!cluster.outputs?.ClusterId) return { status: 'deleted' };
    const data = await guard(ack(ctx, cluster, 'GET', `/clusters/${cluster.outputs.ClusterId}`, 'DescribeClusterDetail'), 'Reading the cluster');
    if (!data) return { status: 'deleted' };
    const status = ACK_STATES[data.state] || 'updating';
    let endpoint = '';
    try {
      endpoint = JSON.parse(data.master_url || '{}').api_server_endpoint || '';
    } catch { /* not ready yet */ }
    return { status, outputs: { ...cluster.outputs, Endpoint: endpoint }, failureReason: status === 'failed' ? `ACK reports the cluster as ${data.state}. Open it in the Alibaba Cloud console for details.` : null };
  },
  async resizeCluster(ctx, cluster, nodes) {
    const id = cluster.outputs.ClusterId;
    const pools = (await guard(ack(ctx, cluster, 'GET', `/clusters/${id}/nodepools`, 'DescribeClusterNodePools'), 'Reading node pools'))?.nodepools || [];
    const pool = pools.find((p) => p.nodepool_info?.name === 'system') || pools[0];
    if (!pool) throw new ProviderError(409, 'The cluster has no node pool yet.');
    await guard(ack(ctx, cluster, 'PUT', `/clusters/${id}/nodepools/${pool.nodepool_info.nodepool_id}`, 'ModifyClusterNodePool', { scaling_group: { desired_size: nodes } }), 'Resizing');
    return { status: 'updating' };
  },
  async deleteCluster(ctx, cluster) {
    if (cluster.kind === 'serverless' || !cluster.outputs?.ClusterId) return { status: 'deleted' };
    const done = await guard(ack(ctx, cluster, 'DELETE', `/clusters/${cluster.outputs.ClusterId}`, 'DeleteCluster', null, { retain_all_resources: 'false' }), 'Deleting the cluster');
    return { status: done === null ? 'deleted' : 'deleting' };
  },
  async deployService(ctx, cluster, service, { create, registry }) {
    const name = functionName(cluster, service);
    const body = functionBody(cluster, service, service.privateRegistry ? registry : null);
    if (create) {
      await guard(fn(ctx, cluster, 'POST', '', 'CreateFunction', body), 'Function Compute refused the service');
      await guard(fn(ctx, cluster, 'POST', `/${name}/triggers`, 'CreateTrigger', {
        triggerName: HTTP_TRIGGER, triggerType: 'http', description: 'Public address (Lyrcloud)',
        triggerConfig: JSON.stringify({ authType: 'anonymous', methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH', 'OPTIONS'], disableURLInternet: false }),
      }), 'Making the service public');
    } else {
      const { functionName: _, ...changes } = body;
      // Without a new password the function keeps its stored registry login.
      if (service.privateRegistry && !registry) delete changes.customContainerConfig.registryConfig;
      await guard(fn(ctx, cluster, 'PUT', `/${name}`, 'UpdateFunction', changes), 'Function Compute refused the change');
    }
    await guard(setWarm(ctx, cluster, name, service.count ?? 1), 'Setting always-on copies');
    return { status: create ? 'creating' : 'updating' };
  },
  async refreshService(ctx, cluster, service) {
    const name = functionName(cluster, service);
    const data = await guard(fn(ctx, cluster, 'GET', `/${name}`, 'GetFunction'), 'Reading the service');
    if (!data) return { status: 'deleted' };
    const trigger = await fn(ctx, cluster, 'GET', `/${name}/triggers/${HTTP_TRIGGER}`, 'GetTrigger').catch(() => null);
    const outputs = { Url: trigger?.httpTrigger?.urlInternet || '' };
    if (data.state === 'Failed' || data.lastUpdateStatus === 'Failed') return { status: 'failed', outputs, failureReason: String(data.lastUpdateStatusReason || data.stateReason || 'Function Compute couldn’t start the container. Check the image and port.').slice(0, 500) };
    if (data.state === 'Pending' || data.lastUpdateStatus === 'InProgress') return { status: service.status === 'creating' ? 'creating' : 'updating', outputs };
    return { status: 'ready', public: true, outputs, failureReason: null };
  },
  async deleteService(ctx, cluster, service) {
    const name = functionName(cluster, service);
    await setWarm(ctx, cluster, name, 0);
    await fn(ctx, cluster, 'DELETE', `/${name}/triggers/${HTTP_TRIGGER}`, 'DeleteTrigger').catch((err) => (err instanceof AlibabaError ? null : Promise.reject(err)));
    await guard(fn(ctx, cluster, 'DELETE', `/${name}`, 'DeleteFunction'), 'Deleting the service');
    return { status: 'deleting' };
  },
  async kubeAccess(ctx, cluster) {
    const data = await guard(ack(ctx, cluster, 'GET', `/k8s/${cluster.outputs.ClusterId}/user_config`, 'DescribeClusterUserKubeconfig', null, { PrivateIpAddress: 'false' }), 'Reading the cluster’s credentials');
    if (!data?.config) throw new KubeError(409, 'The cluster isn’t running yet.');
    return fromKubeconfig(data.config);
  },
  kubectl: (cluster) => `aliyun cs GET /k8s/${cluster.outputs?.ClusterId || '<cluster-id>'}/user_config --region ${cluster.region} | jq -r .config > ~/.kube/config-${cluster.name}\nKUBECONFIG=~/.kube/config-${cluster.name} kubectl get nodes`,
};

// ================================================================ ECS (Linux servers)

export const ALIBABA_IMAGES = { ubuntu: 'ubuntu_24_04_x64*', debian: 'debian_12_*_x64*' };
export const ecsName = (server) => remoteName(['lyrcloud', server.name], 60);

// cloud-init: makes the image's usual user (ubuntu / admin) with the customer's key and sudo, like the other clouds.
export function userData(server, user) {
  return Buffer.from(`#cloud-config
users:
  - name: ${user}
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${server.sshKey}
ssh_pwauth: false
disable_root: true
`).toString('base64');
}

async function latestImage(ctx, region, image) {
  const data = await rpc(ctx, host('ecs', region), ECS, 'DescribeImages', { RegionId: region, ImageName: ALIBABA_IMAGES[image], ImageOwnerAlias: 'system', Architecture: 'x86_64', OSType: 'linux', Status: 'Available', PageSize: 50 });
  const images = (data?.Images?.Image || []).sort((a, b) => String(b.CreationTime).localeCompare(String(a.CreationTime)));
  if (!images[0]) throw new ProviderError(400, `No ${image} image in ${region}.`);
  return images[0].ImageId;
}

export function serverParams(server, { imageId, vswitchId, securityGroupId, instanceType, user, dryRun = false }) {
  return {
    RegionId: server.region, ImageId: imageId, InstanceType: instanceType, SecurityGroupId: securityGroupId, VSwitchId: vswitchId,
    InstanceName: ecsName(server), HostName: server.name, Description: `Lyrcloud server ${server.name}`,
    InstanceChargeType: 'PostPaid', InternetChargeType: 'PayByTraffic', InternetMaxBandwidthOut: 10,
    SystemDisk: { Category: 'cloud_essd', Size: 30 }, UserData: userData(server, user),
    Tag: [{ Key: 'lyrcloud', Value: 'managed' }], Amount: 1, ClientToken: `lyrcloud-${server.id}`, ...(dryRun ? { DryRun: true } : {}),
  };
}

const ECS_STATES = { Pending: 'creating', Starting: 'creating', Running: 'ready', Stopping: 'updating', Stopped: 'failed' };

export function alibabaServers({ sizes, user }) {
  return {
    async create(ctx, server) {
      const region = server.region;
      const ecsHost = host('ecs', region);
      const instanceType = sizes[server.size].alibaba;
      const [zone] = await guard(zonesFor(ctx, region, instanceType), 'Checking stock');
      const net = await guard(network(ctx, region, [zone]), 'Setting up the network');
      const { SecurityGroupId } = await guard(rpc(ctx, ecsHost, ECS, 'CreateSecurityGroup', {
        RegionId: region, VpcId: net.vpcId, SecurityGroupName: ecsName(server), Description: `Lyrcloud ${server.name}: SSH from ${server.sshFrom}, web from anywhere`, Tag: [{ Key: 'lyrcloud', Value: 'managed' }],
      }), 'Making the firewall');
      await guard(rpc(ctx, ecsHost, ECS, 'AuthorizeSecurityGroup', {
        RegionId: region, SecurityGroupId,
        Permissions: [['22', server.sshFrom], ['80', '0.0.0.0/0'], ['443', '0.0.0.0/0']].map(([port, from]) => ({ IpProtocol: 'tcp', PortRange: `${port}/${port}`, SourceCidrIp: from, Policy: 'accept' })),
      }), 'Opening the firewall');
      const imageId = await guard(latestImage(ctx, region, server.image), 'Finding the image');
      const data = await guard(rpc(ctx, ecsHost, ECS, 'RunInstances', serverParams(server, { imageId, vswitchId: net.vswitches[0], securityGroupId: SecurityGroupId, instanceType, user: user(server) })), 'Alibaba Cloud refused the server');
      return { status: 'creating', outputs: { InstanceId: data?.InstanceIdSets?.InstanceIdSet?.[0] || '', SecurityGroupId } };
    },
    async refresh(ctx, server) {
      const ecsHost = host('ecs', server.region);
      const id = server.outputs?.InstanceId;
      const instance = id ? (await guard(rpc(ctx, ecsHost, ECS, 'DescribeInstances', { RegionId: server.region, InstanceIds: JSON.stringify([id]) }), 'Reading the server'))?.Instances?.Instance?.[0] : null;
      if (!instance) {
        // Gone: its firewall goes too (it can only be deleted once nothing uses it).
        if (server.outputs?.SecurityGroupId) await rpc(ctx, ecsHost, ECS, 'DeleteSecurityGroup', { RegionId: server.region, SecurityGroupId: server.outputs.SecurityGroupId }).catch(() => null);
        return { status: 'deleted' };
      }
      if (server.status === 'deleting') return { status: 'deleting' };
      const status = ECS_STATES[instance.Status] || 'updating';
      return { status, outputs: { ...server.outputs, PublicIp: instance.PublicIpAddress?.IpAddress?.[0] || instance.EipAddress?.IpAddress || '' }, failureReason: status === 'failed' ? `The server is ${String(instance.Status).toLowerCase()}.` : null };
    },
    async remove(ctx, server) {
      if (server.outputs?.InstanceId) {
        await rpc(ctx, host('ecs', server.region), ECS, 'DeleteInstance', { InstanceId: server.outputs.InstanceId, Force: true }).catch((err) => {
          if (!(err instanceof AlibabaError && /NotFound/i.test(err.code))) throw new ProviderError(400, `Deleting the server: ${err.message}`);
        });
      }
      return { status: 'deleting' };
    },
  };
}

