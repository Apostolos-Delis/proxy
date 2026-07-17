import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, TreatMissingData, type AlarmProps } from "aws-cdk-lib/aws-cloudwatch";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  ContainerInsights,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDriver,
  OperatingSystemFamily,
  Secret as EcsSecret
} from "aws-cdk-lib/aws-ecs";
import { ApplicationProtocol, HttpCodeTarget, type ApplicationTargetGroup } from "aws-cdk-lib/aws-elasticloadbalancingv2";
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
      clusterName: resourceName(config, "cluster"),
      containerInsightsV2: ContainerInsights.ENHANCED
    });

    const logGroup = new LogGroup(this, "ProxyLogGroup", {
      logGroupName: `/aws/ecs/${resourceName(config, "proxy")}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy
    });
    const taskDefinition = new FargateTaskDefinition(this, "ProxyTaskDefinition", {
      family: resourceName(config, "proxy"),
      cpu: config.proxyCpu,
      memoryLimitMiB: config.proxyMemoryMiB,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX
      }
    });
    taskDefinition.addContainer("proxy", {
      image,
      command: ["pnpm", "start:prod:proxy"],
      enableRestartPolicy: true,
      restartAttemptPeriod: Duration.seconds(300),
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

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: config.minProxyCount,
      maxCapacity: config.maxProxyCount
    });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: config.proxyScaleTargetCpuPercent,
      scaleInCooldown: Duration.seconds(120),
      scaleOutCooldown: Duration.seconds(60)
    });
    scaling.scaleOnMemoryUtilization("MemoryScaling", {
      targetUtilizationPercent: config.proxyScaleTargetMemoryPercent,
      scaleInCooldown: Duration.seconds(120),
      scaleOutCooldown: Duration.seconds(60)
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
    createProxyAlarms(this, config, this.service, targetGroup);

    new CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new CfnOutput(this, "ProxyServiceName", { value: this.service.serviceName });
    new CfnOutput(this, "ProxyTargetGroupArn", {
      value: targetGroup.targetGroupArn
    });
  }
}

function createProxyAlarms(
  scope: Construct,
  config: ProxyEnvironmentConfig,
  service: FargateService,
  targetGroup: ApplicationTargetGroup
) {
  const period = Duration.minutes(5);
  new Alarm(scope, "ProxyHighCpuAlarm", namedAlarmProps({
    alarmName: resourceName(config, "proxy-high-cpu"),
    metric: service.metricCpuUtilization({ period }),
    threshold: 85,
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING
  }));
  new Alarm(scope, "ProxyHighMemoryAlarm", namedAlarmProps({
    alarmName: resourceName(config, "proxy-high-memory"),
    metric: service.metricMemoryUtilization({ period }),
    threshold: 85,
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING
  }));
  new Alarm(scope, "ProxyTarget5xxAlarm", namedAlarmProps({
    alarmName: resourceName(config, "proxy-target-5xx"),
    metric: targetGroup.metrics.httpCodeTarget(HttpCodeTarget.TARGET_5XX_COUNT, { period }),
    threshold: 5,
    evaluationPeriods: 2,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING
  }));
  new Alarm(scope, "ProxyTargetResponseTimeAlarm", namedAlarmProps({
    alarmName: resourceName(config, "proxy-target-response-time"),
    metric: targetGroup.metrics.targetResponseTime({ period, statistic: "p95" }),
    threshold: 30,
    evaluationPeriods: 3,
    datapointsToAlarm: 2,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING
  }));
  new Alarm(scope, "ProxyUnhealthyTargetsAlarm", namedAlarmProps({
    alarmName: resourceName(config, "proxy-unhealthy-targets"),
    metric: targetGroup.metrics.unhealthyHostCount({ period }),
    threshold: 1,
    evaluationPeriods: 2,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING
  }));
  new Alarm(scope, "ProxyRestartCountAlarm", namedAlarmProps({
    alarmName: resourceName(config, "proxy-restarts"),
    metric: new Metric({
      namespace: "ECS/ContainerInsights",
      metricName: "RestartCount",
      dimensionsMap: {
        ClusterName: service.cluster.clusterName,
        ServiceName: service.serviceName
      },
      statistic: "Sum",
      period
    }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING
  }));
}

function namedAlarmProps(props: AlarmProps & {
  readonly alarmName: string;
  readonly evaluationPeriods: number;
  readonly datapointsToAlarm?: number;
  readonly comparisonOperator?: ComparisonOperator;
  readonly treatMissingData?: TreatMissingData;
}): AlarmProps {
  return props;
}

export function runtimeEnvironment(config: ProxyEnvironmentConfig) {
  return {
    ADMIN_CORS_ORIGIN: "",
    ADMIN_DEV_LOGIN_ENABLED: "true",
    ADMIN_GRAPHIQL_ENABLED: config.envName === "prod" ? "false" : "true",
    ADMIN_SESSION_COOKIE_SECURE: "true",
    ADMIN_SESSION_COOKIE_NAME: "proxy_session",
    ADMIN_SESSION_TTL_SECONDS: "28800",
    ALLOW_DEV_PROXY_TOKEN_FALLBACK: "false",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
    GATEWAY_SEED_CLASSIFIER_MAX_ATTEMPTS: "2",
    GATEWAY_SEED_CLASSIFIER_MODEL: "gpt-5-nano-2025-08-07",
    GATEWAY_SEED_CLASSIFIER_TIMEOUT_MS: "30000",
    DB_POOL_MAX: String(config.databasePoolMax),
    DEFAULT_ORGANIZATION_ID: `proxy-${config.envName}`,
    DEBUG_ENDPOINTS_ENABLED: "false",
    EVENT_WRITER_BATCH_SIZE: String(config.eventWriterBatchSize),
    EVENT_WRITER_MAX_BYTES: String(config.eventWriterMaxBytes),
    EVENT_WRITER_MAX_ENTRIES: String(config.eventWriterMaxEntries),
    EVENT_WRITER_SHUTDOWN_TIMEOUT_MS: String(config.eventWriterShutdownTimeoutMs),
    LOG_LEVEL: "info",
    NODE_ENV: "production",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    PORT: "8787",
    REQUEST_BODY_LIMIT_BYTES: String(config.requestBodyLimitBytes),
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
