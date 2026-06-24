import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateTaskDefinition,
  LogDriver,
  OperatingSystemFamily
} from "aws-cdk-lib/aws-ecs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { resourceName, type ProxyEnvironmentConfig } from "./config.js";
import type { ProxyDatabaseStack } from "./database-stack.js";
import type { ProxyFoundationStack } from "./foundation-stack.js";
import type { ProxyNetworkStack } from "./network-stack.js";
import { runtimeEnvironment, runtimeSecretEnvironment } from "./proxy-service-stack.js";
import type { ProxyRuntimeSecretsStack } from "./runtime-secrets-stack.js";

export type ProxyOperationsStackProps = StackProps & {
  config: ProxyEnvironmentConfig;
  foundation: ProxyFoundationStack;
  network: ProxyNetworkStack;
  database: ProxyDatabaseStack;
  runtimeSecrets: ProxyRuntimeSecretsStack;
  runtimeImageTag: string;
};

export class ProxyOperationsStack extends Stack {
  readonly cluster: Cluster;
  readonly migrationTaskDefinition: FargateTaskDefinition;
  readonly seedTaskDefinition: FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: ProxyOperationsStackProps) {
    super(scope, id, props);

    const { config, database, foundation, network, runtimeImageTag, runtimeSecrets } = props;
    const removalPolicy = config.envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const image = ContainerImage.fromEcrRepository(foundation.proxyRepository, runtimeImageTag);

    this.cluster = new Cluster(this, "OperationsCluster", {
      vpc: network.vpc,
      clusterName: resourceName(config, "operations-cluster")
    });
    this.migrationTaskDefinition = new FargateTaskDefinition(this, "MigrationTaskDefinition", {
      family: resourceName(config, "operations-task"),
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: runtimePlatform()
    });
    this.seedTaskDefinition = new FargateTaskDefinition(this, "SeedTaskDefinition", {
      family: resourceName(config, "seed-task"),
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: runtimePlatform()
    });

    const logGroup = new LogGroup(this, "OperationsLogGroup", {
      logGroupName: `/aws/ecs/${resourceName(config, "operations")}`,
      retention: RetentionDays.ONE_WEEK,
      removalPolicy
    });
    this.migrationTaskDefinition.addContainer("migrate", {
      image,
      command: ["pnpm", "db:migrate"],
      environment: runtimeEnvironment(config),
      secrets: runtimeSecretEnvironment(database, runtimeSecrets),
      logging: LogDriver.awsLogs({
        streamPrefix: "migrate",
        logGroup
      })
    });
    this.seedTaskDefinition.addContainer("seed", {
      image,
      command: ["pnpm", "db:seed"],
      environment: runtimeEnvironment(config),
      secrets: runtimeSecretEnvironment(database, runtimeSecrets),
      logging: LogDriver.awsLogs({
        streamPrefix: "seed",
        logGroup
      })
    });

    new CfnOutput(this, "OperationsClusterName", { value: this.cluster.clusterName });
    new CfnOutput(this, "MigrationTaskDefinitionArn", {
      value: this.migrationTaskDefinition.taskDefinitionArn
    });
    new CfnOutput(this, "MigrationContainerName", { value: "migrate" });
    new CfnOutput(this, "SeedTaskDefinitionArn", {
      value: this.seedTaskDefinition.taskDefinitionArn
    });
    new CfnOutput(this, "SeedContainerName", { value: "seed" });
    new CfnOutput(this, "OperationsSecurityGroupId", {
      value: network.operationsSecurityGroup.securityGroupId
    });
    new CfnOutput(this, "OperationsSubnetIds", {
      value: Fn.join(",", network.vpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnetIds)
    });
    new CfnOutput(this, "OperationsAssignPublicIp", { value: "ENABLED" });
  }
}

function runtimePlatform() {
  return {
    cpuArchitecture: CpuArchitecture.ARM64,
    operatingSystemFamily: OperatingSystemFamily.LINUX
  };
}
