import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { environments } from "../config/environments.js";
import { stackName } from "./config.js";
import { PromptProxyNetworkStack } from "./network-stack.js";

const config = environments[0];
const prodConfig = environments[1];

describe("PromptProxyNetworkStack", () => {
  it("synthesizes without NAT gateways", () => {
    const template = networkTemplate();

    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::EIP", 0);
  });

  it("restricts ALB ingress to the CloudFront origin prefix list", () => {
    const template = networkTemplate();

    template.hasResourceProperties("AWS::EC2::SecurityGroupIngress", {
      SourcePrefixListId: config.cloudFrontOriginFacingPrefixListId,
      FromPort: 80,
      ToPort: 80
    });
    expect(template.findResources("AWS::EC2::SecurityGroupIngress", {
      Properties: Match.objectLike({
        CidrIp: "0.0.0.0/0"
      })
    })).toEqual({});
  });

  it("allows only ALB-to-proxy and service-to-database ingress", () => {
    const template = networkTemplate();
    const ingressRules = template.findResources("AWS::EC2::SecurityGroupIngress");

    expect(Object.values(ingressRules)).toHaveLength(4);
  });

  it("imports the configured prod VPC without creating a new VPC or internet gateway", () => {
    const template = networkTemplate(prodConfig);

    template.resourceCountIs("AWS::EC2::VPC", 0);
    template.resourceCountIs("AWS::EC2::InternetGateway", 0);
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Subnets: prodConfig.existingVpc?.publicSubnetIds
    });
  });
});

function networkTemplate(environmentConfig = config) {
  const app = new App();
  const stack = new PromptProxyNetworkStack(app, stackName(environmentConfig, "network-test"), {
    config: environmentConfig,
    env: {
      account: environmentConfig.awsAccountId,
      region: environmentConfig.region
    }
  });

  return Template.fromStack(stack);
}
