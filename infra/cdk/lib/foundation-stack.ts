import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Repository, TagMutability } from "aws-cdk-lib/aws-ecr";
import {
  Effect,
  type IOpenIdConnectProvider,
  OpenIdConnectProvider,
  OpenIdConnectPrincipal,
  PolicyStatement,
  Role
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { resourceName, type PromptProxyEnvironmentConfig } from "./config.js";

export type PromptProxyFoundationStackProps = StackProps & {
  config: PromptProxyEnvironmentConfig;
};

export class PromptProxyFoundationStack extends Stack {
  readonly proxyRepository: Repository;

  constructor(scope: Construct, id: string, props: PromptProxyFoundationStackProps) {
    super(scope, id, props);

    const { config } = props;
    this.proxyRepository = this.createRepository(config);
    const githubRole = this.createGithubDeployRole(config, githubProviderFor(this, config));

    this.proxyRepository.grantPullPush(githubRole);
    githubRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ecr:DescribeImages", "ecr:DescribeRepositories"],
      resources: [this.proxyRepository.repositoryArn]
    }));
    githubRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["sts:AssumeRole"],
      resources: [
        `arn:aws:iam::${config.awsAccountId}:role/cdk-*-deploy-role-${config.awsAccountId}-${config.region}`,
        `arn:aws:iam::${config.awsAccountId}:role/cdk-*-file-publishing-role-${config.awsAccountId}-${config.region}`,
        `arn:aws:iam::${config.awsAccountId}:role/cdk-*-image-publishing-role-${config.awsAccountId}-${config.region}`,
        `arn:aws:iam::${config.awsAccountId}:role/cdk-*-lookup-role-${config.awsAccountId}-${config.region}`
      ]
    }));
    this.addDeployWorkflowPolicy(config, githubRole);

    new CfnOutput(this, "ProxyRepositoryUri", { value: this.proxyRepository.repositoryUri });
    new CfnOutput(this, "GitHubActionsDeployRoleArn", { value: githubRole.roleArn });
  }

  private createRepository(config: PromptProxyEnvironmentConfig) {
    const repository = new Repository(this, "ProxyRepository", {
      repositoryName: resourceName(config, "proxy"),
      imageScanOnPush: true,
      imageTagMutability: TagMutability.IMMUTABLE,
      removalPolicy: config.envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      emptyOnDelete: config.envName !== "prod"
    });

    repository.addLifecycleRule({
      description: "Keep recent proxy images for rollback and trim older build artifacts.",
      maxImageCount: 30
    });

    return repository;
  }

  private createGithubDeployRole(config: PromptProxyEnvironmentConfig, provider: IOpenIdConnectProvider) {
    return new Role(this, "GitHubActionsDeployRole", {
      roleName: resourceName(config, "github-actions-deploy"),
      assumedBy: new OpenIdConnectPrincipal(provider).withConditions({
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": githubSubjectClaims(config)
        }
      }),
      maxSessionDuration: Duration.hours(1)
    });
  }

  private addDeployWorkflowPolicy(config: PromptProxyEnvironmentConfig, role: Role) {
    const partition = Stack.of(this).partition;
    const webBucketArn = `arn:${partition}:s3:::${resourceName(config, "web-assets")}-${config.awsAccountId}-${config.region}`;

    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ecr:GetAuthorizationToken"],
      resources: ["*"]
    }));
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["cloudformation:DescribeStacks"],
      resources: [`arn:${partition}:cloudformation:${config.region}:${config.awsAccountId}:stack/prompt-proxy-${config.envName}-*/*`]
    }));
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:ListBucket"],
      resources: [webBucketArn]
    }));
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:DeleteObject", "s3:GetObject", "s3:PutObject", "s3:PutObjectTagging"],
      resources: [`${webBucketArn}/*`]
    }));
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
      resources: [`arn:${partition}:cloudfront::${config.awsAccountId}:distribution/*`]
    }));
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ecs:DescribeServices", "ecs:DescribeTasks", "ecs:RunTask"],
      resources: ["*"]
    }));
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["iam:PassRole"],
      resources: [`arn:${partition}:iam::${config.awsAccountId}:role/*`],
      conditions: {
        StringEquals: {
          "iam:PassedToService": "ecs-tasks.amazonaws.com"
        }
      }
    }));
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["secretsmanager:GetSecretValue"],
      resources: [
        `arn:${partition}:secretsmanager:${config.region}:${config.awsAccountId}:secret:${resourceName(config, "proxy-token")}*`
      ]
    }));
  }
}

function githubProviderFor(scope: Construct, config: PromptProxyEnvironmentConfig): IOpenIdConnectProvider {
  if (config.githubOidcProviderArn) {
    return OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      scope,
      "GitHubActionsOidcProvider",
      config.githubOidcProviderArn
    );
  }

  return new OpenIdConnectProvider(scope, "GitHubActionsOidcProvider", {
    url: "https://token.actions.githubusercontent.com",
    clientIds: ["sts.amazonaws.com"]
  });
}

function githubSubjectClaims(config: PromptProxyEnvironmentConfig) {
  if (config.envName === "prod") {
    return [`repo:${config.githubRepository}:environment:${config.envName}`];
  }

  return [
    `repo:${config.githubRepository}:ref:refs/heads/${config.githubDeployBranch}`,
    `repo:${config.githubRepository}:environment:${config.envName}`
  ];
}
