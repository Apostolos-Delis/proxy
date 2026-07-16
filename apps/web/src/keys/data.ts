import { GATEWAY_SETUP_MODEL_PREFERENCE } from "@proxy/schema";

import { graphql } from "../gql";
import type { GatewayAccessProfilesQuery, GatewayApiKeysQuery } from "../gql/graphql";
import { gqlFetch } from "../graphql";

const GatewayApiKeysDocument = graphql(`
  query GatewayApiKeys {
    apiKeys {
      id
      name
      userId
      accessProfileId
      createdAt
      expiresAt
      revokedAt
      lastUsedAt
      accessProfile {
        id
        name
        status
      }
    }
  }
`);

const CreateApiKeyDocument = graphql(`
  mutation CreateApiKey($input: CreateApiKeyInput!) {
    createApiKey(input: $input) {
      apiKey {
        id
        name
      }
      secret
    }
  }
`);

const GatewayAccessProfilesDocument = graphql(`
  query GatewayAccessProfiles {
    gatewayAccessProfiles {
      id
      slug
      name
      description
      enabled
    }
    gatewayModelGrants {
      accessProfileId
      logicalModelId
      allowedOperations
      enabled
    }
    gatewayLogicalModels {
      id
      slug
      enabled
    }
  }
`);

const AssignApiKeyAccessProfileDocument = graphql(`
  mutation AssignApiKeyAccessProfile($apiKeyId: ID!, $accessProfileId: ID!) {
    assignGatewayApiKeyAccessProfile(apiKeyId: $apiKeyId, accessProfileId: $accessProfileId) {
      apiKeyId
      accessProfileId
    }
  }
`);

const RevokeApiKeyDocument = graphql(`
  mutation RevokeApiKey($apiKeyId: ID!) {
    revokeApiKey(apiKeyId: $apiKeyId) {
      id
      revokedAt
    }
  }
`);

const ApiKeyVerificationDocument = graphql(`
  query ApiKeyVerification($apiKeyId: ID!) {
    apiKey(apiKeyId: $apiKeyId) {
      id
      lastUsedAt
    }
  }
`);

export type ApiKeySummary = GatewayApiKeysQuery["apiKeys"][number];

export type CreateApiKeyInput = {
  name: string;
  accessProfileId: string;
};

export type AccessProfileSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  setupModel: string;
};

export type CreatedApiKey = Awaited<ReturnType<typeof createApiKey>>;

export async function fetchApiKeys() {
  return (await gqlFetch(GatewayApiKeysDocument)).apiKeys;
}

export async function createApiKey(input: CreateApiKeyInput) {
  return (await gqlFetch(CreateApiKeyDocument, { input })).createApiKey;
}

export async function fetchAccessProfiles() {
  return accessProfileSummaries(await gqlFetch(GatewayAccessProfilesDocument));
}

export function accessProfileSummaries(data: GatewayAccessProfilesQuery) {
  const models = new Map(
    data.gatewayLogicalModels
      .filter((model) => model.enabled)
      .map((model) => [model.id, model.slug])
  );
  const profiles: AccessProfileSummary[] = [];
  for (const profile of data.gatewayAccessProfiles) {
    if (!profile.enabled) continue;
    const grantedModels = data.gatewayModelGrants
      .filter((grant) => (
        grant.enabled &&
        grant.accessProfileId === profile.id &&
        grant.allowedOperations.includes("text.generate") &&
        grant.allowedOperations.includes("model.list")
      ))
      .map((grant) => models.get(grant.logicalModelId))
      .filter((model): model is string => Boolean(model));
    const setupModel = GATEWAY_SETUP_MODEL_PREFERENCE.find((model) => grantedModels.includes(model)) ?? grantedModels[0];
    if (!setupModel) continue;
    profiles.push({
      id: profile.id,
      slug: profile.slug,
      name: profile.name,
      description: profile.description,
      setupModel
    });
  }
  return profiles;
}

export async function assignApiKeyAccessProfile(apiKeyId: string, accessProfileId: string) {
  return (await gqlFetch(AssignApiKeyAccessProfileDocument, { apiKeyId, accessProfileId }))
    .assignGatewayApiKeyAccessProfile;
}

export async function revokeApiKey(apiKeyId: string) {
  return (await gqlFetch(RevokeApiKeyDocument, { apiKeyId })).revokeApiKey;
}

export async function fetchApiKeyVerification(apiKeyId: string) {
  return (await gqlFetch(ApiKeyVerificationDocument, { apiKeyId })).apiKey;
}
