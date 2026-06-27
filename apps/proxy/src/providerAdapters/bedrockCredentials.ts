import { decryptSecret } from "@proxy/db";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";

import { isRecord } from "../util.js";

export type BedrockCredentialAppConfig = {
  providerSecretEncryptionKey?: string;
  bedrockOperatorDefaultChainEnabled: boolean;
  bedrockLocalCredentialsEnabled: boolean;
  bedrockAwsProfile?: string;
};

export const BEDROCK_CREDENTIAL_SOURCE_CATEGORIES = [
  "encrypted_bearer_token",
  "encrypted_static_keys",
  "deployment_default_chain",
  "local_env_bearer_token",
  "local_profile",
  "local_default_chain"
] as const;

export type BedrockCredentialSourceCategory = typeof BEDROCK_CREDENTIAL_SOURCE_CATEGORIES[number];

export const BEDROCK_CREDENTIAL_MODES = [
  "aws_bedrock_bearer_token",
  "aws_static_keys",
  "aws_default_chain",
  "aws_profile"
] as const;

export type BedrockCredentialMode = typeof BEDROCK_CREDENTIAL_MODES[number];

export type BedrockAwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
};

export type BedrockAwsCredentialProvider = () => Promise<BedrockAwsCredentials>;

export type BedrockCredentialResolution =
  | {
      kind: "bearer_token";
      sourceCategory: BedrockCredentialSourceCategory;
      bearerToken: string;
    }
  | {
      kind: "aws_credentials";
      sourceCategory: BedrockCredentialSourceCategory;
      credentialProvider: BedrockAwsCredentialProvider;
    };

export type BedrockCredentialResolverConfig = {
  encryptionKey?: string;
  operatorDefaultChainEnabled: boolean;
  localCredentialsEnabled: boolean;
  awsProfile?: string;
  env?: NodeJS.ProcessEnv;
};

export type BedrockCredentialSdkFactory = {
  defaultChain(): BedrockAwsCredentialProvider;
  profile(profile: string): BedrockAwsCredentialProvider;
};

export type ResolveBedrockCredentialsInput = {
  encryptedSecret?: string | null;
  accountSettings?: unknown;
  providerOrganizationId: string | null;
  config: BedrockCredentialResolverConfig;
  sdk?: BedrockCredentialSdkFactory;
};

export type BedrockCredentialEventMetadata = {
  credentialKind: BedrockCredentialResolution["kind"];
  credentialSourceCategory: BedrockCredentialSourceCategory;
};

export type RedactedBedrockCredentialError = {
  code: string;
  message: string;
};

export class BedrockCredentialResolverError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BedrockCredentialResolverError";
  }
}

const credentialModes = new Set<BedrockCredentialMode>(BEDROCK_CREDENTIAL_MODES);

const forbiddenCredentialFileKeys = new Set([
  "awsconfigfile",
  "awssharedcredentialsfile",
  "awswebidentitytokenfile",
  "configfile",
  "configfilepath",
  "credentialfile",
  "credentialfilepath",
  "credentialprocess",
  "credential_process",
  "profilefile",
  "profilepath",
  "sharedcredentialsfile",
  "sharedcredentialsfilepath",
  "tokenfile",
  "webidentitytokenfile"
]);

const assumeRoleKeys = new Set([
  "assumerole",
  "assumerolearn",
  "externalid",
  "rolearn",
  "rolesessionname",
  "sourcerolearn",
  "targetrolearn"
]);

export async function resolveBedrockCredentials(
  input: ResolveBedrockCredentialsInput
): Promise<BedrockCredentialResolution | undefined> {
  const sdk = input.sdk ?? defaultBedrockCredentialSdkFactory;
  const settings = parseBedrockCredentialSettings(input.accountSettings);
  const providerIsOrgDefined = input.providerOrganizationId !== null;

  if (input.encryptedSecret) {
    assertEncryptionKey(input.config.encryptionKey);
    const plaintext = decryptSecret(input.encryptedSecret, input.config.encryptionKey);
    return resolveEncryptedCredential({
      plaintext,
      mode: settings.credentialMode ?? "aws_bedrock_bearer_token"
    });
  }

  if (settings.credentialMode === "aws_bedrock_bearer_token" || settings.credentialMode === "aws_static_keys") {
    throw new BedrockCredentialResolverError("bedrock_credential_secret_missing");
  }

  if (settings.credentialMode === "aws_default_chain") {
    assertOperatorCredentialAllowed(providerIsOrgDefined);
    if (!input.config.operatorDefaultChainEnabled) {
      throw new BedrockCredentialResolverError("bedrock_default_chain_disabled");
    }
    return {
      kind: "aws_credentials",
      sourceCategory: "deployment_default_chain",
      credentialProvider: redactingCredentialProvider(sdk.defaultChain())
    };
  }

  if (settings.credentialMode === "aws_profile") {
    assertOperatorCredentialAllowed(providerIsOrgDefined);
    return resolveLocalProfileCredential(input.config, sdk);
  }

  if (providerIsOrgDefined) return undefined;

  const env = input.config.env ?? process.env;
  const envBearerToken = stringValue(env.AWS_BEARER_TOKEN_BEDROCK);
  if (input.config.localCredentialsEnabled && envBearerToken) {
    return {
      kind: "bearer_token",
      sourceCategory: "local_env_bearer_token",
      bearerToken: envBearerToken
    };
  }

  const profileCredential = resolveLocalProfileCredential(input.config, sdk, true);
  if (profileCredential) return profileCredential;

  if (input.config.localCredentialsEnabled && input.config.operatorDefaultChainEnabled) {
    return {
      kind: "aws_credentials",
      sourceCategory: "local_default_chain",
      credentialProvider: redactingCredentialProvider(sdk.defaultChain())
    };
  }

  return undefined;
}

export function bedrockCredentialEventMetadata(
  resolution: BedrockCredentialResolution
): BedrockCredentialEventMetadata {
  return {
    credentialKind: resolution.kind,
    credentialSourceCategory: resolution.sourceCategory
  };
}

export function redactBedrockCredentialError(error: unknown): RedactedBedrockCredentialError {
  if (error instanceof BedrockCredentialResolverError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  return {
    code: "bedrock_credential_resolution_failed",
    message: "bedrock_credential_resolution_failed"
  };
}

export function resolvePlaintextBedrockCredentials(input: {
  plaintext: string;
  accountSettings?: unknown;
}): BedrockCredentialResolution {
  const settings = parseBedrockCredentialSettings(input.accountSettings);
  return resolveEncryptedCredential({
    plaintext: input.plaintext,
    mode: settings.credentialMode ?? "aws_bedrock_bearer_token"
  });
}

export function bedrockCredentialResolverConfig(
  config: BedrockCredentialAppConfig,
  env: NodeJS.ProcessEnv = process.env
): BedrockCredentialResolverConfig {
  return {
    encryptionKey: config.providerSecretEncryptionKey,
    operatorDefaultChainEnabled: config.bedrockOperatorDefaultChainEnabled,
    localCredentialsEnabled: config.bedrockLocalCredentialsEnabled,
    awsProfile: config.bedrockAwsProfile,
    env
  };
}

function resolveEncryptedCredential(input: {
  plaintext: string;
  mode: BedrockCredentialMode;
}): BedrockCredentialResolution {
  if (input.mode === "aws_default_chain" || input.mode === "aws_profile") {
    throw new BedrockCredentialResolverError("bedrock_credential_mode_secret_conflict");
  }

  if (input.mode === "aws_bedrock_bearer_token") {
    const bearerToken = input.plaintext.trim();
    if (!bearerToken) throw new BedrockCredentialResolverError("bedrock_bearer_token_empty");
    return {
      kind: "bearer_token",
      sourceCategory: "encrypted_bearer_token",
      bearerToken
    };
  }

  const credentials = parseStaticCredentials(input.plaintext);
  return {
    kind: "aws_credentials",
    sourceCategory: "encrypted_static_keys",
    credentialProvider: async () => ({ ...credentials })
  };
}

function parseBedrockCredentialSettings(settings: unknown) {
  validateSafeCredentialConfig(settings);
  if (settings === undefined || settings === null) return {};
  if (!isRecord(settings)) throw new BedrockCredentialResolverError("bedrock_credential_settings_invalid");
  const credentialMode = optionalCredentialMode(settings.credentialMode);
  return { credentialMode };
}

function optionalCredentialMode(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BedrockCredentialResolverError("bedrock_credential_mode_invalid");
  if (!credentialModes.has(value as BedrockCredentialMode)) {
    throw new BedrockCredentialResolverError("bedrock_credential_mode_invalid");
  }
  return value as BedrockCredentialMode;
}

function parseStaticCredentials(plaintext: string): BedrockAwsCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new BedrockCredentialResolverError("bedrock_static_credentials_invalid");
  }
  validateSafeCredentialConfig(parsed);
  if (!isRecord(parsed)) throw new BedrockCredentialResolverError("bedrock_static_credentials_invalid");
  const accessKeyId = requiredString(parsed.accessKeyId, "bedrock_static_access_key_missing");
  const secretAccessKey = requiredString(parsed.secretAccessKey, "bedrock_static_secret_key_missing");
  const sessionToken = optionalString(parsed.sessionToken);
  return sessionToken
    ? { accessKeyId, secretAccessKey, sessionToken }
    : { accessKeyId, secretAccessKey };
}

function resolveLocalProfileCredential(
  config: BedrockCredentialResolverConfig,
  sdk: BedrockCredentialSdkFactory,
  optional = false
): BedrockCredentialResolution | undefined {
  if (!config.localCredentialsEnabled) {
    if (optional) return undefined;
    throw new BedrockCredentialResolverError("bedrock_local_credentials_disabled");
  }
  const env = config.env ?? process.env;
  const profile = stringValue(config.awsProfile) ?? stringValue(env.AWS_PROFILE);
  if (!profile) {
    if (optional) return undefined;
    throw new BedrockCredentialResolverError("bedrock_local_profile_missing");
  }
  return {
    kind: "aws_credentials",
    sourceCategory: "local_profile",
    credentialProvider: redactingCredentialProvider(sdk.profile(profile))
  };
}

function validateSafeCredentialConfig(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) validateSafeCredentialConfig(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeCredentialKey(key);
    if (forbiddenCredentialFileKeys.has(normalized)) {
      throw new BedrockCredentialResolverError("bedrock_credential_file_path_forbidden");
    }
    if (assumeRoleKeys.has(normalized)) {
      throw new BedrockCredentialResolverError("bedrock_assume_role_not_supported");
    }
    validateSafeCredentialConfig(child);
  }
}

function normalizeCredentialKey(key: string) {
  return key.replace(/[-_]/g, "").toLowerCase();
}

function assertOperatorCredentialAllowed(providerIsOrgDefined: boolean) {
  if (providerIsOrgDefined) {
    throw new BedrockCredentialResolverError("bedrock_operator_credentials_for_org_provider_forbidden");
  }
}

function assertEncryptionKey(value: string | undefined): asserts value is string {
  if (!value) {
    throw new BedrockCredentialResolverError("provider_secret_encryption_key_missing");
  }
}

function requiredString(value: unknown, code: string) {
  const parsed = stringValue(value);
  if (!parsed) throw new BedrockCredentialResolverError(code);
  return parsed;
}

function optionalString(value: unknown) {
  return stringValue(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const defaultBedrockCredentialSdkFactory: BedrockCredentialSdkFactory = {
  defaultChain() {
    const provider = fromNodeProviderChain();
    return sdkCredentialProvider(provider);
  },
  profile(profile: string) {
    const provider = fromIni({ profile });
    return sdkCredentialProvider(provider);
  }
};

function sdkCredentialProvider(provider: () => Promise<unknown>): BedrockAwsCredentialProvider {
  return async () => {
    let value: unknown;
    try {
      value = await provider();
    } catch {
      throw new BedrockCredentialResolverError("bedrock_sdk_credential_resolution_failed");
    }
    return normalizeAwsCredentials(value);
  };
}

function redactingCredentialProvider(provider: BedrockAwsCredentialProvider): BedrockAwsCredentialProvider {
  return async () => {
    try {
      return await provider();
    } catch (error) {
      if (error instanceof BedrockCredentialResolverError) throw error;
      throw new BedrockCredentialResolverError("bedrock_sdk_credential_resolution_failed");
    }
  };
}

function normalizeAwsCredentials(value: unknown): BedrockAwsCredentials {
  if (!isRecord(value)) throw new BedrockCredentialResolverError("bedrock_sdk_credentials_invalid");
  const accessKeyId = requiredString(value.accessKeyId, "bedrock_sdk_access_key_missing");
  const secretAccessKey = requiredString(value.secretAccessKey, "bedrock_sdk_secret_key_missing");
  const sessionToken = optionalString(value.sessionToken);
  const expiration = value.expiration instanceof Date ? value.expiration : undefined;
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(expiration ? { expiration } : {})
  };
}
