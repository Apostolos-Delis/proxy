import { graphql } from "../gql";
import type { RoutingApiKeysQuery, RoutingConfigDetailViewQuery, RoutingConfigsListQuery } from "../gql/graphql";
import { gqlFetch } from "../graphql";
import type { RoutingConfigDocument } from "../routingConfigEditor";

graphql(`
  fragment RoutingConfigSummaryFields on RoutingConfigSummary {
    id
    name
    slug
    description
    status
    activeVersionId
    assignedApiKeyCount
    updatedAt
    activeVersion {
      id
      version
      configHash
    }
    routeMatrix {
      route
      description
      openaiModel
      openaiEffort
      anthropicModel
      anthropicEffort
    }
  }
`);

graphql(`
  fragment RoutingConfigDetailFields on RoutingConfigDetail {
    config {
      ...RoutingConfigSummaryFields
    }
    versions {
      id
      version
      configHash
      status
      active
      createdAt
      activatedAt
      config
    }
  }
`);

const RoutingConfigsListDocument = graphql(`
  query RoutingConfigsList {
    routingConfigs {
      ...RoutingConfigSummaryFields
    }
  }
`);

const RoutingConfigDetailViewDocument = graphql(`
  query RoutingConfigDetailView($configId: ID!) {
    routingConfig(configId: $configId) {
      ...RoutingConfigDetailFields
    }
  }
`);

const RoutingApiKeysDocument = graphql(`
  query RoutingApiKeys {
    apiKeys {
      id
      name
      userId
      scopes
      routingConfigId
      createdAt
      expiresAt
      revokedAt
      lastUsedAt
      routingConfig {
        id
        name
        status
      }
      providerCredentials {
        provider
        providerAccountId
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

const RevokeApiKeyDocument = graphql(`
  mutation RevokeApiKey($apiKeyId: ID!) {
    revokeApiKey(apiKeyId: $apiKeyId) {
      id
      revokedAt
    }
  }
`);

const CreateRoutingConfigDocument = graphql(`
  mutation CreateRoutingConfig($input: CreateRoutingConfigInput!) {
    createRoutingConfig(input: $input) {
      ...RoutingConfigDetailFields
    }
  }
`);

const CreateRoutingConfigVersionDocument = graphql(`
  mutation CreateRoutingConfigVersion($configId: ID!, $config: JSON!) {
    createRoutingConfigVersion(configId: $configId, config: $config) {
      ...RoutingConfigDetailFields
    }
  }
`);

const ActivateRoutingConfigVersionDocument = graphql(`
  mutation ActivateRoutingConfigVersion($configId: ID!, $versionId: ID!) {
    activateRoutingConfigVersion(configId: $configId, versionId: $versionId) {
      ...RoutingConfigDetailFields
    }
  }
`);

const ArchiveRoutingConfigDocument = graphql(`
  mutation ArchiveRoutingConfig($configId: ID!) {
    archiveRoutingConfig(configId: $configId) {
      ...RoutingConfigDetailFields
    }
  }
`);

const AssignRoutingConfigKeyDocument = graphql(`
  mutation AssignRoutingConfigKey($apiKeyId: ID!, $routingConfigId: ID) {
    assignApiKeyRoutingConfig(apiKeyId: $apiKeyId, routingConfigId: $routingConfigId) {
      id
      routingConfigId
    }
  }
`);

export type RoutingConfigSummary = RoutingConfigsListQuery["routingConfigs"][number];
export type RouteMatrixRow = RoutingConfigSummary["routeMatrix"][number];
export type ApiKeySummary = RoutingApiKeysQuery["apiKeys"][number];

type RawRoutingConfigDetail = NonNullable<RoutingConfigDetailViewQuery["routingConfig"]>;
export type RoutingConfigVersionDetail = Omit<RawRoutingConfigDetail["versions"][number], "config"> & {
  config: RoutingConfigDocument;
};
export type RoutingConfigDetail = {
  config: RawRoutingConfigDetail["config"];
  versions: RoutingConfigVersionDetail[];
};

export type CreateRoutingConfigInput = {
  name: string;
  slug: string;
  description: string | null;
  config: RoutingConfigDocument;
};

// The version config travels as a JSON scalar; narrow it once at the data
// boundary so the editor and detail views work with a typed document.
function mapDetail(raw: RawRoutingConfigDetail): RoutingConfigDetail {
  return {
    config: raw.config,
    versions: raw.versions.map((version) => ({
      ...version,
      config: version.config as RoutingConfigDocument
    }))
  };
}

export async function fetchRoutingConfigs() {
  return (await gqlFetch(RoutingConfigsListDocument)).routingConfigs;
}

export async function fetchApiKeys() {
  return (await gqlFetch(RoutingApiKeysDocument)).apiKeys;
}

export async function fetchRoutingConfigDetail(configId: string): Promise<RoutingConfigDetail | null> {
  const raw = (await gqlFetch(RoutingConfigDetailViewDocument, { configId })).routingConfig;
  return raw ? mapDetail(raw) : null;
}

export async function createRoutingConfig(input: CreateRoutingConfigInput) {
  return mapDetail((await gqlFetch(CreateRoutingConfigDocument, { input })).createRoutingConfig);
}

export async function createRoutingConfigVersion(configId: string, config: RoutingConfigDocument) {
  return mapDetail(
    (await gqlFetch(CreateRoutingConfigVersionDocument, { configId, config })).createRoutingConfigVersion
  );
}

export async function activateRoutingConfigVersion(configId: string, versionId: string) {
  return mapDetail(
    (await gqlFetch(ActivateRoutingConfigVersionDocument, { configId, versionId })).activateRoutingConfigVersion
  );
}

export async function archiveRoutingConfig(configId: string) {
  return mapDetail((await gqlFetch(ArchiveRoutingConfigDocument, { configId })).archiveRoutingConfig);
}

export async function assignApiKeyRoutingConfig(apiKeyId: string, routingConfigId: string | null) {
  await gqlFetch(AssignRoutingConfigKeyDocument, { apiKeyId, routingConfigId });
}

export type CreateApiKeyInput = {
  name: string;
  scopes: string[];
  routingConfigId: string | null;
};

export type CreatedApiKey = Awaited<ReturnType<typeof createApiKey>>;

export async function createApiKey(input: CreateApiKeyInput) {
  return (await gqlFetch(CreateApiKeyDocument, { input })).createApiKey;
}

export async function revokeApiKey(apiKeyId: string) {
  return (await gqlFetch(RevokeApiKeyDocument, { apiKeyId })).revokeApiKey;
}
