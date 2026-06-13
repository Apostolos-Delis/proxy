import { afterEach, describe, expect, it } from "vitest";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const PROVIDER_FIELDS = `
  id
  organizationId
  slug
  displayName
  baseUrl
  authStyle
  endpoints { dialect path }
  defaultHeaders
  forwardHarnessHeaders
  enabled
  builtin
`;

const CREATE_PROVIDER = `mutation CreateProvider($input: CreateProviderInput!) {
  createProvider(input: $input) { ${PROVIDER_FIELDS} }
}`;

const UPDATE_PROVIDER = `mutation UpdateProvider($input: UpdateProviderInput!) {
  updateProvider(input: $input) { ${PROVIDER_FIELDS} }
}`;

const DISABLE_PROVIDER = `mutation DisableProvider($providerId: ID!) {
  disableProvider(providerId: $providerId) { ${PROVIDER_FIELDS} }
}`;

const LIST_PROVIDERS = `query Providers { providers { ${PROVIDER_FIELDS} } }`;

describe("provider registry admin GraphQL", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("creates, updates, and disables an org provider", async () => {
    const fixture = await setup("org_provider_admin_crud");
    const created = await gql(fixture, CREATE_PROVIDER, {
      input: {
        slug: "acme-openai",
        displayName: "Acme OpenAI",
        baseUrl: fixture.openai.url,
        authStyle: "bearer",
        endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
        defaultHeaders: { "x-acme-region": "iad" },
        forwardHarnessHeaders: true,
        enabled: true
      }
    });
    expect(created.errors).toBeUndefined();
    const provider = created.data?.createProvider;
    expect(provider).toMatchObject({
      organizationId: "org_provider_admin_crud",
      slug: "acme-openai",
      displayName: "Acme OpenAI",
      baseUrl: fixture.openai.url,
      authStyle: "bearer",
      defaultHeaders: { "x-acme-region": "iad" },
      forwardHarnessHeaders: true,
      enabled: true,
      builtin: false
    });

    const updated = await gql(fixture, UPDATE_PROVIDER, {
      input: {
        providerId: provider.id,
        displayName: "Acme OpenAI Gateway",
        baseUrl: fixture.openai.url,
        authStyle: "none",
        endpoints: [{ dialect: "openai-responses", path: "/responses" }],
        defaultHeaders: {},
        forwardHarnessHeaders: false,
        enabled: true
      }
    });
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updateProvider).toMatchObject({
      id: provider.id,
      slug: "acme-openai",
      displayName: "Acme OpenAI Gateway",
      authStyle: "none",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      forwardHarnessHeaders: false,
      enabled: true
    });

    const disabled = await gql(fixture, DISABLE_PROVIDER, { providerId: provider.id });
    expect(disabled.errors).toBeUndefined();
    expect(disabled.data?.disableProvider).toMatchObject({
      id: provider.id,
      enabled: false
    });
  });

  it("returns field-level guard errors for unsafe provider writes", async () => {
    const fixture = await setup("org_provider_admin_guards");
    const authHeader = await gql(fixture, CREATE_PROVIDER, {
      input: {
        slug: "bad-headers",
        displayName: "Bad Headers",
        baseUrl: fixture.openai.url,
        authStyle: "bearer",
        endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
        defaultHeaders: { authorization: "Bearer secret" },
        forwardHarnessHeaders: false,
        enabled: true
      }
    });
    expect(authHeader.errors?.[0]?.message).toBe("provider_default_header_forbidden");
    expect(authHeader.errors?.[0]?.extensions?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "defaultHeaders" })
    ]));

    const blockedBaseUrl = await gql(fixture, CREATE_PROVIDER, {
      input: {
        slug: "metadata",
        displayName: "Metadata",
        baseUrl: "http://169.254.169.254/latest",
        authStyle: "none",
        endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
        defaultHeaders: {},
        forwardHarnessHeaders: false,
        enabled: true
      }
    });
    expect(blockedBaseUrl.errors?.[0]?.message).toBe("provider_base_url_blocked");
    expect(blockedBaseUrl.errors?.[0]?.extensions?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "baseUrl" })
    ]));
  });

  it("keeps builtin provider rows read-only", async () => {
    const fixture = await setup("org_provider_admin_builtin");
    const listed = await gql(fixture, LIST_PROVIDERS);
    const builtinOpenAI = listed.data?.providers.find((provider: { slug: string; builtin: boolean }) =>
      provider.slug === "openai" && provider.builtin
    );
    expect(builtinOpenAI).toBeTruthy();

    const result = await gql(fixture, UPDATE_PROVIDER, {
      input: {
        providerId: builtinOpenAI.id,
        displayName: "Edited OpenAI",
        baseUrl: fixture.openai.url,
        authStyle: "bearer",
        endpoints: [{ dialect: "openai-responses", path: "/responses" }],
        defaultHeaders: {},
        forwardHarnessHeaders: true,
        enabled: true
      }
    });
    expect(result.errors?.[0]?.message).toBe("provider_builtin_readonly");
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: { ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8" }
    });
    return activeFixture;
  }
});

function gql(fixture: PromptTestFixture, query: string, variables?: Record<string, unknown>) {
  return adminGql(fixture.proxyUrl, fixture.adminHeaders, query, variables);
}
