import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { stackName } from "./config.js";
import { PromptProxyEdgeStack } from "./edge-stack.js";
import { createRuntimeStacks } from "./test-helpers.js";
import { PromptProxyWebStack } from "./web-stack.js";

describe("PromptProxyEdgeStack", () => {
  it("serves web assets and forwards API traffic through CloudFront", () => {
    const { edge } = createEdgeStack(["203.0.113.10/32"]);
    const template = Template.fromStack(edge);

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        PriceClass: "PriceClass_100",
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https"
        }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike(apiBehavior("/healthz")),
          Match.objectLike(apiBehavior("/v1/*")),
          Match.objectLike(apiBehavior("/api/*")),
          Match.objectLike(apiBehavior("/admin/*"))
        ])
      })
    });
  });

  it("adds a WAF rate limit and admin allowlist gate", () => {
    const { edge } = createEdgeStack(["203.0.113.10/32", "2001:db8::10/128"]);
    const template = Template.fromStack(edge);

    template.hasResourceProperties("AWS::WAFv2::IPSet", {
      Scope: "CLOUDFRONT",
      IPAddressVersion: "IPV4",
      Addresses: ["203.0.113.10/32"]
    });
    template.hasResourceProperties("AWS::WAFv2::IPSet", {
      Scope: "CLOUDFRONT",
      IPAddressVersion: "IPV6",
      Addresses: ["2001:db8::10/128"]
    });
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Scope: "CLOUDFRONT",
      DefaultAction: {
        Allow: {}
      },
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: "RateLimit",
          Action: { Block: {} },
          Statement: Match.objectLike({
            RateBasedStatement: Match.objectLike({
              Limit: 2000
            })
          })
        }),
        Match.objectLike({
          Name: "AdminAccessGate",
          Action: { Block: {} }
        })
      ])
    });
  });

  it("keeps API and admin routes public when no allowlist is configured", () => {
    const { edge } = createEdgeStack([]);
    const template = Template.fromStack(edge);

    expect(template.findResources("AWS::WAFv2::IPSet")).toEqual({});
    const webAcls = template.findResources("AWS::WAFv2::WebACL");
    const rules = Object.values(webAcls).flatMap((resource) => resource.Properties.Rules);

    expect(rules).toEqual([
      expect.objectContaining({
        Name: "RateLimit"
      })
    ]);
  });
});

function apiBehavior(pathPattern: string) {
  return {
    PathPattern: pathPattern,
    AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
    CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    OriginRequestPolicyId: "216adef6-5c7f-47e4-b989-5492eafa07d3",
    ViewerProtocolPolicy: "redirect-to-https"
  };
}

function createEdgeStack(adminAllowedCidrs: string[]) {
  const { app, config, network } = createRuntimeStacks();
  const web = new PromptProxyWebStack(app, stackName(config, "web-test"), {
    config,
    env: {
      account: config.awsAccountId,
      region: config.region
    }
  });
  const edge = new PromptProxyEdgeStack(app, stackName(config, "edge-test"), {
    adminAllowedCidrs,
    config,
    env: {
      account: config.awsAccountId,
      region: config.region
    },
    network,
    web
  });

  return { edge };
}
