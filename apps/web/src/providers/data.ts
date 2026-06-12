import { graphql } from "../gql";
import type { ProviderAccountAuthType, ProviderAccountsQuery } from "../gql/graphql";
import { gqlFetch } from "../graphql";

export type ProviderName = "anthropic" | "openai";

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
      secretHint
      ownerUserId
      boundKeyCount
      createdAt
      lastUsedAt
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

export type CreateProviderCredentialInput = {
  provider: ProviderName;
  name: string;
  authType: ProviderAccountAuthType;
  apiKey: string;
  chatgptAccountId?: string;
};

export async function fetchProviderAccounts() {
  return (await gqlFetch(ProviderAccountsDocument)).providerAccounts;
}

export async function fetchSubscriptionOAuthEnabled() {
  return (await gqlFetch(SubscriptionAuthSettingDocument)).settings.subscriptionOAuthEnabled;
}

export async function createProviderCredential(input: CreateProviderCredentialInput) {
  return (await gqlFetch(CreateProviderCredentialDocument, { input })).createProviderCredential;
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
