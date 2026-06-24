import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { environments } from "../config/environments.js";
import { stackName } from "./config.js";
import { ProxyWebStack } from "./web-stack.js";

const config = environments[0];

describe("ProxyWebStack", () => {
  it("creates a private versioned S3 bucket for web assets", () => {
    const template = webTemplate();

    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "proxy-staging-web-assets-459063349068-us-east-1",
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: "AES256"
            }
          })
        ])
      }),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      },
      VersioningConfiguration: {
        Status: "Enabled"
      }
    });
    expect(template.findResources("AWS::S3::BucketPolicy", {
      Properties: Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: "*"
            })
          ])
        })
      })
    })).toEqual({});
  });
});

function webTemplate() {
  const app = new App();
  const stack = new ProxyWebStack(app, stackName(config, "web-test"), {
    config,
    env: {
      account: config.awsAccountId,
      region: config.region
    }
  });

  return Template.fromStack(stack);
}
