import { App } from "aws-cdk-lib";

import { environments } from "../config/environments";
import { stackName } from "./config";
import { PromptProxyDatabaseStack } from "./database-stack";
import { PromptProxyFoundationStack } from "./foundation-stack";
import { PromptProxyNetworkStack } from "./network-stack";
import { PromptProxyServiceStack } from "./proxy-service-stack";
import { PromptProxyRuntimeSecretsStack } from "./runtime-secrets-stack";

export function createRuntimeStacks() {
  const app = new App();
  const config = environments[0];
  const env = {
    account: config.awsAccountId,
    region: config.region
  };
  const foundation = new PromptProxyFoundationStack(app, stackName(config, "foundation-test"), {
    config,
    env
  });
  const network = new PromptProxyNetworkStack(app, stackName(config, "network-test"), {
    config,
    env
  });
  const database = new PromptProxyDatabaseStack(app, stackName(config, "database-test"), {
    config,
    env,
    network
  });
  const runtimeSecrets = new PromptProxyRuntimeSecretsStack(app, stackName(config, "runtime-secrets-test"), {
    config,
    env
  });
  const service = new PromptProxyServiceStack(app, stackName(config, "service-test"), {
    config,
    database,
    env,
    foundation,
    network,
    runtimeImageTag: "test",
    runtimeSecrets
  });

  return { app, config, database, foundation, network, runtimeSecrets, service };
}
