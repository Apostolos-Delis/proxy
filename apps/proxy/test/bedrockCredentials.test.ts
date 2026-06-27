import { randomBytes } from "node:crypto";

import { encryptSecret } from "@proxy/db";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  bedrockCredentialEventMetadata,
  bedrockCredentialResolverConfig,
  BedrockCredentialResolverError,
  redactBedrockCredentialError,
  resolveBedrockCredentials,
  type BedrockAwsCredentials,
  type BedrockCredentialSdkFactory
} from "../src/providerAdapters/bedrockCredentials.js";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");

describe("Bedrock credential resolver", () => {
  it("resolves encrypted Bedrock bearer tokens before local credentials", async () => {
    const secret = "bedrock-bearer-secret";
    const sdk = recordingSdk();
    const resolved = await resolveBedrockCredentials({
      encryptedSecret: encryptSecret(secret, ENCRYPTION_KEY),
      accountSettings: { credentialMode: "aws_bedrock_bearer_token" },
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: true,
        localCredentialsEnabled: true,
        env: { AWS_BEARER_TOKEN_BEDROCK: "local-bedrock-bearer-secret" }
      },
      sdk
    });

    expect(resolved).toEqual({
      kind: "bearer_token",
      sourceCategory: "encrypted_bearer_token",
      bearerToken: secret
    });
    expect(sdk.calls).toEqual([]);
    expect(bedrockCredentialEventMetadata(resolved!)).toEqual({
      credentialKind: "bearer_token",
      credentialSourceCategory: "encrypted_bearer_token"
    });
  });

  it("resolves encrypted static keys without exposing key material in metadata", async () => {
    const staticSecret = {
      accessKeyId: "AKIA_TEST_ACCESS",
      secretAccessKey: "very-secret-access-key",
      sessionToken: "very-secret-session-token"
    };
    const resolved = await resolveBedrockCredentials({
      encryptedSecret: encryptSecret(JSON.stringify(staticSecret), ENCRYPTION_KEY),
      accountSettings: { credentialMode: "aws_static_keys" },
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: false,
        localCredentialsEnabled: false
      },
      sdk: recordingSdk()
    });

    expect(resolved?.kind).toBe("aws_credentials");
    expect(resolved?.sourceCategory).toBe("encrypted_static_keys");
    const credentials = resolved?.kind === "aws_credentials"
      ? await resolved.credentialProvider()
      : undefined;
    expect(credentials).toEqual(staticSecret);

    const metadata = JSON.stringify(bedrockCredentialEventMetadata(resolved!));
    expect(metadata).not.toContain(staticSecret.accessKeyId);
    expect(metadata).not.toContain(staticSecret.secretAccessKey);
    expect(metadata).not.toContain(staticSecret.sessionToken);
  });

  it("prefers deployment default chain before local development fallbacks", async () => {
    const sdk = recordingSdk();
    const resolved = await resolveBedrockCredentials({
      accountSettings: { credentialMode: "aws_default_chain" },
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: true,
        localCredentialsEnabled: true,
        awsProfile: "operator-profile",
        env: { AWS_BEARER_TOKEN_BEDROCK: "local-bedrock-bearer-secret" }
      },
      sdk
    });

    expect(resolved?.kind).toBe("aws_credentials");
    expect(resolved?.sourceCategory).toBe("deployment_default_chain");
    expect(sdk.calls).toEqual(["defaultChain"]);
  });

  it("uses local AWS_BEARER_TOKEN_BEDROCK and local default chain only when configured", async () => {
    const bearer = await resolveBedrockCredentials({
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: false,
        localCredentialsEnabled: true,
        env: { AWS_BEARER_TOKEN_BEDROCK: "local-bedrock-bearer-secret" }
      },
      sdk: recordingSdk()
    });
    expect(bearer).toEqual({
      kind: "bearer_token",
      sourceCategory: "local_env_bearer_token",
      bearerToken: "local-bedrock-bearer-secret"
    });

    const sdk = recordingSdk();
    const fallback = await resolveBedrockCredentials({
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: true,
        localCredentialsEnabled: true,
        env: {}
      },
      sdk
    });
    expect(fallback?.kind).toBe("aws_credentials");
    expect(fallback?.sourceCategory).toBe("local_default_chain");
    expect(sdk.calls).toEqual(["defaultChain"]);

    const disabled = await resolveBedrockCredentials({
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: true,
        localCredentialsEnabled: false,
        env: { AWS_BEARER_TOKEN_BEDROCK: "local-bedrock-bearer-secret" }
      },
      sdk: recordingSdk()
    });
    expect(disabled).toBeUndefined();
  });

  it("uses the operator-selected profile for local development only", async () => {
    const sdk = recordingSdk();
    const resolved = await resolveBedrockCredentials({
      accountSettings: { credentialMode: "aws_profile" },
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: false,
        localCredentialsEnabled: true,
        env: { AWS_PROFILE: "local-profile" }
      },
      sdk
    });

    expect(resolved?.kind).toBe("aws_credentials");
    expect(resolved?.sourceCategory).toBe("local_profile");
    expect(sdk.calls).toEqual(["profile:local-profile"]);
  });

  it("rejects operator default-chain credentials for org-defined providers", async () => {
    await expect(resolveBedrockCredentials({
      accountSettings: { credentialMode: "aws_default_chain" },
      providerOrganizationId: "org_123",
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: true,
        localCredentialsEnabled: true,
        env: {}
      },
      sdk: recordingSdk()
    })).rejects.toMatchObject({
      code: "bedrock_operator_credentials_for_org_provider_forbidden"
    });
  });

  it("rejects tenant supplied credential file paths and assume-role settings", async () => {
    await expect(resolveBedrockCredentials({
      accountSettings: {
        credentialMode: "aws_static_keys",
        AWS_SHARED_CREDENTIALS_FILE: "/tmp/credentials"
      },
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: false,
        localCredentialsEnabled: false,
        env: {}
      },
      sdk: recordingSdk()
    })).rejects.toMatchObject({
      code: "bedrock_credential_file_path_forbidden"
    });

    await expect(resolveBedrockCredentials({
      accountSettings: {
        credentialMode: "aws_default_chain",
        roleArn: "arn:aws:iam::123456789012:role/test"
      },
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: true,
        localCredentialsEnabled: false,
        env: {}
      },
      sdk: recordingSdk()
    })).rejects.toMatchObject({
      code: "bedrock_assume_role_not_supported"
    });
  });

  it("redacts secrets from credential errors", async () => {
    const secret = {
      accessKeyId: "AKIA_REDACT_ME",
      secretAccessKey: "do-not-log-this-secret",
      roleArn: "arn:aws:iam::123456789012:role/do-not-log"
    };
    let error: unknown;
    try {
      await resolveBedrockCredentials({
        encryptedSecret: encryptSecret(JSON.stringify(secret), ENCRYPTION_KEY),
        accountSettings: { credentialMode: "aws_static_keys" },
        providerOrganizationId: null,
        config: {
          encryptionKey: ENCRYPTION_KEY,
          operatorDefaultChainEnabled: false,
          localCredentialsEnabled: false,
          env: {}
        },
        sdk: recordingSdk()
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BedrockCredentialResolverError);
    const redacted = JSON.stringify(redactBedrockCredentialError(error));
    expect(redacted).toContain("bedrock_assume_role_not_supported");
    expect(redacted).not.toContain(secret.accessKeyId);
    expect(redacted).not.toContain(secret.secretAccessKey);
    expect(redacted).not.toContain(secret.roleArn);
  });

  it("redacts SDK credential provider failures", async () => {
    const sdkSecret = "sdk-error-should-not-log";
    const resolved = await resolveBedrockCredentials({
      accountSettings: { credentialMode: "aws_default_chain" },
      providerOrganizationId: null,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        operatorDefaultChainEnabled: true,
        localCredentialsEnabled: false,
        env: {}
      },
      sdk: {
        defaultChain() {
          return async () => {
            throw new Error(sdkSecret);
          };
        },
        profile() {
          throw new Error("unexpected profile provider");
        }
      }
    });

    let error: unknown;
    try {
      if (resolved?.kind === "aws_credentials") {
        await resolved.credentialProvider();
      }
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BedrockCredentialResolverError);
    const redacted = JSON.stringify(redactBedrockCredentialError(error));
    expect(redacted).toContain("bedrock_sdk_credential_resolution_failed");
    expect(redacted).not.toContain(sdkSecret);
  });

  it("maps app config into resolver config", () => {
    const config = loadConfig({
      PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
      BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED: "true",
      BEDROCK_LOCAL_CREDENTIALS_ENABLED: "true",
      BEDROCK_AWS_PROFILE: "operator-profile"
    });

    expect(bedrockCredentialResolverConfig(config, {})).toEqual({
      encryptionKey: ENCRYPTION_KEY,
      operatorDefaultChainEnabled: true,
      localCredentialsEnabled: true,
      awsProfile: "operator-profile",
      env: {}
    });
  });
});

function recordingSdk() {
  const calls: string[] = [];
  const credentials: BedrockAwsCredentials = {
    accessKeyId: "AKIA_FAKE",
    secretAccessKey: "fake-secret"
  };
  const sdk: BedrockCredentialSdkFactory & { calls: string[] } = {
    calls,
    defaultChain() {
      calls.push("defaultChain");
      return async () => credentials;
    },
    profile(profile: string) {
      calls.push(`profile:${profile}`);
      return async () => credentials;
    }
  };
  return sdk;
}
