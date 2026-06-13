import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { environments } from "../config/environments.js";
import { stackName } from "./config.js";
import { PromptProxyFoundationStack } from "./foundation-stack.js";

const config = environments[0];

describe("PromptProxyFoundationStack", () => {
  it("allows the deploy workflow to inspect immutable image tags", () => {
    const template = foundationTemplate();

    const policies = template.findResources("AWS::IAM::Policy");
    const policyDocuments = Object.values(policies).map((policy) => policy.Properties.PolicyDocument);

    expect(policyDocuments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Statement: expect.arrayContaining([
            expect.objectContaining({
              Action: expect.arrayContaining(["ecr:DescribeImages", "ecr:DescribeRepositories"]),
              Effect: "Allow"
            })
          ])
        })
      ])
    );
  });

  it("only lets the deploy workflow read the proxy smoke token directly", () => {
    const template = foundationTemplate();
    const policies = template.findResources("AWS::IAM::Policy");
    const policyJson = JSON.stringify(Object.values(policies).map((policy) => policy.Properties.PolicyDocument));

    expect(policyJson).toContain("secretsmanager:GetSecretValue");
    expect(policyJson).toContain("proxy-token");
    expect(policyJson).not.toContain("admin-credentials");
  });
});

function foundationTemplate() {
  const app = new App();
  const stack = new PromptProxyFoundationStack(app, stackName(config, "foundation-test"), {
    config,
    env: {
      account: config.awsAccountId,
      region: config.region
    }
  });
  return Template.fromStack(stack);
}
