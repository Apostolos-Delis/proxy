import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { createRuntimeStacks } from "./test-helpers";

describe("PromptProxyServiceStack", () => {
  it("runs the proxy behind the ALB with public-subnet egress", () => {
    const { network, service } = createRuntimeStacks();
    const serviceTemplate = Template.fromStack(service);
    const networkTemplate = Template.fromStack(network);

    serviceTemplate.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: "prompt-proxy-staging-proxy",
      DesiredCount: 1,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({
          AssignPublicIp: "ENABLED"
        })
      }
    });
    networkTemplate.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      Port: 8787,
      Protocol: "HTTP",
      HealthCheckPath: "/healthz"
    });
  });

  it("injects runtime secrets into the proxy task", () => {
    const { service } = createRuntimeStacks();
    const template = Template.fromStack(service);

    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: "prompt-proxy-staging-proxy",
      RuntimePlatform: {
        CpuArchitecture: "ARM64",
        OperatingSystemFamily: "LINUX"
      },
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "proxy",
          Command: ["pnpm", "start:prod:proxy"],
          PortMappings: Match.arrayWith([Match.objectLike({ ContainerPort: 8787 })]),
          Secrets: Match.arrayWith([Match.objectLike({ Name: "DATABASE_URL" })])
        })
      ])
    });
    for (const name of ["PROMPT_PROXY_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      template.hasResourceProperties("AWS::ECS::TaskDefinition", {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: "proxy",
            Secrets: Match.arrayWith([Match.objectLike({ Name: name })])
          })
        ])
      });
    }
  });
});
