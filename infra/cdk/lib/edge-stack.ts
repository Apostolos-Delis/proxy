import { Annotations, CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ViewerProtocolPolicy
} from "aws-cdk-lib/aws-cloudfront";
import {
  LoadBalancerV2Origin,
  S3BucketOrigin
} from "aws-cdk-lib/aws-cloudfront-origins";
import { Bucket, CfnBucketPolicy } from "aws-cdk-lib/aws-s3";
import { CfnIPSet, CfnWebACL } from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

import { resourceName, type PromptProxyEnvironmentConfig } from "./config";
import type { PromptProxyNetworkStack } from "./network-stack";
import type { PromptProxyWebStack } from "./web-stack";

export type PromptProxyEdgeStackProps = StackProps & {
  config: PromptProxyEnvironmentConfig;
  network: PromptProxyNetworkStack;
  web: PromptProxyWebStack;
  adminAllowedCidrs: string[];
};

export class PromptProxyEdgeStack extends Stack {
  readonly distribution: Distribution;
  readonly webAcl: CfnWebACL;

  constructor(scope: Construct, id: string, props: PromptProxyEdgeStackProps) {
    super(scope, id, props);

    const { adminAllowedCidrs, config, network, web } = props;
    Annotations.of(this).acknowledgeWarning(
      "@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac",
      "EdgeStack owns the CloudFront bucket policy to avoid a cross-stack OAC cycle."
    );
    const webAcl = this.createWebAcl(config, adminAllowedCidrs);
    const webBucketOrigin = Bucket.fromBucketAttributes(this, "WebBucketOriginRef", {
      bucketName: web.bucket.bucketName,
      bucketArn: web.bucket.bucketArn,
      bucketRegionalDomainName: web.bucket.bucketRegionalDomainName
    });
    const apiOrigin = new LoadBalancerV2Origin(network.loadBalancer, {
      protocolPolicy: OriginProtocolPolicy.HTTP_ONLY
    });
    const apiBehavior = {
      origin: apiOrigin,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS
    };
    const spaRewrite = new CloudFrontFunction(this, "SpaRewriteFunction", {
      functionName: resourceName(config, "spa-rewrite"),
      code: FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf("/api/") === 0 || uri.indexOf("/admin/") === 0 || uri.indexOf("/v1/") === 0) {
    return request;
  }
  if (uri === "/" || uri.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
`)
    });

    this.webAcl = webAcl;
    this.distribution = new Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      priceClass: PriceClass.PRICE_CLASS_100,
      webAclId: webAcl.attrArn,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(webBucketOrigin),
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: spaRewrite,
            eventType: FunctionEventType.VIEWER_REQUEST
          }
        ]
      },
      additionalBehaviors: {
        "/healthz": apiBehavior,
        "/v1/*": apiBehavior,
        "/api/*": apiBehavior,
        "/admin/*": apiBehavior
      }
    });
    new CfnBucketPolicy(this, "WebAssetsBucketPolicy", {
      bucket: web.bucket.bucketName,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyInsecureTransport",
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [web.bucket.bucketArn, web.bucket.arnForObjects("*")],
            Condition: {
              Bool: {
                "aws:SecureTransport": "false"
              }
            }
          },
          {
            Sid: "AllowCloudFrontRead",
            Effect: "Allow",
            Principal: {
              Service: "cloudfront.amazonaws.com"
            },
            Action: "s3:GetObject",
            Resource: web.bucket.arnForObjects("*"),
            Condition: {
              StringEquals: {
                "AWS:SourceArn": `arn:${Stack.of(this).partition}:cloudfront::${Stack.of(this).account}:distribution/${this.distribution.distributionId}`
              }
            }
          }
        ]
      }
    });

    new CfnOutput(this, "CloudFrontDistributionId", {
      value: this.distribution.distributionId
    });
    new CfnOutput(this, "CloudFrontDomainName", {
      value: this.distribution.distributionDomainName
    });
    new CfnOutput(this, "WebAclArn", { value: webAcl.attrArn });
  }

  private createWebAcl(config: PromptProxyEnvironmentConfig, adminAllowedCidrs: string[]) {
    const rules: CfnWebACL.RuleProperty[] = [
      {
        name: "RateLimit",
        priority: 0,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            aggregateKeyType: "IP",
            limit: 2000
          }
        },
        visibilityConfig: visibility("RateLimit")
      }
    ];

    if (adminAllowedCidrs.length > 0) {
      rules.push({
        name: "AdminAccessGate",
        priority: 1,
        action: { block: {} },
        statement: adminAccessStatement(this, config, adminAllowedCidrs),
        visibilityConfig: visibility("AdminAccessGate")
      });
    }

    return new CfnWebACL(this, "WebAcl", {
      name: resourceName(config, "edge-web-acl"),
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: visibility("WebAcl"),
      rules
    });
  }
}

function adminAccessStatement(scope: Construct, config: PromptProxyEnvironmentConfig, cidrs: string[]) {
  const ipv4Cidrs = cidrs.filter((cidr) => !cidr.includes(":"));
  const ipv6Cidrs = cidrs.filter((cidr) => cidr.includes(":"));
  const allowedIpStatements: CfnWebACL.StatementProperty[] = [];

  if (ipv4Cidrs.length > 0) {
    const ipSet = new CfnIPSet(scope, "AdminAllowedIpv4Set", {
      name: resourceName(config, "admin-allowed-ipv4"),
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV4",
      addresses: ipv4Cidrs
    });
    allowedIpStatements.push({
      ipSetReferenceStatement: {
        arn: ipSet.attrArn
      }
    });
  }

  if (ipv6Cidrs.length > 0) {
    const ipSet = new CfnIPSet(scope, "AdminAllowedIpv6Set", {
      name: resourceName(config, "admin-allowed-ipv6"),
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV6",
      addresses: ipv6Cidrs
    });
    allowedIpStatements.push({
      ipSetReferenceStatement: {
        arn: ipSet.attrArn
      }
    });
  }

  const allowedIpStatement = allowedIpStatements.length === 1
    ? allowedIpStatements[0]
    : {
        orStatement: {
          statements: allowedIpStatements
        }
      };

  return {
    andStatement: {
      statements: [
        adminPathStatement(),
        {
          notStatement: {
            statement: allowedIpStatement
          }
        }
      ]
    }
  };
}

function adminPathStatement() {
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: "STARTS_WITH",
      searchString: "/admin/",
      textTransformations: [{ priority: 0, type: "NONE" }]
    }
  };
}

function visibility(name: string) {
  return {
    cloudWatchMetricsEnabled: true,
    metricName: name,
    sampledRequestsEnabled: true
  };
}
