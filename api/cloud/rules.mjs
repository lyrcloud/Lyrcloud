// Lyrcloud Cloud: pure rules. Validation, monthly cost estimates, and the CloudFormation templates
// Lyrcloud deploys into the customer's own AWS account (they own and pay for everything it creates).

export const CLUSTER_KINDS = ['kubernetes', 'serverless'];
export const MAX_CLUSTERS = 5;
export const MAX_SERVICES_PER_CLUSTER = 10;
// The role customers create in their account (access-role template) and the prefix for everything
// it may create in IAM.
export const ACCESS_ROLE_NAME = 'LyrcloudAccess';
export const IAM_PREFIX = 'lyrcloud-';

import { clusterEstimate, NODE_TYPES, serviceEstimate, SERVICE_SIZES } from '../../src/cloud-pricing.js';

export { clusterEstimate, NODE_TYPES, serviceEstimate, SERVICE_SIZES };
// Availability zones where EKS can't place a control plane (by zone ID, the same in every account).
export const EKS_UNSUPPORTED_ZONES = ['use1-az3', 'usw1-az2', 'cac1-az3'];

// ---------------------------------------------------------------- validation

const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const cleanName = (value) => {
  const name = String(value || '').trim().toLowerCase();
  return NAME_RE.test(name) && !name.includes('--') ? name : null;
};

export const ROLE_ARN_RE = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@\/-]{1,512}$/;
// Accepts the role ARN from the access stack's outputs, or just the 12-digit account ID.
export function roleArnFrom(input) {
  const text = String(input || '').trim();
  if (/^\d{12}$/.test(text)) return `arn:aws:iam::${text}:role/${ACCESS_ROLE_NAME}`;
  return ROLE_ARN_RE.test(text) ? text : null;
}

const PRINCIPAL_RE = /^arn:aws:(iam|sts)::\d{12}:(user|role|assumed-role)\/[\w+=,.@\/-]{1,512}$/;

// Returns [status, message] or null.
export function clusterError(body, region) {
  if (!body || typeof body !== 'object') return [400, 'Invalid JSON body.'];
  if (!cleanName(body.name)) return [400, 'Name the cluster with 3–32 lowercase letters, digits and hyphens, starting with a letter.'];
  if (body.provider !== 'aws') return [400, 'Only AWS clusters can be created right now.'];
  if (!region || region.provider !== 'aws') return [400, 'Pick an AWS region.'];
  if (!CLUSTER_KINDS.includes(body.kind)) return [400, 'Kind must be kubernetes or serverless.'];
  if (body.kind === 'kubernetes') {
    if (!NODE_TYPES[body.nodeType || 't3.medium']) return [400, `Node type must be one of ${Object.keys(NODE_TYPES).join(', ')}.`];
    const nodes = body.nodes ?? 2;
    if (!Number.isInteger(nodes) || nodes < 1 || nodes > 20) return [400, 'Use 1 to 20 worker nodes.'];
    if (!PRINCIPAL_RE.test(String(body.adminArn || '').trim())) return [400, 'Add the IAM user or role ARN that should administer the cluster (run: aws sts get-caller-identity).'];
  }
  return null;
}

const IMAGE_RE = /^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function serviceError(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') return [400, 'Invalid JSON body.'];
  if (!partial && !cleanName(body.name)) return [400, 'Name the service with 3–32 lowercase letters, digits and hyphens, starting with a letter.'];
  if ((!partial || 'image' in body) && !IMAGE_RE.test(String(body.image || '').trim())) return [400, 'Enter a container image, like nginx:latest or ghcr.io/you/app:1.2.'];
  if ((!partial || 'port' in body) && !(Number.isInteger(body.port ?? 80) && (body.port ?? 80) >= 1 && (body.port ?? 80) <= 65535)) return [400, 'Port must be 1 to 65535.'];
  if ('size' in body && !SERVICE_SIZES[body.size]) return [400, `Size must be one of ${Object.keys(SERVICE_SIZES).join(', ')}.`];
  if ('count' in body && !(Number.isInteger(body.count) && body.count >= 0 && body.count <= 20)) return [400, 'Run 0 to 20 copies.'];
  if ('healthPath' in body && !/^\/[\w./-]{0,200}$/.test(String(body.healthPath))) return [400, 'Health check path must start with /.'];
  if ('env' in body) {
    if (!body.env || typeof body.env !== 'object' || Array.isArray(body.env)) return [400, 'Environment must be an object of NAME: value.'];
    const entries = Object.entries(body.env);
    if (entries.length > 50) return [400, 'At most 50 environment variables.'];
    for (const [key, value] of entries) {
      if (!ENV_KEY_RE.test(key)) return [400, `“${key}” isn’t a valid variable name.`];
      if (typeof value !== 'string' || value.length > 4096) return [400, `${key} must be text of at most 4096 characters.`];
    }
  }
  return null;
}

// ---------------------------------------------------------------- CloudFormation status

// CloudFormation stack status -> what the dashboard shows.
export function stackState(status) {
  if (!status) return 'deleted';
  if (status === 'DELETE_COMPLETE') return 'deleted';
  if (status === 'DELETE_IN_PROGRESS') return 'deleting';
  if (status === 'DELETE_FAILED') return 'delete_failed';
  if (status.startsWith('UPDATE') && status.endsWith('_IN_PROGRESS')) return 'updating'; // includes an update rolling back
  if (status.endsWith('_IN_PROGRESS')) return status.includes('ROLLBACK') ? 'failed' : 'creating';
  if (status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE') return 'ready';
  if (status === 'UPDATE_ROLLBACK_COMPLETE') return 'ready'; // the update failed; the previous setup is back
  return 'failed';
}

// ---------------------------------------------------------------- templates

const tags = (name) => [{ Key: 'lyrcloud', Value: 'managed' }, { Key: 'Name', Value: name }];

// The role a customer creates so Lyrcloud can build clusters in their account. Everything it can touch in
// IAM is named lyrcloud-*; the ExternalId stops other Lyrcloud customers from using it.
export function accessRoleTemplate(lyrcloudAccountId) {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Lets Lyrcloud create and manage container clusters in this account. Delete this stack to revoke access.',
    Parameters: {
      ExternalId: { Type: 'String', MinLength: 16, Description: 'Your Lyrcloud connection ID (from the Lyrcloud dashboard). Keep it as given.' },
      LyrcloudAccountId: { Type: 'String', Default: lyrcloudAccountId, AllowedPattern: '\\d{12}' },
    },
    Resources: {
      Role: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: ACCESS_ROLE_NAME,
          Description: 'Lyrcloud manages container clusters (EKS, ECS) it created here. Delete the lyrcloud-access stack to revoke.',
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { AWS: { 'Fn::Sub': 'arn:aws:iam::${LyrcloudAccountId}:root' } },
              Action: 'sts:AssumeRole',
              Condition: { StringEquals: { 'sts:ExternalId': { Ref: 'ExternalId' } } },
            }],
          },
          Policies: [{
            PolicyName: 'LyrcloudClusters',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Sid: 'Build',
                  Effect: 'Allow',
                  Action: ['cloudformation:*', 'ec2:*', 'eks:*', 'ecs:*', 'elasticloadbalancing:*', 'autoscaling:*', 'logs:*', 'ssm:GetParameter', 'ssm:GetParameters', 'application-autoscaling:*'],
                  Resource: '*',
                },
                {
                  Sid: 'OwnRoles',
                  Effect: 'Allow',
                  Action: ['iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole', 'iam:TagRole', 'iam:UntagRole', 'iam:UpdateAssumeRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy',
                    'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:PassRole',
                    'iam:CreateInstanceProfile', 'iam:DeleteInstanceProfile', 'iam:GetInstanceProfile', 'iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile', 'iam:ListInstanceProfilesForRole'],
                  Resource: [{ 'Fn::Sub': `arn:aws:iam::\${AWS::AccountId}:role/${IAM_PREFIX}*` }, { 'Fn::Sub': `arn:aws:iam::\${AWS::AccountId}:instance-profile/${IAM_PREFIX}*` }],
                },
                {
                  Sid: 'ServiceLinkedRoles',
                  Effect: 'Allow',
                  Action: ['iam:CreateServiceLinkedRole', 'iam:GetRole'],
                  Resource: '*',
                  Condition: { StringLike: { 'iam:AWSServiceName': ['eks.amazonaws.com', 'eks-nodegroup.amazonaws.com', 'ecs.amazonaws.com', 'elasticloadbalancing.amazonaws.com', 'autoscaling.amazonaws.com'] } },
                },
              ],
            },
          }],
          Tags: [{ Key: 'lyrcloud', Value: 'access' }],
        },
      },
    },
    Outputs: { RoleArn: { Description: 'Paste this into the Lyrcloud dashboard.', Value: { 'Fn::GetAtt': ['Role', 'Arn'] } } },
  };
}

// A VPC with public subnets in the given zones (no NAT gateway, so nothing runs up a bill while idle).
function network(name, zones, { eks = false } = {}) {
  const resources = {
    Vpc: { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.40.0.0/16', EnableDnsSupport: true, EnableDnsHostnames: true, Tags: tags(`${name}-vpc`) } },
    Gateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: tags(`${name}-igw`) } },
    GatewayAttachment: { Type: 'AWS::EC2::VPCGatewayAttachment', Properties: { VpcId: { Ref: 'Vpc' }, InternetGatewayId: { Ref: 'Gateway' } } },
    Routes: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: { Ref: 'Vpc' }, Tags: tags(`${name}-public`) } },
    DefaultRoute: { Type: 'AWS::EC2::Route', DependsOn: 'GatewayAttachment', Properties: { RouteTableId: { Ref: 'Routes' }, DestinationCidrBlock: '0.0.0.0/0', GatewayId: { Ref: 'Gateway' } } },
  };
  zones.forEach((zone, i) => {
    resources[`Subnet${i}`] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: { Ref: 'Vpc' }, AvailabilityZone: zone, CidrBlock: `10.40.${i * 16}.0/20`, MapPublicIpOnLaunch: true,
        Tags: [...tags(`${name}-public-${zone}`), ...(eks ? [{ Key: 'kubernetes.io/role/elb', Value: '1' }] : [])],
      },
    };
    resources[`Subnet${i}Routes`] = { Type: 'AWS::EC2::SubnetRouteTableAssociation', Properties: { SubnetId: { Ref: `Subnet${i}` }, RouteTableId: { Ref: 'Routes' } } };
  });
  return resources;
}

const subnetRefs = (zones) => zones.map((_, i) => ({ Ref: `Subnet${i}` }));

// A cluster in the customer's account. `id` is short and unique (IAM names), `zones` are AZ names.
export function clusterTemplate({ id, name, kind, zones, nodeType = 't3.medium', nodes = 2, adminArn }) {
  const full = `lyrcloud-${name}`;
  const resources = network(full, zones, { eks: kind === 'kubernetes' });
  const outputs = {
    VpcId: { Value: { Ref: 'Vpc' } },
    SubnetIds: { Value: { 'Fn::Join': [',', subnetRefs(zones)] } },
  };
  if (kind === 'kubernetes') {
    Object.assign(resources, {
      ClusterRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: `${IAM_PREFIX}${id}-cluster`,
          AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'eks.amazonaws.com' }, Action: ['sts:AssumeRole', 'sts:TagSession'] }] },
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonEKSClusterPolicy'],
        },
      },
      NodeRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: `${IAM_PREFIX}${id}-node`,
          AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy', 'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy', 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly'],
        },
      },
      Cluster: {
        Type: 'AWS::EKS::Cluster',
        Properties: {
          Name: full,
          RoleArn: { 'Fn::GetAtt': ['ClusterRole', 'Arn'] },
          ResourcesVpcConfig: { SubnetIds: subnetRefs(zones), EndpointPublicAccess: true, EndpointPrivateAccess: true },
          AccessConfig: { AuthenticationMode: 'API_AND_CONFIG_MAP', BootstrapClusterCreatorAdminPermissions: true },
          Tags: tags(full),
        },
      },
      Nodes: {
        Type: 'AWS::EKS::Nodegroup',
        Properties: {
          ClusterName: { Ref: 'Cluster' },
          NodegroupName: `${full}-nodes`,
          NodeRole: { 'Fn::GetAtt': ['NodeRole', 'Arn'] },
          Subnets: subnetRefs(zones),
          InstanceTypes: [nodeType],
          AmiType: 'AL2023_x86_64_STANDARD',
          ScalingConfig: { MinSize: nodes, DesiredSize: nodes, MaxSize: Math.max(nodes, 1) },
          Tags: { lyrcloud: 'managed' },
        },
      },
      Admin: {
        Type: 'AWS::EKS::AccessEntry',
        Properties: {
          ClusterName: { Ref: 'Cluster' },
          PrincipalArn: adminArn,
          AccessPolicies: [{ PolicyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy', AccessScope: { Type: 'cluster' } }],
        },
      },
    });
    Object.assign(outputs, { ClusterName: { Value: { Ref: 'Cluster' } }, Endpoint: { Value: { 'Fn::GetAtt': ['Cluster', 'Endpoint'] } } });
  } else {
    Object.assign(resources, {
      Cluster: {
        Type: 'AWS::ECS::Cluster',
        Properties: {
          ClusterName: full,
          CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
          DefaultCapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
          Tags: tags(full),
        },
      },
      ExecutionRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: `${IAM_PREFIX}${id}-exec`,
          AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
        },
      },
    });
    Object.assign(outputs, { ClusterName: { Value: { Ref: 'Cluster' } }, ExecutionRoleArn: { Value: { 'Fn::GetAtt': ['ExecutionRole', 'Arn'] } } });
  }
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Lyrcloud ${kind === 'kubernetes' ? 'Kubernetes (EKS)' : 'serverless (ECS Fargate)'} cluster ${name}. Managed from the Lyrcloud dashboard.`,
    Resources: resources,
    Outputs: outputs,
  };
}

// A public container service on a serverless cluster: load balancer -> Fargate tasks.
export function serviceTemplate({ id, clusterName, vpcId, subnetIds, executionRoleArn, name, image, port = 80, size = 'small', count = 1, env = {}, healthPath = '/' }) {
  const { cpu, memory } = SERVICE_SIZES[size];
  // Load balancer and target group names: unique in the region and at most 32 characters.
  const full = `lyrcloud-${id}`;
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Lyrcloud service ${name} on ${clusterName}. Managed from the Lyrcloud dashboard.`,
    Resources: {
      Logs: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: `/lyrcloud/${clusterName}/${name}`, RetentionInDays: 14 } },
      BalancerSecurity: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: { GroupDescription: `${full} load balancer`, VpcId: vpcId, SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' }], Tags: tags(`${full}-lb`) },
      },
      TaskSecurity: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: `${full} containers`, VpcId: vpcId,
          SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: port, ToPort: port, SourceSecurityGroupId: { Ref: 'BalancerSecurity' } }],
          Tags: tags(`${full}-tasks`),
        },
      },
      Balancer: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: { Name: full, Scheme: 'internet-facing', Type: 'application', Subnets: subnetIds, SecurityGroups: [{ Ref: 'BalancerSecurity' }], Tags: tags(full) } },
      Targets: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          Name: full, VpcId: vpcId, Port: port, Protocol: 'HTTP', TargetType: 'ip',
          HealthCheckPath: healthPath, HealthCheckIntervalSeconds: 15, HealthyThresholdCount: 2, Matcher: { HttpCode: '200-399' },
          TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '15' }],
        },
      },
      Listener: { Type: 'AWS::ElasticLoadBalancingV2::Listener', Properties: { LoadBalancerArn: { Ref: 'Balancer' }, Port: 80, Protocol: 'HTTP', DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Targets' } }] } },
      Task: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Family: full, Cpu: String(cpu), Memory: String(memory), NetworkMode: 'awsvpc', RequiresCompatibilities: ['FARGATE'], ExecutionRoleArn: executionRoleArn,
          ContainerDefinitions: [{
            Name: name, Image: image, Essential: true,
            PortMappings: [{ ContainerPort: port, Protocol: 'tcp' }],
            Environment: Object.entries(env).map(([Name, Value]) => ({ Name, Value })),
            LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': { Ref: 'Logs' }, 'awslogs-region': { Ref: 'AWS::Region' }, 'awslogs-stream-prefix': name } },
          }],
        },
      },
      Service: {
        Type: 'AWS::ECS::Service',
        DependsOn: 'Listener',
        Properties: {
          ServiceName: name, Cluster: clusterName, TaskDefinition: { Ref: 'Task' }, DesiredCount: count,
          CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
          DeploymentConfiguration: { MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true } },
          NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'ENABLED', Subnets: subnetIds, SecurityGroups: [{ Ref: 'TaskSecurity' }] } },
          LoadBalancers: [{ ContainerName: name, ContainerPort: port, TargetGroupArn: { Ref: 'Targets' } }],
          HealthCheckGracePeriodSeconds: 30,
        },
      },
    },
    Outputs: { Url: { Value: { 'Fn::Sub': 'http://${Balancer.DNSName}' } } },
  };
}

// The CloudFormation console link that creates the access role with this customer's ExternalId filled in.
export function launchUrl(templateUrl, externalId) {
  const params = new URLSearchParams({ templateURL: templateUrl, stackName: 'lyrcloud-access', param_ExternalId: externalId });
  return `https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?${params}`;
}
