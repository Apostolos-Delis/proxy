import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { environments } from "../config/environments.js";
import { stackName } from "./config.js";
import { PromptProxyDatabaseStack } from "./database-stack.js";
import { PromptProxyNetworkStack } from "./network-stack.js";

const config = environments[0];

describe("PromptProxyDatabaseStack", () => {
  it("creates a private encrypted Postgres database", () => {
    const template = databaseTemplate();

    template.hasResourceProperties("AWS::RDS::DBInstance", {
      DBName: "prompt_proxy",
      PubliclyAccessible: false,
      StorageEncrypted: true
    });
  });

  it("generates an SSL-enabled DATABASE_URL secret", () => {
    const template = databaseTemplate();

    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "prompt-proxy-staging-database-url",
      SecretString: {
        "Fn::Join": [
          "",
          Match.arrayWith(["/prompt_proxy?sslmode=require"])
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
  const network = new PromptProxyNetworkStack(app, stackName(config, "network-test"), { config, env });
  const database = new PromptProxyDatabaseStack(app, stackName(config, "database-test"), {
    config,
    env,
    network
  });

  return Template.fromStack(database);
}
