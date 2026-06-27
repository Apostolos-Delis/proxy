import { graphql } from "../gql";
import type { ProviderAccountAuthType, ProviderAccountsQuery, ProviderRegistryQuery } from "../gql/graphql";
import { gqlFetch } from "../graphql";

export type ProviderName = string;

const SubscriptionAuthSettingDocument = graphql(`
  query SubscriptionAuthSetting {
    settings {
      subscriptionOAuthEnabled
    }
  }
`);

const ProviderAccountsDocument = graphql(`
  query ProviderAccounts {
    providerAccounts {
      id
      organizationId
      provider
      name
      authType
      status
      baseUrl
      secretHint
      credentialMode
      credentialSourceCategory
      region
      endpointOverride
      discoveryRegions
      ownerUserId
      boundKeyCount
      health {
        status
        cooldownUntil
        lastErrorType
        lastErrorAt
        lastSuccessAt
        lastCheckedAt
        consecutiveFailures
        metadata
        modelHealth {
          providerId
          providerAccountId
          model
          status
          lastErrorType
          lastErrorAt
          lockoutUntil
          consecutiveFailures
          lastSuccessAt
          metadata
        }
      }
      createdAt
      lastUsedAt
    }
  }
`);

const ProviderRegistryDocument = graphql(`
  query ProviderRegistry {
    providers {
      id
      organizationId
      slug
      displayName
      baseUrl
      adapterKind
      authStyle
      endpoints {
        dialect
        path
        operation
      }
      defaultHeaders
      capabilities
      forwardHarnessHeaders
      enabled
      builtin
    }
  }
`);

const CreateProviderCredentialDocument = graphql(`
  mutation CreateProviderCredential($input: CreateProviderCredentialInput!) {
    createProviderCredential(input: $input) {
      id
      name
    }
  }
`);

const UpdateProviderCredentialDocument = graphql(`
  mutation UpdateProviderCredential($input: UpdateProviderCredentialInput!) {
    updateProviderCredential(input: $input) {
      id
      name
      credentialMode
      credentialSourceCategory
      region
      endpointOverride
      discoveryRegions
    }
  }
`);

const CreateProviderCredentialFromLocalAuthDocument = graphql(`
  mutation CreateProviderCredentialFromLocalAuth($input: CreateProviderCredentialFromLocalAuthInput!) {
    createProviderCredentialFromLocalAuth(input: $input) {
      id
      name
    }
  }
`);

const StartProviderCredentialOAuthDocument = graphql(`
  mutation StartProviderCredentialOAuth($input: StartProviderCredentialOAuthInput!) {
    startProviderCredentialOAuth(input: $input) {
      loginId
      verificationUrl
      userCode
    }
  }
`);

const CancelProviderCredentialOAuthDocument = graphql(`
  mutation CancelProviderCredentialOAuth($loginId: ID!) {
    cancelProviderCredentialOAuth(loginId: $loginId) {
      loginId
      status
      providerAccountId
      error
    }
  }
`);

const ProviderCredentialOAuthStatusDocument = graphql(`
  query ProviderCredentialOAuthStatus($loginId: ID!) {
    providerCredentialOAuthStatus(loginId: $loginId) {
      loginId
      status
      providerAccountId
      error
    }
  }
`);

const CreateProviderDocument = graphql(`
  mutation CreateProvider($input: CreateProviderInput!) {
    createProvider(input: $input) {
      id
      slug
      displayName
      baseUrl
      authStyle
      enabled
      builtin
    }
  }
`);

const UpdateProviderDocument = graphql(`
  mutation UpdateProvider($input: UpdateProviderInput!) {
    updateProvider(input: $input) {
      id
      slug
      displayName
      baseUrl
      authStyle
      enabled
      builtin
    }
  }
`);

const DisableProviderDocument = graphql(`
  mutation DisableProvider($providerId: ID!) {
    disableProvider(providerId: $providerId) {
      id
      enabled
    }
  }
`);

const RevokeProviderCredentialDocument = graphql(`
  mutation RevokeProviderCredential($providerAccountId: ID!) {
    revokeProviderCredential(providerAccountId: $providerAccountId) {
      id
      status
    }
  }
`);

const ProbeProviderCredentialDocument = graphql(`
  mutation ProbeProviderCredential($input: ProbeProviderCredentialInput!) {
    probeProviderCredential(input: $input) {
      probeId
      providerAccountId
      provider
      model
      status
      healthStatus
      errorType
      message
      statusCode
      latencyMs
      checkedAt
      stateUpdated
      dimensions
    }
  }
`);

const RefreshBedrockModelCatalogDocument = graphql(`
  mutation RefreshBedrockModelCatalog($input: RefreshBedrockModelCatalogInput!) {
    refreshBedrockModelCatalog(input: $input) {
      providerAccountId
      regions
      status
      error
      modelsSeen
      modelsApplied
      inserted
      updated
      skipped
      errors {
        region
        error
      }
    }
  }
`);

const AssignApiKeyProviderAccountDocument = graphql(`
  mutation AssignApiKeyProviderAccount($apiKeyId: ID!, $provider: String!, $providerAccountId: ID) {
    assignApiKeyProviderAccount(apiKeyId: $apiKeyId, provider: $provider, providerAccountId: $providerAccountId) {
      id
      providerCredentials {
        provider
        providerAccountId
        name
        status
      }
    }
  }
`);

export type ProviderAccountSummary = ProviderAccountsQuery["providerAccounts"][number];
export type ProviderRegistrySummary = ProviderRegistryQuery["providers"][number];
export type ProviderEndpointInput = {
  dialect: string;
  path?: string;
  operation?: string;
};
export type ProviderInput = {
  slug: string;
  displayName: string;
  baseUrl: string;
  authStyle: string;
  endpoints: ProviderEndpointInput[];
  defaultHeaders?: Record<string, string>;
  capabilities?: Record<string, unknown>;
  forwardHarnessHeaders?: boolean;
  enabled?: boolean;
};
export type ProviderUpdateInput = Omit<ProviderInput, "slug"> & {
  providerId: string;
};

export type CreateProviderCredentialInput = {
  provider: ProviderName;
  name: string;
  authType: ProviderAccountAuthType;
  apiKey?: string;
  baseUrl?: string;
  credentialMode?: string;
  region?: string;
  endpointOverride?: string;
  discoveryRegions?: string[];
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  chatgptAccountId?: string;
};
export type UpdateProviderCredentialInput = {
  providerAccountId: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string | null;
  credentialMode?: string;
  region?: string;
  endpointOverride?: string | null;
  discoveryRegions?: string[];
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};
export type CreateProviderCredentialFromLocalAuthInput = {
  provider: ProviderName;
  name: string;
  baseUrl?: string;
};
export type StartProviderCredentialOAuthInput = {
  provider: ProviderName;
  name: string;
};

export async function fetchProviderAccounts() {
  return (await gqlFetch(ProviderAccountsDocument)).providerAccounts;
}

export async function fetchProviderRegistry() {
  return (await gqlFetch(ProviderRegistryDocument)).providers;
}

export async function fetchSubscriptionOAuthEnabled() {
  return (await gqlFetch(SubscriptionAuthSettingDocument)).settings.subscriptionOAuthEnabled;
}

export async function createProviderCredential(input: CreateProviderCredentialInput) {
  return (await gqlFetch(CreateProviderCredentialDocument, { input })).createProviderCredential;
}

export async function updateProviderCredential(input: UpdateProviderCredentialInput) {
  return (await gqlFetch(UpdateProviderCredentialDocument, { input })).updateProviderCredential;
}

export async function createProviderCredentialFromLocalAuth(input: CreateProviderCredentialFromLocalAuthInput) {
  return (await gqlFetch(CreateProviderCredentialFromLocalAuthDocument, { input })).createProviderCredentialFromLocalAuth;
}

export async function startProviderCredentialOAuth(input: StartProviderCredentialOAuthInput) {
  return (await gqlFetch(StartProviderCredentialOAuthDocument, { input })).startProviderCredentialOAuth;
}

export async function cancelProviderCredentialOAuth(loginId: string) {
  return (await gqlFetch(CancelProviderCredentialOAuthDocument, { loginId })).cancelProviderCredentialOAuth;
}

export async function fetchProviderCredentialOAuthStatus(loginId: string) {
  return (await gqlFetch(ProviderCredentialOAuthStatusDocument, { loginId })).providerCredentialOAuthStatus;
}

export async function createProvider(input: ProviderInput) {
  return (await gqlFetch(CreateProviderDocument, { input })).createProvider;
}

export async function updateProvider(input: ProviderUpdateInput) {
  return (await gqlFetch(UpdateProviderDocument, { input })).updateProvider;
}

export async function disableProvider(providerId: string) {
  return (await gqlFetch(DisableProviderDocument, { providerId })).disableProvider;
}

export async function revokeProviderCredential(providerAccountId: string) {
  return (await gqlFetch(RevokeProviderCredentialDocument, { providerAccountId })).revokeProviderCredential;
}

export async function probeProviderCredential(input: { providerAccountId: string; model: string; operation?: string }) {
  return (await gqlFetch(ProbeProviderCredentialDocument, { input })).probeProviderCredential;
}

export async function refreshBedrockModelCatalog(providerAccountId: string) {
  return (await gqlFetch(RefreshBedrockModelCatalogDocument, { input: { providerAccountId } })).refreshBedrockModelCatalog;
}

export async function assignApiKeyProviderAccount(
  apiKeyId: string,
  provider: ProviderName,
  providerAccountId: string | null
) {
  await gqlFetch(AssignApiKeyProviderAccountDocument, { apiKeyId, provider, providerAccountId });
}
