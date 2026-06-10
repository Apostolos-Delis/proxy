import type { PromptProxyEnvironmentConfig } from "../lib/config.js";

export const environments = [
  {
    envName: "staging",
    awsAccountId: "459063349068",
    region: "us-east-1",
    availabilityZones: ["us-east-1a", "us-east-1b"],
    githubRepository: "Apostolos-Delis/prompt-proxy",
    githubDeployBranch: "main",
    githubOidcProviderArn: "arn:aws:iam::459063349068:oidc-provider/token.actions.githubusercontent.com",
    cloudFrontOriginFacingPrefixListId: "pl-3b927c52",
    desiredProxyCount: 1,
    databaseInstanceClass: "db.t4g.micro",
    databaseAllocatedStorageGb: 20
  },
  {
    envName: "prod",
    awsAccountId: "459063349068",
    region: "us-east-1",
    availabilityZones: ["us-east-1a", "us-east-1b"],
    existingVpc: {
      vpcId: "vpc-017fca98c2999d1e0",
      publicSubnetIds: ["subnet-0f82435c55fd7a7d7", "subnet-0be5e3a653c094e92"],
      publicSubnetRouteTableIds: ["rtb-0b64a09bb8f37ea6c", "rtb-0eac0f90ff8aa21f6"],
      isolatedSubnetIds: ["subnet-0f6a1c640d11d5121", "subnet-0cebde9218c56cdb6"],
      isolatedSubnetRouteTableIds: ["rtb-0e110ff464d35ba27", "rtb-082de63434dc59f09"]
    },
    githubRepository: "Apostolos-Delis/prompt-proxy",
    githubDeployBranch: "main",
    githubOidcProviderArn: "arn:aws:iam::459063349068:oidc-provider/token.actions.githubusercontent.com",
    cloudFrontOriginFacingPrefixListId: "pl-3b927c52",
    desiredProxyCount: 1,
    databaseInstanceClass: "db.t4g.micro",
    databaseAllocatedStorageGb: 20
  }
] satisfies PromptProxyEnvironmentConfig[];
