import { afterEach, describe, expect, it } from "vitest";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const CUSTOMER_KEY = "sk-ant-customer-zzz";

const CREATE = `mutation Create($input: CreateProviderCredentialInput!) {
  createProviderCredential(input: $input) { id provider name status secretHint ownerUserId }
}`;
const REVOKE = `mutation Revoke($id: ID!) { revokeProviderCredential(providerAccountId: $id) { id status } }`;
const BIND = `mutation Bind($apiKeyId: ID!, $provider: String!, $providerAccountId: ID) {
  assignApiKeyProviderAccount(apiKeyId: $apiKeyId, provider: $provider, providerAccountId: $providerAccountId) {
    id providerCredentials { provider providerAccountId name status }
  }
}`;
const LIST = `query { providerAccounts { id provider name status secretHint ownerUserId boundKeyCount } }`;

const messageBody = JSON.stringify({
  model: "claude-router-auto",
  messages: [{ role: "user", content: "debug this flaky auth regression and find root cause" }],
  max_tokens: 1024,
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
