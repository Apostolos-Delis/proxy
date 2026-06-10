export type PromptProxyEnvironmentConfig = {
  envName: "staging" | "prod";
  awsAccountId: string;
  region: string;
  availabilityZones: [string, string];
  existingVpc?: {
    vpcId: string;
    publicSubnetIds: [string, string];
    publicSubnetRouteTableIds: [string, string];
    isolatedSubnetIds: [string, string];
    isolatedSubnetRouteTableIds: [string, string];
  };
  githubRepository: string;
  githubDeployBranch: string;
  githubOidcProviderArn?: string;
  cloudFrontOriginFacingPrefixListId?: string;
  desiredProxyCount: number;
  databaseInstanceClass: string;
  databaseAllocatedStorageGb: number;
  customDomain?: {
    appHost: string;
    hostedZoneId: string;
    hostedZoneName: string;
  };
};

export function stackName(config: PromptProxyEnvironmentConfig, suffix: string) {
  return `prompt-proxy-${config.envName}-${suffix}`;
}

export function resourceName(config: PromptProxyEnvironmentConfig, name: string) {
  return `prompt-proxy-${config.envName}-${name}`;
}
