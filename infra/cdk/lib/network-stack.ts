import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import {
  IpAddresses,
  type IVpc,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc
} from "aws-cdk-lib/aws-ec2";
import { ApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";

import { resourceName, type PromptProxyEnvironmentConfig } from "./config.js";

export type PromptProxyNetworkStackProps = StackProps & {
  config: PromptProxyEnvironmentConfig;
};

export class PromptProxyNetworkStack extends Stack {
  readonly vpc: IVpc;
  readonly loadBalancer: ApplicationLoadBalancer;
  readonly albSecurityGroup: SecurityGroup;
  readonly proxySecurityGroup: SecurityGroup;
  readonly operationsSecurityGroup: SecurityGroup;
  readonly databaseSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: PromptProxyNetworkStackProps) {
    super(scope, id, props);

    const { config } = props;
    this.vpc = vpcFor(this, config);

    this.albSecurityGroup = this.securityGroup(config, "alb", "CloudFront-facing ALB security group");
    this.proxySecurityGroup = this.securityGroup(config, "proxy", "Proxy ECS task security group");
    this.operationsSecurityGroup = this.securityGroup(config, "operations", "Operations ECS task security group");
    this.databaseSecurityGroup = this.securityGroup(config, "database", "RDS Postgres security group", false);

    if (!config.cloudFrontOriginFacingPrefixListId) {
      throw new Error("cloudFrontOriginFacingPrefixListId is required for ALB ingress");
    }

    this.albSecurityGroup.addIngressRule(
      Peer.prefixList(config.cloudFrontOriginFacingPrefixListId),
      Port.tcp(80),
      "CloudFront to HTTP origin"
    );
    this.proxySecurityGroup.addIngressRule(this.albSecurityGroup, Port.tcp(8787), "ALB to proxy");
    this.databaseSecurityGroup.addIngressRule(this.proxySecurityGroup, Port.tcp(5432), "Proxy to Postgres");
    this.databaseSecurityGroup.addIngressRule(this.operationsSecurityGroup, Port.tcp(5432), "Operations to Postgres");

    this.loadBalancer = new ApplicationLoadBalancer(this, "Alb", {
      vpc: this.vpc,
      internetFacing: true,
      loadBalancerName: resourceName(config, "alb"),
      securityGroup: this.albSecurityGroup,
      vpcSubnets: { subnetType: SubnetType.PUBLIC }
    });

    new CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    new CfnOutput(this, "AlbDnsName", { value: this.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, "AlbArn", { value: this.loadBalancer.loadBalancerArn });
    new CfnOutput(this, "AlbSecurityGroupId", { value: this.albSecurityGroup.securityGroupId });
    new CfnOutput(this, "ProxySecurityGroupId", { value: this.proxySecurityGroup.securityGroupId });
    new CfnOutput(this, "OperationsSecurityGroupId", { value: this.operationsSecurityGroup.securityGroupId });
    new CfnOutput(this, "DatabaseSecurityGroupId", { value: this.databaseSecurityGroup.securityGroupId });
  }

  private securityGroup(
    config: PromptProxyEnvironmentConfig,
    name: string,
    description: string,
    allowAllOutbound = true
  ) {
    return new SecurityGroup(this, `${name}SecurityGroup`, {
      vpc: this.vpc,
      securityGroupName: resourceName(config, `${name}-sg`),
      description,
      allowAllOutbound
    });
  }
}

function vpcFor(scope: Construct, config: PromptProxyEnvironmentConfig): IVpc {
  if (config.existingVpc) {
    return Vpc.fromVpcAttributes(scope, "Vpc", {
      vpcId: config.existingVpc.vpcId,
      availabilityZones: config.availabilityZones,
      publicSubnetIds: config.existingVpc.publicSubnetIds,
      publicSubnetRouteTableIds: config.existingVpc.publicSubnetRouteTableIds,
      isolatedSubnetIds: config.existingVpc.isolatedSubnetIds,
      isolatedSubnetRouteTableIds: config.existingVpc.isolatedSubnetRouteTableIds
    });
  }

  return new Vpc(scope, "Vpc", {
    vpcName: resourceName(config, "vpc"),
    ipAddresses: IpAddresses.cidr("10.48.0.0/16"),
    availabilityZones: config.availabilityZones,
    natGateways: 0,
    subnetConfiguration: [
      { name: "runtime", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
      { name: "database", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 28 }
    ]
  });
}
