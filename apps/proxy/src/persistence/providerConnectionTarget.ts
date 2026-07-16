import { and, eq } from "drizzle-orm";

import {
  canonicalModels,
  decryptSecret,
  deploymentWireBindings,
  modelDeployments,
  providerConnections,
  type ProxyDbSession
} from "@proxy/db";
import { providerCapabilitiesWithDefaults } from "@proxy/schema";

import { providerRegionSchema } from "../providerAdapters/config.js";
import type { JsonObject, UpstreamCredential } from "../types.js";
import { assertSafeNonSecretConfig } from "./nonSecretConfig.js";
import {
  assertProviderAdapterConfig,
  assertSafeDefaultHeaders,
  ProviderRegistryError,
  trimProviderBaseUrl,
  validateProviderBaseUrl,
  type ProviderNetworkPolicy,
  type ProviderRegistryEndpoint,
  type ProviderRegistryEntry
} from "./providers.js";
import { workspaceScope } from "./scope.js";

export type ProviderConnectionTargetOptions = {
  allowedPrivateUpstreamCidrs: ProviderNetworkPolicy["allowedPrivateUpstreamCidrs"];
  encryptionKey?: string;
  resolveSecretReference?: (input: {
    reference: string;
    provider: string;
    baseUrl: string;
    signal?: AbortSignal;
  }) => string | undefined | Promise<string | undefined>;
};

export class ProviderConnectionTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function loadProviderConnectionTarget(
  db: ProxyDbSession,
  input: {
    organizationId: string;
    workspaceId: string;
    deploymentId: string;
    providerConnectionId: string;
    upstreamModelId: string;
    bindingId: string;
  },
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const [row] = await db
    .select({
      provider: providerConnections.slug,
      baseUrl: providerConnections.baseUrl,
      region: providerConnections.region,
      adapterKind: providerConnections.adapterKind,
      adapterConfig: providerConnections.adapterConfig,
      authStyle: providerConnections.authStyle,
      secretRef: providerConnections.secretRef,
      secretCiphertext: providerConnections.secretCiphertext,
      defaultHeaders: providerConnections.defaultHeaders,
      platformOwned: providerConnections.platformOwned,
      forwardHarnessHeaders: providerConnections.forwardHarnessHeaders,
      deploymentConfig: modelDeployments.config,
      deploymentCapabilities: modelDeployments.capabilities,
      canonicalCapabilities: canonicalModels.capabilities,
      apiWireId: deploymentWireBindings.apiWireId,
      endpointPath: deploymentWireBindings.endpointPath,
      requestConfig: deploymentWireBindings.requestConfig,
      adapterContractVersion: deploymentWireBindings.adapterContractVersion
    })
    .from(modelDeployments)
    .innerJoin(canonicalModels, and(
      eq(canonicalModels.organizationId, modelDeployments.organizationId),
      eq(canonicalModels.workspaceId, modelDeployments.workspaceId),
      eq(canonicalModels.id, modelDeployments.canonicalModelId)
    ))
    .innerJoin(providerConnections, and(
      eq(providerConnections.organizationId, modelDeployments.organizationId),
      eq(providerConnections.workspaceId, modelDeployments.workspaceId),
      eq(providerConnections.id, modelDeployments.providerConnectionId)
    ))
    .innerJoin(deploymentWireBindings, and(
      eq(deploymentWireBindings.organizationId, modelDeployments.organizationId),
      eq(deploymentWireBindings.workspaceId, modelDeployments.workspaceId),
      eq(deploymentWireBindings.deploymentId, modelDeployments.id),
      eq(deploymentWireBindings.providerConnectionId, providerConnections.id)
    ))
    .where(and(
      workspaceScope(modelDeployments, input.organizationId, input.workspaceId),
      workspaceScope(canonicalModels, input.organizationId, input.workspaceId),
      workspaceScope(providerConnections, input.organizationId, input.workspaceId),
      workspaceScope(deploymentWireBindings, input.organizationId, input.workspaceId),
      eq(modelDeployments.id, input.deploymentId),
      eq(modelDeployments.providerConnectionId, input.providerConnectionId),
      eq(modelDeployments.upstreamModelId, input.upstreamModelId),
      eq(deploymentWireBindings.id, input.bindingId),
      eq(modelDeployments.status, "active"),
      eq(canonicalModels.status, "active"),
      eq(providerConnections.status, "active"),
      eq(deploymentWireBindings.enabled, true)
    ))
    .limit(1);
  signal?.throwIfAborted();
  return row;
}

export type ProviderConnectionTargetRow = NonNullable<Awaited<ReturnType<typeof loadProviderConnectionTarget>>>;

export async function materializeProviderConnection(
  row: ProviderConnectionTargetRow,
  input: {
    organizationId: string;
    providerConnectionId: string;
    endpoints: ProviderRegistryEndpoint[];
  },
  options: ProviderConnectionTargetOptions,
  signal?: AbortSignal
): Promise<{
  providerEntry: ProviderRegistryEntry;
  credential?: UpstreamCredential;
}> {
  assertSafeDefaultHeaders(row.defaultHeaders);
  const parsedRegion = row.region ? providerRegionSchema.safeParse(row.region) : undefined;
  if (parsedRegion && !parsedRegion.success) {
    throw new ProviderRegistryError(
      "provider_adapter_config_invalid",
      "Provider region does not satisfy the installed adapter contract."
    );
  }
  const region = parsedRegion?.data;
  const adapterConfig = row.adapterKind === "aws-bedrock-converse" && region
    ? { ...row.adapterConfig, defaultRegion: region }
    : row.adapterConfig;
  const credentialSettings = row.adapterKind === "aws-bedrock-converse" && region
    ? { ...row.adapterConfig, region }
    : row.adapterConfig;
  assertProviderAdapterConfig(row.adapterKind, adapterConfig);
  assertProviderAdapterConfig(row.adapterKind, credentialSettings);
  assertSafeNonSecretConfig(adapterConfig);
  assertSafeNonSecretConfig(credentialSettings);
  const baseUrl = trimProviderBaseUrl(row.baseUrl);
  const pinnedAddress = row.adapterKind === "generic-http-json"
    ? await validateProviderBaseUrl(baseUrl, options)
    : undefined;
  signal?.throwIfAborted();
  const token = row.authStyle === "none"
    ? undefined
    : await providerConnectionToken(row, baseUrl, options, signal);
  signal?.throwIfAborted();
  if (row.authStyle !== "none" && !token && !(row.authStyle === "aws-sdk" && row.platformOwned)) {
    throw new ProviderConnectionTargetError("provider_connection_credential_unavailable");
  }
  return {
    providerEntry: {
      id: input.providerConnectionId,
      organizationId: input.organizationId,
      slug: row.provider,
      baseUrl,
      adapterKind: row.adapterKind,
      adapterConfig,
      authStyle: row.authStyle,
      endpoints: input.endpoints,
      defaultHeaders: row.defaultHeaders,
      capabilities: providerCapabilitiesWithDefaults(row.provider),
      forwardHarnessHeaders: row.forwardHarnessHeaders,
      enabled: true,
      builtin: row.platformOwned,
      pinnedAddress
    },
    credential: token || row.authStyle === "aws-sdk" ? {
      provider: row.provider,
      token: token ?? "",
      providerConnectionId: input.providerConnectionId,
      baseUrl,
      pinnedAddress,
      ...(row.authStyle === "aws-sdk"
        ? { connectionSettings: credentialSettings as JsonObject }
        : {})
    } : undefined
  };
}

async function providerConnectionToken(
  row: Pick<ProviderConnectionTargetRow, "provider" | "secretRef" | "secretCiphertext">,
  baseUrl: string,
  options: ProviderConnectionTargetOptions,
  signal?: AbortSignal
) {
  if (row.secretCiphertext) {
    if (!options.encryptionKey) {
      throw new ProviderConnectionTargetError("provider_secret_encryption_key_unavailable");
    }
    return decryptSecret(row.secretCiphertext, options.encryptionKey);
  }
  if (!row.secretRef || !options.resolveSecretReference) return undefined;
  return options.resolveSecretReference({
    reference: row.secretRef,
    provider: row.provider,
    baseUrl,
    signal
  });
}
