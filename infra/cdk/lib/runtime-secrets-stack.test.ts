import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { environments } from "../config/environments.js";
import { stackName } from "./config.js";
import { PromptProxyRuntimeSecretsStack } from "./runtime-secrets-stack.js";

const config = environments[0];

describe("PromptProxyRuntimeSecretsStack", () => {
  it("keeps provider keys operator-populated", () => {
    const template = runtimeSecretsTemplate();

    for (const name of ["openai-api-key", "anthropic-api-key"]) {
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Name: `prompt-proxy-staging-${name}`,
        SecretString: "OPERATOR_POPULATES_BEFORE_USE"
      });
    }
  });

  it("generates proxy and admin secrets", () => {
    const template = runtimeSecretsTemplate();

    for (const name of ["proxy-token", "admin-credentials", "admin-session-secret"]) {
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Name: `prompt-proxy-staging-${name}`,
        GenerateSecretString: {}
      });
    }
  });
});

function runtimeSecretsTemplate() {
  const app = new App();
  const stack = new PromptProxyRuntimeSecretsStack(app, stackName(config, "runtime-secrets-test"), {
    config,
    env: {
      account: config.awsAccountId,
      region: config.region
    }
  });

  return Template.fromStack(stack);
}
