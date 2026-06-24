import { App } from "aws-cdk-lib";

import { environments } from "../config/environments.js";
import { stackName } from "./config.js";
import { ProxyDatabaseStack } from "./database-stack.js";
import { ProxyFoundationStack } from "./foundation-stack.js";
import { ProxyNetworkStack } from "./network-stack.js";
import { ProxyServiceStack } from "./proxy-service-stack.js";
import { ProxyRuntimeSecretsStack } from "./runtime-secrets-stack.js";

export function createRuntimeStacks() {
  const app = new App();
  const config = environments[0];
  const env = {
    account: config.awsAccountId,
    region: config.region
  };
  const foundation = new ProxyFoundationStack(app, stackName(config, "foundation-test"), {
    config,
    env
  });
  const network = new ProxyNetworkStack(app, stackName(config, "network-test"), {
    config,
    env
  });
  const database = new ProxyDatabaseStack(app, stackName(config, "database-test"), {
    config,
    env,
    network
  });
  const runtimeSecrets = new ProxyRuntimeSecretsStack(app, stackName(config, "runtime-secrets-test"), {
    config,
    env
  });
  const service = new ProxyServiceStack(app, stackName(config, "service-test"), {
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
