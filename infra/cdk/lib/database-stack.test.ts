import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { environments } from "../config/environments.js";
import { stackName, type ProxyEnvironmentConfig } from "./config.js";
import { ProxyDatabaseStack } from "./database-stack.js";
import { ProxyNetworkStack } from "./network-stack.js";

const stagingConfig = environments[0];
const prodConfig = environments[1];

describe("ProxyDatabaseStack", () => {
  it("creates a private encrypted Postgres database", () => {
    const template = databaseTemplate(stagingConfig);

    template.hasResourceProperties("AWS::RDS::DBInstance", {
      DBName: "proxy",
      PubliclyAccessible: false,
      StorageEncrypted: true
    });
  });

  it("keeps staging on a small local-cost database", () => {
    const template = databaseTemplate(stagingConfig);

    template.hasResourceProperties("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.t4g.micro",
      AllocatedStorage: "20"
    });
  });

  it("sizes production database above the staging baseline", () => {
    const template = databaseTemplate(prodConfig);

    template.hasResourceProperties("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.t4g.medium",
      AllocatedStorage: "100",
      DeletionProtection: true
    });
  });

  it("generates an SSL-enabled DATABASE_URL secret", () => {
    const template = databaseTemplate(stagingConfig);

    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "proxy-staging-database-url",
      SecretString: {
        "Fn::Join": [
          "",
          Match.arrayWith(["/proxy?sslmode=require"])
        ]
      }
    });
  });
});

function databaseTemplate(config: ProxyEnvironmentConfig) {
  const app = new App();
  const env = {
    account: config.awsAccountId,
    region: config.region
  };
  const network = new ProxyNetworkStack(app, stackName(config, "network-test"), { config, env });
  const database = new ProxyDatabaseStack(app, stackName(config, "database-test"), {
    config,
    env,
    network
  });

  return Template.fromStack(database);
}
