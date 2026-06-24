import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { environments } from "../config/environments.js";
import { stackName } from "./config.js";
import { ProxyDatabaseStack } from "./database-stack.js";
import { ProxyNetworkStack } from "./network-stack.js";

const config = environments[0];

describe("ProxyDatabaseStack", () => {
  it("creates a private encrypted Postgres database", () => {
    const template = databaseTemplate();

    template.hasResourceProperties("AWS::RDS::DBInstance", {
      DBName: "proxy",
      PubliclyAccessible: false,
      StorageEncrypted: true
    });
  });

  it("generates an SSL-enabled DATABASE_URL secret", () => {
    const template = databaseTemplate();

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

function databaseTemplate() {
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
