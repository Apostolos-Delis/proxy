#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";

import { environments } from "../config/environments.js";
import { stackName } from "../lib/config.js";
import { ProxyDatabaseStack } from "../lib/database-stack.js";
import { ProxyEdgeStack } from "../lib/edge-stack.js";
import { ProxyFoundationStack } from "../lib/foundation-stack.js";
import { ProxyNetworkStack } from "../lib/network-stack.js";
import { ProxyOperationsStack } from "../lib/operations-stack.js";
import { ProxyServiceStack } from "../lib/proxy-service-stack.js";
import { ProxyRuntimeSecretsStack } from "../lib/runtime-secrets-stack.js";
import { ProxyWebStack } from "../lib/web-stack.js";

const app = new App();
const runtimeImageTag = String(app.node.tryGetContext("runtimeImageTag") ?? "local-synth");

Tags.of(app).add("Project", "proxy");

for (const config of environments) {
  const stackEnv = {
    account: config.awsAccountId,
    region: config.region
  };

  const foundation = new ProxyFoundationStack(app, stackName(config, "foundation"), {
    config,
    env: stackEnv
  });

  const network = new ProxyNetworkStack(app, stackName(config, "network"), {
    config,
    env: stackEnv
  });

  const database = new ProxyDatabaseStack(app, stackName(config, "database"), {
    config,
    env: stackEnv,
    network
  });

  const runtimeSecrets = new ProxyRuntimeSecretsStack(app, stackName(config, "runtime-secrets"), {
    config,
    env: stackEnv
  });

  new ProxyOperationsStack(app, stackName(config, "operations"), {
    config,
    database,
    env: stackEnv,
    foundation,
    network,
    runtimeImageTag,
    runtimeSecrets
  });

  const service = new ProxyServiceStack(app, stackName(config, "service"), {
    config,
    database,
    env: stackEnv,
    foundation,
    network,
    runtimeImageTag,
    runtimeSecrets
  });

  const web = new ProxyWebStack(app, stackName(config, "web"), {
    config,
    env: stackEnv
  });

  const edge = new ProxyEdgeStack(app, stackName(config, "edge"), {
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
