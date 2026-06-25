export type ProxyEnvironmentConfig = {
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
  minProxyCount: number;
  maxProxyCount: number;
  proxyCpu: number;
  proxyMemoryMiB: number;
  proxyScaleTargetCpuPercent: number;
  proxyScaleTargetMemoryPercent: number;
  requestBodyLimitBytes: number;
  eventWriterMaxEntries: number;
  eventWriterMaxBytes: number;
  eventWriterBatchSize: number;
  eventWriterShutdownTimeoutMs: number;
  databasePoolMax: number;
  databaseInstanceClass: string;
  databaseAllocatedStorageGb: number;
  customDomain?: {
    appHost: string;
    hostedZoneId: string;
    hostedZoneName: string;
  };
};

export function stackName(config: ProxyEnvironmentConfig, suffix: string) {
  return `proxy-${config.envName}-${suffix}`;
}

export function resourceName(config: ProxyEnvironmentConfig, name: string) {
  return `proxy-${config.envName}-${name}`;
}
