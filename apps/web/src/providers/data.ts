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
      ownerUserId
      boundKeyCount
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
      authStyle
      endpoints {
        dialect
        path
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
  path: string;
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
  apiKey: string;
  baseUrl?: string;
  chatgptAccountId?: string;
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

export async function assignApiKeyProviderAccount(
  apiKeyId: string,
  provider: ProviderName,
  providerAccountId: string | null
) {
  await gqlFetch(AssignApiKeyProviderAccountDocument, { apiKeyId, provider, providerAccountId });
}
