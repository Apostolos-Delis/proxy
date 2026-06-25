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
    serviceTemplate.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "256",
      Memory: "512"
    });
  });

  it("sizes and autoscales the prod proxy service", () => {
    const { service } = createRuntimeStacks(environments[1]);
    const template = Template.fromStack(service);

    template.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterName: "proxy-prod-cluster",
      ClusterSettings: Match.arrayWith([Match.objectLike({ Name: "containerInsights", Value: "enhanced" })])
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: "proxy-prod-proxy",
      Cpu: "1024",
      Memory: "2048",
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
	          Environment: Match.arrayWith([
	            Match.objectLike({ Name: "DB_POOL_MAX", Value: "5" }),
	            Match.objectLike({ Name: "EVENT_WRITER_BATCH_SIZE", Value: "25" }),
	            Match.objectLike({ Name: "EVENT_WRITER_MAX_BYTES", Value: "8388608" }),
	            Match.objectLike({ Name: "EVENT_WRITER_MAX_ENTRIES", Value: "10000" }),
	            Match.objectLike({ Name: "EVENT_WRITER_SHUTDOWN_TIMEOUT_MS", Value: "5000" }),
	            Match.objectLike({ Name: "REQUEST_BODY_LIMIT_BYTES", Value: "15728640" })
	          ])
        })
      ])
    });
    template.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: "proxy-prod-proxy",
      DesiredCount: 2
    });
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: 2,
      MaxCapacity: 8,
      ScalableDimension: "ecs:service:DesiredCount",
      ServiceNamespace: "ecs"
    });
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
      PolicyType: "TargetTrackingScaling",
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        PredefinedMetricSpecification: { PredefinedMetricType: "ECSServiceAverageCPUUtilization" },
        TargetValue: 60
      })
    });
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
      PolicyType: "TargetTrackingScaling",
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        PredefinedMetricSpecification: { PredefinedMetricType: "ECSServiceAverageMemoryUtilization" },
        TargetValue: 70
      })
    });
  });

  it("creates proxy service health alarms", () => {
    const { service } = createRuntimeStacks(environments[1]);
    const template = Template.fromStack(service);

    template.resourceCountIs("AWS::CloudWatch::Alarm", 6);
    for (const alarmName of [
      "proxy-prod-proxy-high-cpu",
      "proxy-prod-proxy-high-memory",
      "proxy-prod-proxy-target-5xx",
      "proxy-prod-proxy-target-response-time",
      "proxy-prod-proxy-unhealthy-targets",
      "proxy-prod-proxy-restarts"
    ]) {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: alarmName
      });
    }
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "RestartCount",
      Namespace: "ECS/ContainerInsights",
      Statistic: "Sum"
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
	          Environment: Match.arrayWith([
	            Match.objectLike({ Name: "DB_POOL_MAX", Value: "5" }),
	            Match.objectLike({ Name: "EVENT_WRITER_BATCH_SIZE", Value: "25" }),
	            Match.objectLike({ Name: "EVENT_WRITER_MAX_BYTES", Value: "8388608" }),
	            Match.objectLike({ Name: "EVENT_WRITER_MAX_ENTRIES", Value: "10000" }),
	            Match.objectLike({ Name: "EVENT_WRITER_SHUTDOWN_TIMEOUT_MS", Value: "5000" }),
	            Match.objectLike({ Name: "REQUEST_BODY_LIMIT_BYTES", Value: "52428800" })
	          ]),
          RestartPolicy: {
            Enabled: true,
            RestartAttemptPeriod: 300
          },
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
