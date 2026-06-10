import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { resourceName, type PromptProxyEnvironmentConfig } from "./config.js";

export type PromptProxyWebStackProps = StackProps & {
  config: PromptProxyEnvironmentConfig;
};

export class PromptProxyWebStack extends Stack {
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: PromptProxyWebStackProps) {
    super(scope, id, props);

    const { config } = props;
    const production = config.envName === "prod";
    this.bucket = new Bucket(this, "WebAssetsBucket", {
      bucketName: `${resourceName(config, "web-assets")}-${config.awsAccountId}-${config.region}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: Duration.days(production ? 30 : 7)
        }
      ]
    });

    new CfnOutput(this, "WebAssetsBucketName", { value: this.bucket.bucketName });
    new CfnOutput(this, "WebAssetsBucketArn", { value: this.bucket.bucketArn });
  }
}
