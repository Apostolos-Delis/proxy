import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import { InstanceClass, InstanceSize, InstanceType, SubnetType } from "aws-cdk-lib/aws-ec2";
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  DatabaseSecret,
  PostgresEngineVersion
} from "aws-cdk-lib/aws-rds";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

import { resourceName, type PromptProxyEnvironmentConfig } from "./config.js";
import type { PromptProxyNetworkStack } from "./network-stack.js";

export type PromptProxyDatabaseStackProps = StackProps & {
  config: PromptProxyEnvironmentConfig;
  network: PromptProxyNetworkStack;
};

export class PromptProxyDatabaseStack extends Stack {
  readonly database: DatabaseInstance;
  readonly databaseCredentials: DatabaseSecret;
  readonly databaseUrl: Secret;

  constructor(scope: Construct, id: string, props: PromptProxyDatabaseStackProps) {
    super(scope, id, props);

    const { config, network } = props;
    const removalPolicy = config.envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.databaseCredentials = new DatabaseSecret(this, "DatabaseCredentials", {
      username: "prompt_proxy",
      dbname: "prompt_proxy",
      secretName: resourceName(config, "postgres-credentials")
    });
    this.databaseCredentials.applyRemovalPolicy(removalPolicy);

    this.database = new DatabaseInstance(this, "Postgres", {
      databaseName: "prompt_proxy",
      instanceIdentifier: resourceName(config, "postgres"),
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16_10 }),
      credentials: Credentials.fromSecret(this.databaseCredentials, "prompt_proxy"),
      vpc: network.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.databaseSecurityGroup],
      instanceType: instanceTypeFrom(config.databaseInstanceClass),
      allocatedStorage: config.databaseAllocatedStorageGb,
      maxAllocatedStorage: config.databaseAllocatedStorageGb * 4,
      storageEncrypted: true,
      backupRetention: Duration.days(config.envName === "prod" ? 14 : 7),
      deletionProtection: config.envName === "prod",
      deleteAutomatedBackups: config.envName !== "prod",
      publiclyAccessible: false,
      removalPolicy
    });

    this.databaseUrl = new Secret(this, "DatabaseUrl", {
      secretName: resourceName(config, "database-url"),
      secretStringValue: SecretValue.unsafePlainText(
        `postgresql://prompt_proxy:${this.databaseCredentials.secretValueFromJson("password")}@${this.database.dbInstanceEndpointAddress}:${this.database.dbInstanceEndpointPort}/prompt_proxy?sslmode=require`
      ),
      removalPolicy
    });

    new CfnOutput(this, "DatabaseEndpointAddress", { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, "DatabaseCredentialsSecretArn", { value: this.databaseCredentials.secretArn });
    new CfnOutput(this, "DatabaseUrlSecretArn", { value: this.databaseUrl.secretArn });
  }
}

function instanceTypeFrom(value: string) {
  const [, instanceClass, size] = /^db\.([^.]+)\.(.+)$/.exec(value) ?? [];
  if (!instanceClass || !size) throw new Error(`Invalid database instance class: ${value}`);
  return InstanceType.of(instanceClassFrom(instanceClass), instanceSizeFrom(size));
}

function instanceClassFrom(value: string) {
  switch (value) {
    case "t4g":
      return InstanceClass.T4G;
    case "t3":
      return InstanceClass.T3;
    default:
      throw new Error(`Unsupported database instance family: ${value}`);
  }
}

function instanceSizeFrom(value: string) {
  switch (value) {
    case "micro":
      return InstanceSize.MICRO;
    case "small":
      return InstanceSize.SMALL;
    case "medium":
      return InstanceSize.MEDIUM;
    case "large":
      return InstanceSize.LARGE;
    default:
      throw new Error(`Unsupported database instance size: ${value}`);
  }
}
