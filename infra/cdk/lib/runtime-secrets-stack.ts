import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { CfnSecret, Secret, type ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

import { resourceName, type PromptProxyEnvironmentConfig } from "./config.js";

export type PromptProxyRuntimeSecretsStackProps = StackProps & {
  config: PromptProxyEnvironmentConfig;
};

export class PromptProxyRuntimeSecretsStack extends Stack {
  readonly proxyTokenSecret: Secret;
  readonly adminCredentialsSecret: Secret;
  readonly adminSessionSecret: Secret;
  readonly openAiApiKeySecret: ISecret;
  readonly anthropicApiKeySecret: ISecret;

  constructor(scope: Construct, id: string, props: PromptProxyRuntimeSecretsStackProps) {
    super(scope, id, props);

    const { config } = props;
    const removalPolicy = config.envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    this.proxyTokenSecret = generatedSecret(this, config, "proxy-token", removalPolicy, 48);
    this.adminSessionSecret = generatedSecret(this, config, "admin-session-secret", removalPolicy, 64);
    this.adminCredentialsSecret = new Secret(this, "AdminCredentials", {
      secretName: resourceName(config, "admin-credentials"),
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ email: "admin@prompt-proxy.local" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32
      },
      removalPolicy
    });
    this.openAiApiKeySecret = this.operatorSecret(config, "openai-api-key", removalPolicy);
    this.anthropicApiKeySecret = this.operatorSecret(config, "anthropic-api-key", removalPolicy);

    new CfnOutput(this, "ProxyTokenSecretArn", { value: this.proxyTokenSecret.secretArn });
    new CfnOutput(this, "AdminCredentialsSecretArn", { value: this.adminCredentialsSecret.secretArn });
    new CfnOutput(this, "AdminSessionSecretArn", { value: this.adminSessionSecret.secretArn });
    new CfnOutput(this, "OpenAiApiKeySecretArn", { value: this.openAiApiKeySecret.secretArn });
    new CfnOutput(this, "AnthropicApiKeySecretArn", { value: this.anthropicApiKeySecret.secretArn });
  }

  private operatorSecret(config: PromptProxyEnvironmentConfig, name: string, removalPolicy: RemovalPolicy) {
    const secret = new CfnSecret(this, `${name}Secret`, {
      name: resourceName(config, name),
      secretString: "OPERATOR_POPULATES_BEFORE_USE"
    });
    secret.applyRemovalPolicy(removalPolicy);

    return Secret.fromSecretCompleteArn(this, `${name}SecretRef`, secret.attrId);
  }
}

function generatedSecret(
  scope: Construct,
  config: PromptProxyEnvironmentConfig,
  name: string,
  removalPolicy: RemovalPolicy,
  passwordLength: number
) {
  return new Secret(scope, `${name}Secret`, {
    secretName: resourceName(config, name),
    generateSecretString: {
      excludePunctuation: true,
      passwordLength
    },
    removalPolicy
  });
}
