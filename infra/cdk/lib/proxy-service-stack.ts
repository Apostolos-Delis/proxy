import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  OperatingSystemFamily,
  Secret as EcsSecret
} from "aws-cdk-lib/aws-ecs";
import { ApplicationProtocol } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { resourceName, type ProxyEnvironmentConfig } from "./config.js";
import type { ProxyDatabaseStack } from "./database-stack.js";
import type { ProxyFoundationStack } from "./foundation-stack.js";
import type { ProxyNetworkStack } from "./network-stack.js";
import type { ProxyRuntimeSecretsStack } from "./runtime-secrets-stack.js";

export type ProxyServiceStackProps = StackProps & {
  config: ProxyEnvironmentConfig;
  foundation: ProxyFoundationStack;
  network: ProxyNetworkStack;
  database: ProxyDatabaseStack;
  runtimeSecrets: ProxyRuntimeSecretsStack;
  runtimeImageTag: string;
};

export class ProxyServiceStack extends Stack {
  readonly cluster: Cluster;
  readonly service: FargateService;

  constructor(scope: Construct, id: string, props: ProxyServiceStackProps) {
    super(scope, id, props);

    const { config, database, foundation, network, runtimeImageTag, runtimeSecrets } = props;
    const removalPolicy = config.envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const image = ContainerImage.fromEcrRepository(foundation.proxyRepository, runtimeImageTag);

    this.cluster = new Cluster(this, "Cluster", {
      vpc: network.vpc,
      clusterName: resourceName(config, "cluster")
    });

    const logGroup = new LogGroup(this, "ProxyLogGroup", {
      logGroupName: `/aws/ecs/${resourceName(config, "proxy")}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy
    });
    const taskDefinition = new FargateTaskDefinition(this, "ProxyTaskDefinition", {
      family: resourceName(config, "proxy"),
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX
      }
    });
    taskDefinition.addContainer("proxy", {
      image,
      command: ["pnpm", "start:prod:proxy"],
      environment: runtimeEnvironment(config),
      secrets: runtimeSecretEnvironment(database, runtimeSecrets),
      portMappings: [{ containerPort: 8787 }],
      logging: LogDriver.awsLogs({
        streamPrefix: "proxy",
        logGroup
      })
    });

    this.service = new FargateService(this, "ProxyService", {
      cluster: this.cluster,
      serviceName: resourceName(config, "proxy"),
      taskDefinition,
      desiredCount: config.desiredProxyCount,
      assignPublicIp: true,
      securityGroups: [network.proxySecurityGroup],
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      healthCheckGracePeriod: Duration.seconds(60),
      minHealthyPercent: 100
    });

    const listener = network.loadBalancer.addListener("HttpListener", {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      open: false
    });
    const targetGroup = listener.addTargets("ProxyTargets", {
      protocol: ApplicationProtocol.HTTP,
      port: 8787,
      targets: [this.service],
      healthCheck: {
        path: "/healthz",
        healthyHttpCodes: "200",
        healthyThresholdCount: 2,
        timeout: Duration.seconds(10)
      }
    });

    new CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new CfnOutput(this, "ProxyServiceName", { value: this.service.serviceName });
    new CfnOutput(this, "ProxyTargetGroupArn", {
      value: targetGroup.targetGroupArn
    });
  }
}

export function runtimeEnvironment(config: ProxyEnvironmentConfig) {
  return {
    ADMIN_CORS_ORIGIN: "",
    ADMIN_DEV_LOGIN_ENABLED: config.envName === "prod" ? "false" : "true",
    ADMIN_GRAPHIQL_ENABLED: config.envName === "prod" ? "false" : "true",
    ADMIN_SESSION_COOKIE_SECURE: "true",
    ADMIN_SESSION_COOKIE_NAME: "proxy_session",
    ADMIN_SESSION_TTL_SECONDS: "28800",
    ALLOW_DEV_PROXY_TOKEN_FALLBACK: "false",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
    CLASSIFIER_ALLOW_REDACTED_EXCERPT: "false",
    CLASSIFIER_MAX_ATTEMPTS: "2",
    CLASSIFIER_MODEL: "gpt-5-nano-2025-08-07",
    CLASSIFIER_PROVIDER: "openai",
    CLASSIFIER_TIMEOUT_MS: "30000",
    DEFAULT_ORGANIZATION_ID: `proxy-${config.envName}`,
    DEBUG_ENDPOINTS_ENABLED: "false",
    LOG_LEVEL: "info",
    NODE_ENV: "production",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    PORT: "8787",
    SEED_REPLACE_ROUTING_CONFIG: "true",
    SEED_USER_ID: `proxy-${config.envName}-admin`
  };
}

export function runtimeSecretEnvironment(
  database: ProxyDatabaseStack,
  runtimeSecrets: ProxyRuntimeSecretsStack
) {
  return {
    ADMIN_DEV_LOGIN_EMAIL: EcsSecret.fromSecretsManager(runtimeSecrets.adminCredentialsSecret, "email"),
    ADMIN_DEV_LOGIN_PASSWORD: EcsSecret.fromSecretsManager(runtimeSecrets.adminCredentialsSecret, "password"),
    ANTHROPIC_API_KEY: EcsSecret.fromSecretsManager(runtimeSecrets.anthropicApiKeySecret),
    DATABASE_URL: EcsSecret.fromSecretsManager(database.databaseUrl),
    OPENAI_API_KEY: EcsSecret.fromSecretsManager(runtimeSecrets.openAiApiKeySecret),
    PROXY_TOKEN: EcsSecret.fromSecretsManager(runtimeSecrets.proxyTokenSecret)
  };
}
