import { afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import {
  apiKeyProviderAccounts,
  apiKeys,
  defaultWorkspaceId,
  decryptSecret,
  encryptSecret,
  providerAccounts,
  users
} from "@prompt-proxy/db";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const CUSTOMER_KEY = "sk-ant-customer-zzz";

const CREATE = `mutation Create($input: CreateProviderCredentialInput!) {
  createProviderCredential(input: $input) { id provider name status authType secretHint ownerUserId }
}`;
const REVOKE = `mutation Revoke($id: ID!) { revokeProviderCredential(providerAccountId: $id) { id status } }`;
const BIND = `mutation Bind($apiKeyId: ID!, $provider: String!, $providerAccountId: ID) {
  assignApiKeyProviderAccount(apiKeyId: $apiKeyId, provider: $provider, providerAccountId: $providerAccountId) {
    id providerCredentials { provider providerAccountId name status }
  }
}`;
const LIST = `query { providerAccounts { id provider name authType status secretHint ownerUserId boundKeyCount } }`;

const messageBody = JSON.stringify({
  model: "claude-router-auto",
  messages: [{ role: "user", content: "debug this flaky auth regression and find root cause" }],
  max_tokens: 1024,
  stream: true
});

const openAIResponseBody = JSON.stringify({
  model: "gpt-router-auto",
  input: [{ role: "user", content: "debug this flaky auth regression and find root cause" }],
  stream: true
});

describe("BYOK provider credentials", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("forwards with the customer key when bound and never exposes the secret", async () => {
    const fixture = await setup("org_byok_bound");

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Acme key", apiKey: CUSTOMER_KEY }
    });
    expect(created.errors).toBeUndefined();
    const account = created.data?.createProviderCredential;
    expect(account.name).toBe("Acme key");
    expect(account.secretHint.startsWith("••••")).toBe(true);
    expect(JSON.stringify(created)).not.toContain(CUSTOMER_KEY);

    const bound = await gql(fixture, BIND, {
      apiKeyId: "org_byok_bound:api-key:default",
      provider: "anthropic",
      providerAccountId: account.id
    });
    expect(bound.errors).toBeUndefined();
    expect(bound.data?.assignApiKeyProviderAccount.providerCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", providerAccountId: account.id })
    ]));

    await sendMessage(fixture);
    const providerCall = fixture.anthropic.records.find((record) => record.path === "/messages");
    expect(providerCall?.headers["x-api-key"]).toBe(CUSTOMER_KEY);

    const list = await gql(fixture, LIST);
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(CUSTOMER_KEY);
    expect(serialized).not.toContain("secret_ciphertext");
  });

  it("falls back to the company key when no credential is bound", async () => {
    const fixture = await setup("org_byok_default");
    await sendMessage(fixture);
    const providerCall = fixture.anthropic.records.find((record) => record.path === "/messages");
    expect(providerCall?.headers["x-api-key"]).toBe("anthropic-upstream-key");
  });

  it("falls back to the company key after a binding is cleared", async () => {
    const fixture = await setup("org_byok_cleared");
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Temp key", apiKey: CUSTOMER_KEY }
    });
    const accountId = created.data?.createProviderCredential.id;
    await gql(fixture, BIND, { apiKeyId: "org_byok_cleared:api-key:default", provider: "anthropic", providerAccountId: accountId });
    await gql(fixture, BIND, { apiKeyId: "org_byok_cleared:api-key:default", provider: "anthropic", providerAccountId: null });

    await sendMessage(fixture);
    const providerCall = fixture.anthropic.records.find((record) => record.path === "/messages");
    expect(providerCall?.headers["x-api-key"]).toBe("anthropic-upstream-key");
  });

  it("allows reusing a revoked credential's label", async () => {
    const fixture = await setup("org_byok_relabel");
    const first = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Acme key", apiKey: CUSTOMER_KEY }
    });
    const accountId = first.data?.createProviderCredential.id;

    const revoke = await gql(fixture, REVOKE, { id: accountId });
    expect(revoke.errors).toBeUndefined();

    const second = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Acme key", apiKey: "sk-ant-customer-rotated" }
    });
    expect(second.errors).toBeUndefined();

    const list = await gql(fixture, LIST);
    const named = (list.data?.providerAccounts ?? []).filter((row: { name: string }) => row.name === "Acme key");
    expect(named).toHaveLength(2);
    expect(named.filter((row: { status: string }) => row.status === "active")).toHaveLength(1);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY }
    });
    return activeFixture;
  }
});

describe("subscription oauth credentials", () => {
  const OAUTH_TOKEN = "sk-ant-oat01-fake-subscription-token";
  const OPENAI_OAUTH_TOKEN = "openai-chatgpt-access-token";
  const CHATGPT_ACCOUNT_ID = "chatgpt-account-test";

  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("stores an oauth credential with the flag on and never returns the token", async () => {
    const fixture = await setup("org_oauth_create", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "My Max sub", authType: "oauth", apiKey: OAUTH_TOKEN }
    });
    expect(created.errors).toBeUndefined();
    const account = created.data?.createProviderCredential;
    expect(account.authType).toBe("oauth");
    expect(account.secretHint.startsWith("••••")).toBe(true);
    expect(account.secretHint).not.toBe(OAUTH_TOKEN);
    expect(JSON.stringify(created)).not.toContain(OAUTH_TOKEN);

    const list = await gql(fixture, LIST);
    expect(JSON.stringify(list)).not.toContain(OAUTH_TOKEN);
    const listed = (list.data?.providerAccounts ?? []).find((row: { id: string }) => row.id === account.id);
    expect(listed?.authType).toBe("oauth");
  });

  it("rejects oauth credentials when the flag is off", async () => {
    const fixture = await setup("org_oauth_disabled");

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "My Max sub", authType: "oauth", apiKey: OAUTH_TOKEN }
    });
    expect(created.errors?.[0]?.message).toBe("subscription_oauth_disabled");
  });

  it("rejects oauth tokens without the setup-token prefix", async () => {
    const fixture = await setup("org_oauth_prefix", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "My Max sub", authType: "oauth", apiKey: "sk-ant-api03-not-a-subscription" }
    });
    expect(created.errors?.[0]?.message).toBe("invalid_subscription_token");
  });

  it("stores an OpenAI oauth credential with a ChatGPT account ID", async () => {
    const fixture = await setup("org_oauth_openai_create", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: {
        provider: "openai",
        name: "My ChatGPT sub",
        authType: "oauth",
        apiKey: OPENAI_OAUTH_TOKEN,
        chatgptAccountId: CHATGPT_ACCOUNT_ID
      }
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createProviderCredential.authType).toBe("oauth");
    expect(JSON.stringify(created)).not.toContain(OPENAI_OAUTH_TOKEN);
  });

  it("extracts OpenAI access tokens from auth JSON without storing refresh tokens", async () => {
    const fixture = await setup("org_oauth_openai_auth_json", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: {
        provider: "openai",
        name: "My ChatGPT sub",
        authType: "oauth",
        apiKey: JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: OPENAI_OAUTH_TOKEN,
            refresh_token: "openai-refresh-token"
          },
          chatgpt_account_id: CHATGPT_ACCOUNT_ID
        })
      }
    });
    expect(created.errors).toBeUndefined();

    const [row] = await fixture.db
      .select({
        secretCiphertext: providerAccounts.secretCiphertext,
        settings: providerAccounts.settings
      })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, created.data?.createProviderCredential.id));
    expect(row).toBeTruthy();
    expect(decryptSecret(row!.secretCiphertext ?? "", ENCRYPTION_KEY)).toBe(OPENAI_OAUTH_TOKEN);
    expect(JSON.stringify(row!.settings)).not.toContain("refresh");
  });

  it("rejects OpenAI oauth credentials without a ChatGPT account ID", async () => {
    const fixture = await setup("org_oauth_openai_account", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: { provider: "openai", name: "My ChatGPT sub", authType: "oauth", apiKey: OPENAI_OAUTH_TOKEN }
    });
    expect(created.errors?.[0]?.message).toBe("invalid_subscription_account_id");
  });

  it("binds an oauth credential to a key owned by the credential creator", async () => {
    const fixture = await setup("org_oauth_bind_same", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createOauthCredential(fixture);

    const bound = await gql(fixture, BIND, {
      apiKeyId: "org_oauth_bind_same:api-key:default",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors).toBeUndefined();
    expect(bound.data?.assignApiKeyProviderAccount.providerCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", providerAccountId: accountId })
    ]));
  });

  it("rejects binding an oauth credential to another user's key", async () => {
    const fixture = await setup("org_oauth_bind_other", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createOauthCredential(fixture);
    await insertKey(fixture, "org_oauth_bind_other", "other-key", "other-user");

    const bound = await gql(fixture, BIND, {
      apiKeyId: "other-key",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors?.[0]?.message).toBe("provider_credential_owner_mismatch");
  });

  it("rejects binding an oauth credential to an ownerless key", async () => {
    const fixture = await setup("org_oauth_bind_null", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createOauthCredential(fixture);
    await insertKey(fixture, "org_oauth_bind_null", "shared-key", null);

    const bound = await gql(fixture, BIND, {
      apiKeyId: "shared-key",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors?.[0]?.message).toBe("provider_credential_owner_mismatch");
  });

  it("rejects binding an oauth credential whose creator was deleted", async () => {
    const fixture = await setup("org_oauth_bind_orphan", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createOauthCredential(fixture);
    await fixture.db
      .update(providerAccounts)
      .set({ createdByUserId: null })
      .where(eq(providerAccounts.id, accountId));

    const bound = await gql(fixture, BIND, {
      apiKeyId: "org_oauth_bind_orphan:api-key:default",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors?.[0]?.message).toBe("provider_credential_owner_mismatch");
  });

  it("rejects rebinding an existing binding to an oauth credential the key owner does not own", async () => {
    const fixture = await setup("org_oauth_rebind", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await insertKey(fixture, "org_oauth_rebind", "other-key", "other-user");
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Shared key", apiKey: CUSTOMER_KEY }
    });
    const apiCredentialId = created.data?.createProviderCredential.id;
    const first = await gql(fixture, BIND, {
      apiKeyId: "other-key",
      provider: "anthropic",
      providerAccountId: apiCredentialId
    });
    expect(first.errors).toBeUndefined();

    const oauthAccountId = await createOauthCredential(fixture);
    const rebound = await gql(fixture, BIND, {
      apiKeyId: "other-key",
      provider: "anthropic",
      providerAccountId: oauthAccountId
    });
    expect(rebound.errors?.[0]?.message).toBe("provider_credential_owner_mismatch");
  });

  it("still binds api_key credentials to another user's key", async () => {
    const fixture = await setup("org_apikey_bind_other", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Shared key", apiKey: CUSTOMER_KEY }
    });
    const accountId = created.data?.createProviderCredential.id;
    await insertKey(fixture, "org_apikey_bind_other", "other-key", "other-user");

    const bound = await gql(fixture, BIND, {
      apiKeyId: "other-key",
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors).toBeUndefined();
  });

  it("defaults to api_key when authType is omitted, with the flag on", async () => {
    const fixture = await setup("org_oauth_default", { SUBSCRIPTION_OAUTH_ENABLED: "true" });

    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Plain key", apiKey: CUSTOMER_KEY }
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createProviderCredential.authType).toBe("api_key");
  });

  it("resolves an oauth credential with authType oauth when the flag is on", async () => {
    const fixture = await setup("org_oauth_resolve", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createBoundOauthCredential(fixture, "org_oauth_resolve");

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_oauth_resolve",
      apiKeyId: "org_oauth_resolve:api-key:default",
      provider: "anthropic"
    });
    expect(credential).toMatchObject({
      provider: "anthropic",
      authType: "oauth",
      token: OAUTH_TOKEN,
      providerAccountId: accountId
    });
  });

  it("resolves an OpenAI oauth credential with the ChatGPT account ID", async () => {
    const fixture = await setup("org_oauth_openai_resolve", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createBoundOpenAIOauthCredential(fixture, "org_oauth_openai_resolve");

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_oauth_openai_resolve",
      apiKeyId: "org_oauth_openai_resolve:api-key:default",
      provider: "openai"
    });
    expect(credential).toMatchObject({
      provider: "openai",
      authType: "oauth",
      token: OPENAI_OAUTH_TOKEN,
      providerAccountId: accountId,
      chatgptAccountId: CHATGPT_ACCOUNT_ID
    });
  });

  it("resolves oauth accounts to undefined when the flag is off", async () => {
    const fixture = await setup("org_oauth_resolve_off");
    await insertBoundOauthAccount(fixture, "org_oauth_resolve_off", encryptSecret(OAUTH_TOKEN, ENCRYPTION_KEY));

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_oauth_resolve_off",
      apiKeyId: "org_oauth_resolve_off:api-key:default",
      provider: "anthropic"
    });
    expect(credential).toBeUndefined();
  });

  it("resolves an oauth account with null ciphertext to undefined", async () => {
    const fixture = await setup("org_oauth_resolve_null", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await insertBoundOauthAccount(fixture, "org_oauth_resolve_null", null);

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_oauth_resolve_null",
      apiKeyId: "org_oauth_resolve_null:api-key:default",
      provider: "anthropic"
    });
    expect(credential).toBeUndefined();
  });

  it("resolves api_key credentials with authType api_key", async () => {
    const fixture = await setup("org_apikey_resolve");
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "Acme key", apiKey: CUSTOMER_KEY }
    });
    const accountId = created.data?.createProviderCredential.id;
    await gql(fixture, BIND, {
      apiKeyId: "org_apikey_resolve:api-key:default",
      provider: "anthropic",
      providerAccountId: accountId
    });

    const credential = await fixture.persistence.providerCredentials.resolveForRequest({
      organizationId: "org_apikey_resolve",
      apiKeyId: "org_apikey_resolve:api-key:default",
      provider: "anthropic"
    });
    expect(credential).toMatchObject({ authType: "api_key", token: CUSTOMER_KEY });
  });

  it("forwards an oauth credential as a bearer token, never x-api-key", async () => {
    const fixture = await setup("org_oauth_forward", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOauthCredential(fixture, "org_oauth_forward");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20"
      },
      body: messageBody
    });
    expect(response.status).toBe(200);
    await response.text();

    const providerCall = fixture.anthropic.records.find((record) => record.path === "/messages");
    expect(providerCall?.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(providerCall?.headers["x-api-key"]).toBeUndefined();
    expect(providerCall?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(providerCall?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("stops forwarding a cached oauth credential the moment the flag is off", async () => {
    const fixture = await setup("org_oauth_killswitch", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOauthCredential(fixture, "org_oauth_killswitch");

    await sendMessage(fixture);
    expect(fixture.anthropic.records.at(-1)?.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);

    // The first request cached the decrypted credential for 30s; flipping the
    // running server's flag must still cut it off at forward time.
    fixture.config.subscriptionOAuthEnabled = false;
    await sendMessage(fixture);

    const providerCall = fixture.anthropic.records.at(-1);
    expect(providerCall?.headers["x-api-key"]).toBe("anthropic-upstream-key");
    expect(providerCall?.headers.authorization).toBeUndefined();
  });

  it("forwards count_tokens with the bearer token when oauth is bound", async () => {
    const fixture = await setup("org_oauth_count", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOauthCredential(fixture, "org_oauth_count");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        messages: [{ role: "user", content: "debug auth" }]
      })
    });
    expect(response.status).toBe(200);

    const providerCall = fixture.anthropic.records.find((record) => record.path === "/messages/count_tokens");
    expect(providerCall?.headers.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(providerCall?.headers["x-api-key"]).toBeUndefined();
  });

  it("forwards OpenAI oauth credentials to the Codex backend with a ChatGPT account header", async () => {
    const fixture = await setup("org_oauth_openai_forward", { SUBSCRIPTION_OAUTH_ENABLED: "true" }, {
      openAIChatGPTOptions: {}
    });
    await createBoundOpenAIOauthCredential(fixture, "org_oauth_openai_forward");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "x-api-key": "proxy-token",
        "content-type": "application/json",
        "x-codex-turn-state": "turn-state"
      },
      body: openAIResponseBody
    });
    expect(response.status).toBe(200);
    await response.text();

    const defaultProviderCall = fixture.openai.records.find((record) => record.body.model === "gpt-5.5");
    const providerCall = fixture.openaiChatgpt.records.find((record) => record.body.model === "gpt-5.5");
    expect(defaultProviderCall).toBeUndefined();
    expect(providerCall?.headers.authorization).toBe(`Bearer ${OPENAI_OAUTH_TOKEN}`);
    expect(providerCall?.headers["chatgpt-account-id"]).toBe(CHATGPT_ACCOUNT_ID);
    expect(providerCall?.headers["x-codex-turn-state"]).toBe("turn-state");
  });

  it("stops forwarding a cached OpenAI oauth credential the moment the flag is off", async () => {
    const fixture = await setup("org_oauth_openai_killswitch", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOpenAIOauthCredential(fixture, "org_oauth_openai_killswitch");

    await sendOpenAIResponse(fixture);
    expect(fixture.openai.records.find((record) => record.body.model === "gpt-5.5")?.headers.authorization).toBe(`Bearer ${OPENAI_OAUTH_TOKEN}`);

    fixture.config.subscriptionOAuthEnabled = false;
    await sendOpenAIResponse(fixture);

    const providerCalls = fixture.openai.records.filter((record) => record.body.model === "gpt-5.5");
    const providerCall = providerCalls.at(-1);
    expect(providerCall?.headers.authorization).toBe("Bearer openai-upstream-key");
    expect(providerCall?.headers["chatgpt-account-id"]).toBeUndefined();
  });

  it("serves cached oauth credentials within the TTL without re-reading the row", async () => {
    const fixture = await setup("org_oauth_cache", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    const accountId = await createBoundOauthCredential(fixture, "org_oauth_cache");

    const resolveInput = {
      organizationId: "org_oauth_cache",
      apiKeyId: "org_oauth_cache:api-key:default",
      provider: "anthropic"
    } as const;
    const first = await fixture.persistence.providerCredentials.resolveForRequest(resolveInput);
    expect(first?.authType).toBe("oauth");

    // A fresh read would reject the now-disabled row, so a credential here can
    // only come from the cache. SA-006's forward-time flag re-check exists
    // because of this window.
    await fixture.db
      .update(providerAccounts)
      .set({ status: "disabled" })
      .where(eq(providerAccounts.id, accountId));
    const second = await fixture.persistence.providerCredentials.resolveForRequest(resolveInput);
    expect(second?.providerAccountId).toBe(accountId);
  });

  it("re-resolves an oauth account to undefined once the cache expires with the flag off", async () => {
    const fixture = await setup("org_oauth_expiry", { SUBSCRIPTION_OAUTH_ENABLED: "true" });
    await createBoundOauthCredential(fixture, "org_oauth_expiry");

    const resolveInput = {
      organizationId: "org_oauth_expiry",
      apiKeyId: "org_oauth_expiry:api-key:default",
      provider: "anthropic"
    } as const;
    const first = await fixture.persistence.providerCredentials.resolveForRequest(resolveInput);
    expect(first?.authType).toBe("oauth");

    fixture.config.subscriptionOAuthEnabled = false;
    const afterExpiry = await fixture.persistence.providerCredentials.resolveForRequest(
      resolveInput,
      Date.now() + 31_000
    );
    expect(afterExpiry).toBeUndefined();
  });

  async function setup(
    organizationId: string,
    envOverrides: Record<string, string> = {},
    options: Pick<NonNullable<Parameters<typeof captureFixture>[3]>, "openAIChatGPTOptions"> = {}
  ) {
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      ...options,
      envOverrides: { PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY, ...envOverrides }
    });
    return activeFixture;
  }

  async function createOauthCredential(fixture: PromptTestFixture) {
    const created = await gql(fixture, CREATE, {
      input: { provider: "anthropic", name: "My Max sub", authType: "oauth", apiKey: OAUTH_TOKEN }
    });
    expect(created.errors).toBeUndefined();
    return created.data?.createProviderCredential.id as string;
  }

  async function createBoundOauthCredential(fixture: PromptTestFixture, organizationId: string) {
    const accountId = await createOauthCredential(fixture);
    const bound = await gql(fixture, BIND, {
      apiKeyId: `${organizationId}:api-key:default`,
      provider: "anthropic",
      providerAccountId: accountId
    });
    expect(bound.errors).toBeUndefined();
    return accountId;
  }

  async function createBoundOpenAIOauthCredential(fixture: PromptTestFixture, organizationId: string) {
    const created = await gql(fixture, CREATE, {
      input: {
        provider: "openai",
        name: "My ChatGPT sub",
        authType: "oauth",
        apiKey: OPENAI_OAUTH_TOKEN,
        chatgptAccountId: CHATGPT_ACCOUNT_ID
      }
    });
    expect(created.errors).toBeUndefined();
    const accountId = created.data?.createProviderCredential.id as string;
    const bound = await gql(fixture, BIND, {
      apiKeyId: `${organizationId}:api-key:default`,
      provider: "openai",
      providerAccountId: accountId
    });
    expect(bound.errors).toBeUndefined();
    return accountId;
  }

  // Simulates rows created while the flag was on (create+bind are flag-gated,
  // so a flag-off fixture cannot mint them through the admin API).
  async function insertBoundOauthAccount(
    fixture: PromptTestFixture,
    organizationId: string,
    ciphertext: string | null
  ) {
    const accountId = `${organizationId}:oauth-account`;
    await fixture.db.insert(providerAccounts).values({
      id: accountId,
      organizationId,
      provider: "anthropic",
      name: "Pasted subscription",
      authType: "oauth",
      secretCiphertext: ciphertext,
      secretHint: "••••oken",
      createdByUserId: "local-user",
      status: "active"
    });
    await fixture.db.insert(apiKeyProviderAccounts).values({
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      apiKeyId: `${organizationId}:api-key:default`,
      provider: "anthropic",
      providerAccountId: accountId,
      createdByUserId: "local-user"
    });
    return accountId;
  }

  // Direct inserts: the admin API cannot mint keys for other users. These
  // minimal rows only feed the bind guardrail, which reads id + userId.
  async function insertKey(
    fixture: PromptTestFixture,
    organizationId: string,
    apiKeyId: string,
    userId: string | null
  ) {
    if (userId) {
      await fixture.db.insert(users).values({
        id: userId,
        email: `${userId}@example.com`,
        name: userId
      });
    }
    await fixture.db.insert(apiKeys).values({
      id: apiKeyId,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      userId,
      keyHash: `hash-${apiKeyId}`,
      name: apiKeyId,
      scopes: ["proxy"]
    });
  }
});

function gql(fixture: PromptTestFixture, query: string, variables?: Record<string, unknown>) {
  return adminGql(fixture.proxyUrl, fixture.adminHeaders, query, variables);
}

async function sendMessage(fixture: PromptTestFixture) {
  const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": "proxy-token",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    body: messageBody
  });
  expect(response.status).toBe(200);
  await response.text();
}

async function sendOpenAIResponse(fixture: PromptTestFixture) {
  const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "x-api-key": "proxy-token",
      "content-type": "application/json"
    },
    body: openAIResponseBody
  });
  expect(response.status).toBe(200);
  await response.text();
}
