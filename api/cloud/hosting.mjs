// Lyrcloud managed hosting: customers run container apps on Lyrcloud's own AWS account, with no cloud account
// of their own, and pay Lyrcloud. Off until the super admin switches it on (feature "hosting") after running
// scripts/deploy-hosting.sh, which builds the shared base (infra/aws/hosting.yml) and stores its outputs.
//
// Three ways to pay (the customer picks per app):
//   monthly  a fixed price per size, paid with Lyrpay before the app is built; renewals add a month. Unpaid
//            for GRACE_DAYS after the end, the app is stopped (kept, so paying again restarts it).
//   plan     one small app is included with the Scale and Enterprise plans.
//   payg     pay as you go from prepaid Lyrcloud credit (bought with Lyrpay); the hourly run takes the app's
//            hourly price; at zero credit the app stops until more is bought.
//
//   GET    /cloud/hosting                       availability, prices, credit, your apps
//   POST   /cloud/hosting/apps                  { name, image, port?, size?, count?, env?, healthPath?, registry?, billing }
//   GET|PUT|DELETE /cloud/hosting/apps/{id}     an app; redeploy with changes; delete
//   POST   /cloud/hosting/apps/{id}/pay         a month of a monthly app (Lyrpay); /payment checks it
//   POST   /cloud/hosting/credit                { cents } buy credit (Lyrpay); /credit/check settles it
// Each app is a stack lyrcloud-app-<id>: target group, a listener rule keyed by a secret header, an ECS service
// and a CloudFront distribution that adds the header (the app's address is https://<id>.cloudfront.net).
export const HOSTING_SIZES = {
  small: { label: '0.25 vCPU · 0.5 GB', cpu: 256, memory: 512, monthlyCents: 1200, hourlyCents: 2 },
  medium: { label: '0.5 vCPU · 1 GB', cpu: 512, memory: 1024, monthlyCents: 2400, hourlyCents: 4 },
  large: { label: '1 vCPU · 2 GB', cpu: 1024, memory: 2048, monthlyCents: 4500, hourlyCents: 8 },
  xlarge: { label: '2 vCPU · 4 GB', cpu: 2048, memory: 4096, monthlyCents: 8900, hourlyCents: 15 },
};
export const BILLING_MODES = ['monthly', 'plan', 'payg'];
export const CREDIT_PACKS = [1000, 2500, 5000, 10000];
export const APPS_MAX = 10;
export const GRACE_DAYS = 3;
export const PLAN_INCLUDED = ['scale', 'enterprise'];

// Why this app can't be billed this way, or null.
export function billingError({ billing, size = 'small', count = 1 }, { plan, apps = [], credit = 0 }) {
  if (!BILLING_MODES.includes(billing)) return [400, 'Choose how to pay: monthly, included with your plan, or pay as you go.'];
  if (!HOSTING_SIZES[size]) return [400, `Size must be one of ${Object.keys(HOSTING_SIZES).join(', ')}.`];
  if (!Number.isInteger(count) || count < 1 || count > 3) return [400, 'Run 1 to 3 copies.'];
  if (apps.filter((a) => a.status !== 'deleted').length >= APPS_MAX) return [409, `You can host up to ${APPS_MAX} apps.`];
  if (billing === 'plan') {
    if (!PLAN_INCLUDED.includes(plan)) return [402, 'An app is included with the Scale and Enterprise plans. Upgrade, or pay monthly or as you go.'];
    if (size !== 'small' || count !== 1) return [400, 'The included app is one small copy. Pay monthly or as you go for bigger apps.'];
    if (apps.some((a) => a.billing === 'plan' && a.status !== 'deleted')) return [409, 'Your plan’s included app is already in use.'];
  }
  if (billing === 'payg' && credit < HOSTING_SIZES[size].hourlyCents * count * 24) return [402, 'Add Lyrcloud credit first: pay-as-you-go apps need at least a day’s worth.'];
  return null;
}

export const monthlyCents = ({ size, count = 1 }) => HOSTING_SIZES[size].monthlyCents * count;
export const hourlyCents = ({ size, count = 1 }) => HOSTING_SIZES[size].hourlyCents * count;

// The app's stack in Lyrcloud's account. `running` false sets the service to 0 copies (stopped, kept).
export function hostingAppTemplate(app, base, { running = true } = {}) {
  const full = `lyrcloud-app-${app.id}`;
  const { cpu, memory } = HOSTING_SIZES[app.size];
  const port = app.port || 80;
  const tags = [{ Key: 'lyrcloud', Value: 'hosting' }, { Key: 'lyrcloud:owner', Value: app.ownerId }];
  const registry = app.privateRegistry ? {
    RegistrySecret: { Type: 'AWS::SecretsManager::Secret', Properties: { Name: `${full}-registry`, SecretString: { Ref: 'RegistryLogin' }, Tags: tags } },
    RegistryAccess: { Type: 'AWS::IAM::Policy', Properties: { PolicyName: `${full}-registry`, Roles: [String(base.ExecutionRoleArn).split('/').pop()], PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: { Ref: 'RegistrySecret' } }] } } },
  } : {};
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Lyrcloud hosted app ${app.name} (${app.ownerEmail || app.ownerId}).`,
    ...(app.privateRegistry ? { Parameters: { RegistryLogin: { Type: 'String', NoEcho: true } } } : {}),
    Resources: {
      ...registry,
      Logs: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: `/lyrcloud/hosting/${app.id}`, RetentionInDays: 7 } },
      TaskSecurity: { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupDescription: `${full} containers`, VpcId: base.VpcId, SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: port, ToPort: port, SourceSecurityGroupId: base.BalancerSecurityGroup }], Tags: tags } },
      Targets: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          Name: `lyr-app-${app.id}`, VpcId: base.VpcId, Port: port, Protocol: 'HTTP', TargetType: 'ip',
          HealthCheckPath: app.healthPath || '/', HealthCheckIntervalSeconds: 15, HealthyThresholdCount: 2, Matcher: { HttpCode: '200-399' },
          TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '10' }],
        },
      },
      Rule: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: base.ListenerArn, Priority: app.priority,
          Conditions: [{ Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'x-lyr-app', Values: [app.token] } }],
          Actions: [{ Type: 'forward', TargetGroupArn: { Ref: 'Targets' } }],
        },
      },
      Task: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Family: full, Cpu: String(cpu), Memory: String(memory), NetworkMode: 'awsvpc', RequiresCompatibilities: ['FARGATE'], ExecutionRoleArn: base.ExecutionRoleArn,
          ContainerDefinitions: [{
            Name: 'app', Image: app.image, Essential: true,
            ...(app.privateRegistry ? { RepositoryCredentials: { CredentialsParameter: { Ref: 'RegistrySecret' } } } : {}),
            PortMappings: [{ ContainerPort: port, Protocol: 'tcp' }],
            Environment: Object.entries(app.env || {}).map(([Name, Value]) => ({ Name, Value })),
            LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': { Ref: 'Logs' }, 'awslogs-region': { Ref: 'AWS::Region' }, 'awslogs-stream-prefix': 'app' } },
          }],
          Tags: tags,
        },
      },
      Service: {
        Type: 'AWS::ECS::Service',
        DependsOn: app.privateRegistry ? ['Rule', 'RegistryAccess'] : 'Rule',
        Properties: {
          ServiceName: full, Cluster: base.ClusterName, TaskDefinition: { Ref: 'Task' }, DesiredCount: running ? app.count : 0,
          CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1 }],
          DeploymentConfiguration: { MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true } },
          NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'ENABLED', Subnets: String(base.SubnetIds).split(','), SecurityGroups: [{ Ref: 'TaskSecurity' }] } },
          LoadBalancers: [{ ContainerName: 'app', ContainerPort: port, TargetGroupArn: { Ref: 'Targets' } }],
          HealthCheckGracePeriodSeconds: 30, Tags: tags,
        },
      },
      Distribution: {
        Type: 'AWS::CloudFront::Distribution',
        Properties: {
          DistributionConfig: {
            Comment: `Lyrcloud hosted app ${app.id}`, Enabled: true, HttpVersion: 'http2and3', PriceClass: 'PriceClass_100',
            Origins: [{ Id: 'app', DomainName: base.BalancerDns, CustomOriginConfig: { OriginProtocolPolicy: 'http-only', HTTPPort: 80 }, OriginCustomHeaders: [{ HeaderName: 'x-lyr-app', HeaderValue: app.token }] }],
            DefaultCacheBehavior: {
              TargetOriginId: 'app', ViewerProtocolPolicy: 'redirect-to-https', Compress: true,
              AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'], CachedMethods: ['GET', 'HEAD'],
              CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // CachingDisabled: apps decide nothing is cached by default
              OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', // AllViewerExceptHostHeader
            },
          },
          Tags: tags,
        },
      },
    },
    Outputs: { Url: { Value: { 'Fn::Sub': 'https://${Distribution.DomainName}' } } },
  };
}
