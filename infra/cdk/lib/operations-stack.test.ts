import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { stackName } from "./config.js";
import { PromptProxyOperationsStack } from "./operations-stack.js";
import { createRuntimeStacks } from "./test-helpers.js";

describe("PromptProxyOperationsStack", () => {
  it("creates a public-subnet operations task for migrations and seed overrides", () => {
    const { config, database, foundation, network, runtimeSecrets } = createRuntimeStacks();
    const operations = new PromptProxyOperationsStack(network.node.root, stackName(config, "operations-test"), {
      config,
      database,
      env: {
        account: config.awsAccountId,
        region: config.region
      },
      foundation,
      network,
      runtimeImageTag: "test",
      runtimeSecrets
    });
    const template = Template.fromStack(operations);

    template.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterName: "prompt-proxy-staging-operations-cluster"
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: "prompt-proxy-staging-operations-task",
      RuntimePlatform: {
        CpuArchitecture: "ARM64",
        OperatingSystemFamily: "LINUX"
      },
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "migrate",
          Command: ["pnpm", "db:migrate"],
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: "DATABASE_URL" }),
            Match.objectLike({ Name: "PROMPT_PROXY_TOKEN" })
          ])
        })
      ])
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: "prompt-proxy-staging-seed-task",
      RuntimePlatform: {
        CpuArchitecture: "ARM64",
        OperatingSystemFamily: "LINUX"
      },
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "seed",
          Command: ["pnpm", "db:seed"],
          Secrets: Match.arrayWith([Match.objectLike({ Name: "DATABASE_URL" })])
        })
      ])
    });
    template.hasOutput("OperationsAssignPublicIp", {
      Value: "ENABLED"
    });
  });
});
