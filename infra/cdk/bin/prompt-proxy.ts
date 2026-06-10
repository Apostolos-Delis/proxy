#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";

import { environments } from "../config/environments.js";
import { stackName } from "../lib/config.js";
import { PromptProxyDatabaseStack } from "../lib/database-stack.js";
import { PromptProxyEdgeStack } from "../lib/edge-stack.js";
import { PromptProxyFoundationStack } from "../lib/foundation-stack.js";
import { PromptProxyNetworkStack } from "../lib/network-stack.js";
import { PromptProxyOperationsStack } from "../lib/operations-stack.js";
import { PromptProxyServiceStack } from "../lib/proxy-service-stack.js";
import { PromptProxyRuntimeSecretsStack } from "../lib/runtime-secrets-stack.js";
import { PromptProxyWebStack } from "../lib/web-stack.js";

const app = new App();
const runtimeImageTag = String(app.node.tryGetContext("runtimeImageTag") ?? "local-synth");

Tags.of(app).add("Project", "prompt-proxy");

for (const config of environments) {
  const stackEnv = {
    account: config.awsAccountId,
    region: config.region
  };

  const foundation = new PromptProxyFoundationStack(app, stackName(config, "foundation"), {
    config,
    env: stackEnv
  });

  const network = new PromptProxyNetworkStack(app, stackName(config, "network"), {
    config,
    env: stackEnv
  });

  const database = new PromptProxyDatabaseStack(app, stackName(config, "database"), {
    config,
    env: stackEnv,
    network
  });

  const runtimeSecrets = new PromptProxyRuntimeSecretsStack(app, stackName(config, "runtime-secrets"), {
    config,
    env: stackEnv
  });

  new PromptProxyOperationsStack(app, stackName(config, "operations"), {
    config,
    database,
    env: stackEnv,
    foundation,
    network,
    runtimeImageTag,
    runtimeSecrets
  });

  const service = new PromptProxyServiceStack(app, stackName(config, "service"), {
    config,
    database,
    env: stackEnv,
    foundation,
    network,
    runtimeImageTag,
    runtimeSecrets
  });

  const web = new PromptProxyWebStack(app, stackName(config, "web"), {
    config,
    env: stackEnv
  });

  const edge = new PromptProxyEdgeStack(app, stackName(config, "edge"), {
    adminAllowedCidrs: adminAllowedCidrsFor(config.envName),
    config,
    env: stackEnv,
    network,
    web
  });
  edge.addDependency(service);
}

function adminAllowedCidrsFor(envName: string) {
  const value = app.node.tryGetContext(`${envName}AdminAllowedCidrs`)
    ?? app.node.tryGetContext("adminAllowedCidrs")
    ?? "";
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(",").map((cidr) => cidr.trim()).filter(Boolean);
}
