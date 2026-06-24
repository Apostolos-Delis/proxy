import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { environments } from "../config/environments.js";
import { runtimeEnvironment } from "./proxy-service-stack.js";
import { createRuntimeStacks } from "./test-helpers.js";

describe("ProxyServiceStack", () => {
  it("runs the proxy behind the ALB with public-subnet egress", () => {
    const { network, service } = createRuntimeStacks();
    const serviceTemplate = Template.fromStack(service);
    const networkTemplate = Template.fromStack(network);

    serviceTemplate.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: "proxy-staging-proxy",
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
      Family: "proxy-staging-proxy",
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
    for (const name of ["PROXY_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
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

  it("uses hardened runtime defaults for release deployments", () => {
    const stagingConfig = environments.find((config) => config.envName === "staging");
    const prodConfig = environments.find((config) => config.envName === "prod");
    if (!stagingConfig || !prodConfig) {
      throw new Error("missing CDK test environments");
    }

    const stagingEnvironment = runtimeEnvironment(stagingConfig);
    const prodEnvironment = runtimeEnvironment(prodConfig);

    expect(stagingEnvironment.ADMIN_DEV_LOGIN_ENABLED).toBe("true");
    expect(stagingEnvironment.ADMIN_GRAPHIQL_ENABLED).toBe("true");
    expect(stagingEnvironment.ADMIN_SESSION_COOKIE_SECURE).toBe("true");
    expect(stagingEnvironment.DEBUG_ENDPOINTS_ENABLED).toBe("false");
    expect(prodEnvironment.ADMIN_DEV_LOGIN_ENABLED).toBe("false");
    expect(prodEnvironment.ADMIN_GRAPHIQL_ENABLED).toBe("false");
    expect(prodEnvironment.ADMIN_SESSION_COOKIE_SECURE).toBe("true");
    expect(prodEnvironment.DEBUG_ENDPOINTS_ENABLED).toBe("false");
  });
});
