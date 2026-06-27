import {
  bedrockModelMetadataForModel,
  type BedrockModelMetadataEntry
} from "@proxy/db";
import {
  BedrockClient,
  GetInferenceProfileCommand,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand
} from "@aws-sdk/client-bedrock";

import type { ProviderRegistryEntry } from "../persistence/providers.js";
import type { JsonObject, UpstreamCredential } from "../types.js";
import { isRecord } from "../util.js";
import {
  bedrockCredentialResolverConfig,
  type BedrockCredentialResolution,
  resolveBedrockCredentials,
  resolvePlaintextBedrockCredentials
} from "./bedrockCredentials.js";
import {
  bedrockBaseModelId,
  bedrockCrossRegionProfileGeography,
  bedrockInferenceProfileSource
} from "./bedrockModelIds.js";

export type BedrockDiscoveryClientLike = {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
};

export type BedrockDiscoveryClientFactoryInput = {
  region: string;
  endpoint?: string;
  credential: BedrockCredentialResolution;
};

export type BedrockDiscoveryClientFactory = (input: BedrockDiscoveryClientFactoryInput) => BedrockDiscoveryClientLike;
export type BedrockDiscoveryConfig = {
  providerSecretEncryptionKey?: string;
  bedrockOperatorDefaultChainEnabled: boolean;
  bedrockLocalCredentialsEnabled: boolean;
  bedrockAwsProfile?: string;
};

export type BedrockDiscoveredCatalogModel = {
  model: string;
  capabilities: Record<string, unknown>;
  pricing: Record<string, unknown>;
};

export type BedrockDiscoveryResult = {
  models: BedrockDiscoveredCatalogModel[];
  modelsSeen: number;
  modelsSkipped: number;
};

type FoundationModelRecord = {
  modelId: string;
  modelArn?: string;
  displayName?: string;
  providerName?: string;
  inputModalities: string[];
  outputModalities: string[];
  responseStreamingSupported?: boolean;
  lifecycleStatus?: string;
  raw: JsonObject;
};

export class BedrockDiscoveryAdapter {
  constructor(
    private readonly config: BedrockDiscoveryConfig,
    private readonly clientFactory: BedrockDiscoveryClientFactory = defaultBedrockDiscoveryClientFactory
  ) {}

  async discover(input: {
    provider: ProviderRegistryEntry;
    credential?: UpstreamCredential;
    region: string;
    signal?: AbortSignal;
  }): Promise<BedrockDiscoveryResult> {
    const credential = await this.resolveCredential(input.provider, input.credential);
    const client = this.clientFactory({
      region: input.region,
      endpoint: bedrockEndpoint(input.provider, input.credential),
      credential
    });
    const foundationResult = await this.foundationModels(client, input.region, input.signal);
    const profileResult = await this.inferenceProfiles(client, input.region, foundationResult.models, input.signal);
    const models = [
      ...foundationResult.models.map((model) => foundationCatalogModel(model, input.region)),
      ...profileResult.models
    ];
    return {
      models,
      modelsSeen: foundationResult.modelsSeen + profileResult.modelsSeen,
      modelsSkipped: foundationResult.modelsSkipped + profileResult.modelsSkipped
    };
  }

  private async foundationModels(
    client: BedrockDiscoveryClientLike,
    region: string,
    signal: AbortSignal | undefined
  ) {
    const response = await client.send(new ListFoundationModelsCommand({}), { abortSignal: signal });
    const summaries = arrayValue(isRecord(response) ? response.modelSummaries : undefined);
    const models = summaries
      .map((summary) => foundationModelRecord(summary))
      .filter((model): model is FoundationModelRecord => Boolean(model))
      .filter((model) => modelTextCompatible(model))
      .map((model) => ({
        ...model,
        raw: { ...model.raw, discoveryRegion: region }
      }));
    return {
      models,
      modelsSeen: summaries.length,
      modelsSkipped: summaries.length - models.length
    };
  }

  private async inferenceProfiles(
    client: BedrockDiscoveryClientLike,
    region: string,
    foundationModels: FoundationModelRecord[],
    signal: AbortSignal | undefined
  ) {
    const response = await client.send(new ListInferenceProfilesCommand({}), { abortSignal: signal });
    const summaries = arrayValue(isRecord(response) ? response.inferenceProfileSummaries : undefined);
    const foundationByArnOrId = foundationModelIndex(foundationModels);
    const models: BedrockDiscoveredCatalogModel[] = [];

    for (const summary of summaries) {
      const profile = await this.profileDetails(client, summary, signal);
      const row = inferenceProfileCatalogModel(profile, region, foundationByArnOrId);
      if (row) models.push(row);
    }
    return {
      models,
      modelsSeen: summaries.length,
      modelsSkipped: summaries.length - models.length
    };
  }

  private async profileDetails(
    client: BedrockDiscoveryClientLike,
    summary: unknown,
    signal: AbortSignal | undefined
  ) {
    if (!isRecord(summary)) return summary;
    if (arrayValue(summary.models).length > 0) return summary;
    const identifier = stringValue(summary.inferenceProfileId) ?? stringValue(summary.inferenceProfileArn);
    if (!identifier) return summary;
    try {
      return await client.send(new GetInferenceProfileCommand({ inferenceProfileIdentifier: identifier }), { abortSignal: signal });
    } catch {
      return summary;
    }
  }

  private async resolveCredential(
    provider: ProviderRegistryEntry,
    credential: UpstreamCredential | undefined
  ) {
    if (credential?.token) {
      return resolvePlaintextBedrockCredentials({
        plaintext: credential.token,
        accountSettings: credential.providerAccountSettings
      });
    }
    const resolved = await resolveBedrockCredentials({
      accountSettings: credential?.providerAccountSettings,
      providerOrganizationId: provider.organizationId,
      config: bedrockCredentialResolverConfig(this.config)
    });
    if (!resolved) {
      throw new Error("bedrock_credential_unresolved");
    }
    return resolved;
  }
}

function defaultBedrockDiscoveryClientFactory(input: BedrockDiscoveryClientFactoryInput) {
  const clientConfig: ConstructorParameters<typeof BedrockClient>[0] = {
    region: input.region,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.credential.kind === "aws_credentials"
      ? { credentials: input.credential.credentialProvider }
      : { token: { token: input.credential.bearerToken } })
  };
  return new BedrockClient(clientConfig);
}

function foundationModelRecord(value: unknown): FoundationModelRecord | undefined {
  if (!isRecord(value)) return undefined;
  const modelId = stringValue(value.modelId);
  if (!modelId) return undefined;
  const raw = jsonObject(value);
  return {
    modelId,
    modelArn: stringValue(value.modelArn),
    displayName: stringValue(value.modelName) ?? modelId,
    providerName: stringValue(value.providerName),
    inputModalities: normalizeModalities(value.inputModalities),
    outputModalities: normalizeModalities(value.outputModalities),
    responseStreamingSupported: booleanValue(value.responseStreamingSupported),
    lifecycleStatus: lifecycleStatus(value.modelLifecycle),
    raw
  };
}

function foundationCatalogModel(model: FoundationModelRecord, region: string): BedrockDiscoveredCatalogModel {
  const metadata = bedrockModelMetadataForModel(model.modelId);
  return {
    model: model.modelId,
    capabilities: bedrockCapabilities({
      source: "bedrock-discovery",
      displayName: model.displayName,
      providerName: model.providerName,
      dialects: ["bedrock-converse"],
      region,
      modalities: model.inputModalities,
      outputModalities: model.outputModalities,
      streaming: model.responseStreamingSupported,
      image: model.inputModalities.includes("image"),
      bedrockModelSource: "foundation_model",
      bedrockModelArn: model.modelArn,
      bedrockLifecycleStatus: model.lifecycleStatus,
      bedrockMetadata: model.raw
    }, metadata),
    pricing: bedrockPricing(metadata)
  };
}

function inferenceProfileCatalogModel(
  value: unknown,
  region: string,
  foundationByArnOrId: Map<string, FoundationModelRecord>
): BedrockDiscoveredCatalogModel | undefined {
  if (!isRecord(value)) return undefined;
  const profileId = stringValue(value.inferenceProfileId);
  if (!profileId || !activeStatus(stringValue(value.status))) return undefined;
  const profileType = stringValue(value.type);
  const profileGeography = bedrockCrossRegionProfileGeography(profileId);
  if (profileType && profileType !== "SYSTEM_DEFINED") return undefined;
  if (!profileGeography && profileType !== "SYSTEM_DEFINED") return undefined;
  const referencedModels = arrayValue(value.models)
    .map((model) => isRecord(model) ? stringValue(model.modelArn) : undefined)
    .filter((modelArn): modelArn is string => Boolean(modelArn));
  const matchingFoundation = referencedModels
    .map((modelArn) => foundationByArnOrId.get(modelArn) ?? foundationByArnOrId.get(modelIdFromArn(modelArn)))
    .find((model): model is FoundationModelRecord => Boolean(model));
  if (!matchingFoundation) return undefined;
  const metadata = bedrockModelMetadataForModel(profileId, matchingFoundation.modelId);

  return {
    model: profileId,
    capabilities: bedrockCapabilities({
      source: "bedrock-discovery",
      displayName: stringValue(value.inferenceProfileName) ?? profileId,
      dialects: ["bedrock-converse"],
      region,
      modalities: matchingFoundation.inputModalities,
      outputModalities: matchingFoundation.outputModalities,
      streaming: matchingFoundation.responseStreamingSupported,
      image: matchingFoundation.inputModalities.includes("image"),
      bedrockModelSource: "inference_profile",
      bedrockInferenceProfileArn: stringValue(value.inferenceProfileArn),
      bedrockInferenceProfileId: profileId,
      bedrockInferenceProfileType: stringValue(value.type),
      bedrockInferenceProfileSource: bedrockInferenceProfileSource(profileId),
      bedrockInferenceProfileGeography: profileGeography,
      bedrockBaseModelId: bedrockBaseModelId(profileId) ?? matchingFoundation.modelId,
      bedrockFoundationModelId: matchingFoundation.modelId,
      bedrockFoundationModelArn: matchingFoundation.modelArn,
      bedrockMetadata: jsonObject(value)
    }, metadata),
    pricing: bedrockPricing(metadata)
  };
}

function bedrockCapabilities(base: Record<string, unknown>, metadata: BedrockModelMetadataEntry | undefined) {
  if (metadata) {
    return compactCapabilities({
      ...base,
      ...metadata.capabilities,
      warnings: warningList(base.warnings, metadata.capabilities.warnings)
    });
  }
  return compactCapabilities({
    ...base,
    toolCall: false,
    reasoning: false,
    promptCaching: false,
    bedrockMetadataOverlay: "unknown",
    warnings: warningList(base.warnings, ["bedrock_capabilities_unknown", "bedrock_pricing_unknown"])
  });
}

function bedrockPricing(metadata: BedrockModelMetadataEntry | undefined) {
  if (metadata) return { ...metadata.pricing };
  return {
    source: "bedrock-discovery",
    warnings: ["bedrock_pricing_unknown"]
  };
}

function warningList(...values: unknown[]) {
  const warnings = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) warnings.add(item);
    }
  }
  return warnings.size > 0 ? [...warnings] : undefined;
}

function foundationModelIndex(models: FoundationModelRecord[]) {
  const index = new Map<string, FoundationModelRecord>();
  for (const model of models) {
    index.set(model.modelId, model);
    if (model.modelArn) index.set(model.modelArn, model);
  }
  return index;
}

function modelTextCompatible(model: FoundationModelRecord) {
  return activeStatus(model.lifecycleStatus) &&
    model.inputModalities.includes("text") &&
    model.outputModalities.includes("text");
}

function activeStatus(value: string | undefined) {
  return !value || value.toUpperCase() === "ACTIVE";
}

function lifecycleStatus(value: unknown) {
  return isRecord(value) ? stringValue(value.status) : undefined;
}

function normalizeModalities(value: unknown) {
  return arrayValue(value)
    .map((item) => stringValue(item)?.toLowerCase())
    .filter((item): item is string => Boolean(item));
}

function bedrockEndpoint(provider: ProviderRegistryEntry, credential: UpstreamCredential | undefined) {
  return credential?.baseUrl ??
    stringValue(credential?.providerAccountSettings?.endpointOverride) ??
    (!provider.builtin ? provider.baseUrl : undefined);
}

function modelIdFromArn(value: string | undefined) {
  if (!value) return "";
  return value.split("/").at(-1) ?? value;
}

function compactCapabilities(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const json = jsonValue(item);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

function jsonValue(value: unknown): JsonObject[string] | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(jsonValue)
      .filter((item): item is JsonObject[string] => item !== undefined);
  }
  if (isRecord(value)) return jsonObject(value);
  return undefined;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
