import { afterEach, describe, expect, it } from "vitest";
import { CONSERVATIVE_PROVIDER_CACHING_CAPABILITIES } from "@proxy/schema";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const PROVIDER_FIELDS = `
  id
  organizationId
  slug
  displayName
  baseUrl
  adapterKind
  adapterConfig
  authStyle
  endpoints { dialect path operation }
  defaultHeaders
  capabilities
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
        capabilities: { efforts: ["low", "medium", "high"] },
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
      adapterKind: "generic-http-json",
      adapterConfig: {},
      authStyle: "bearer",
      defaultHeaders: { "x-acme-region": "iad" },
      capabilities: {
        efforts: ["low", "medium", "high"],
        promptCaching: CONSERVATIVE_PROVIDER_CACHING_CAPABILITIES
      },
      forwardHarnessHeaders: true,
      enabled: true,
      builtin: false
    });

    const updated = await gql(fixture, UPDATE_PROVIDER, {
      input: {
        providerId: provider.id,
        displayName: "Acme OpenAI Gateway",
        baseUrl: fixture.openai.url,
        adapterKind: "generic-http-json",
        adapterConfig: {},
        authStyle: "none",
        endpoints: [{ dialect: "openai-responses", path: "/responses" }],
        defaultHeaders: {},
        capabilities: { efforts: ["low", "medium", "high", "xhigh"] },
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
      capabilities: {
        efforts: ["low", "medium", "high", "xhigh"],
        promptCaching: CONSERVATIVE_PROVIDER_CACHING_CAPABILITIES
      },
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

  it("accepts local OpenAI-compatible providers without auth when private upstreams are allowed", async () => {
    const fixture = await setup("org_provider_admin_local_none");
    const created = await gql(fixture, CREATE_PROVIDER, {
      input: {
        slug: "local-openai-compatible",
        displayName: "Local OpenAI Compatible",
        baseUrl: fixture.openai.url,
        authStyle: "none",
        endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
        defaultHeaders: {},
        forwardHarnessHeaders: false,
        enabled: true
      }
    });

    expect(created.errors).toBeUndefined();
    expect(created.data?.createProvider).toMatchObject({
      slug: "local-openai-compatible",
      baseUrl: fixture.openai.url,
      authStyle: "none",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions", operation: null }],
      builtin: false
    });
  });

  it("accepts Bedrock adapter provider contracts", async () => {
    const fixture = await setup("org_provider_admin_bedrock_contract");
    const created = await gql(fixture, CREATE_PROVIDER, {
      input: {
        slug: "amazon-bedrock",
        displayName: "Amazon Bedrock",
        baseUrl: fixture.openai.url,
        adapterKind: "aws-bedrock-converse",
        adapterConfig: { defaultRegion: "us-east-1" },
        authStyle: "aws-sdk",
        endpoints: [
          { dialect: "bedrock-converse", operation: "Converse" },
          { dialect: "bedrock-converse", operation: "ConverseStream" }
        ],
        defaultHeaders: {},
        capabilities: {},
        forwardHarnessHeaders: false,
        enabled: true
      }
    });

    expect(created.errors).toBeUndefined();
    expect(created.data?.createProvider).toMatchObject({
      slug: "amazon-bedrock",
      adapterKind: "aws-bedrock-converse",
      adapterConfig: { defaultRegion: "us-east-1" },
      authStyle: "aws-sdk",
      endpoints: [
        { dialect: "bedrock-converse", operation: "Converse", path: null },
        { dialect: "bedrock-converse", operation: "ConverseStream", path: null }
      ]
    });
  });

  it("rejects invalid adapter and endpoint combinations", async () => {
    const fixture = await setup("org_provider_admin_adapter_guards");
    const genericAws = await gql(fixture, CREATE_PROVIDER, {
      input: {
        slug: "bad-auth",
        displayName: "Bad Auth",
        baseUrl: fixture.openai.url,
        adapterKind: "generic-http-json",
        authStyle: "aws-sdk",
        endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
        forwardHarnessHeaders: false,
        enabled: true
      }
    });
    const bedrockPath = await gql(fixture, CREATE_PROVIDER, {
      input: {
        slug: "bad-bedrock",
        displayName: "Bad Bedrock",
        baseUrl: fixture.openai.url,
        adapterKind: "aws-bedrock-converse",
        authStyle: "aws-sdk",
        endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
        forwardHarnessHeaders: false,
        enabled: true
      }
    });

    expect(genericAws.errors?.[0]?.message).toBe("invalid_provider_adapter");
    expect(genericAws.errors?.[0]?.extensions?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "authStyle" })
    ]));
    expect(bedrockPath.errors?.[0]?.message).toBe("invalid_provider_adapter");
    expect(bedrockPath.errors?.[0]?.extensions?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "endpoints.0.path" })
    ]));
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

    const awsHeader = await gql(fixture, CREATE_PROVIDER, {
      input: {
        slug: "bad-aws-headers",
        displayName: "Bad AWS Headers",
        baseUrl: fixture.openai.url,
        authStyle: "none",
        endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
        defaultHeaders: { "x-amz-security-token": "secret" },
        forwardHarnessHeaders: false,
        enabled: true
      }
    });
    expect(awsHeader.errors?.[0]?.message).toBe("provider_default_header_forbidden");
    expect(awsHeader.errors?.[0]?.extensions?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "defaultHeaders" })
    ]));

    const invalidHeader = await gql(fixture, CREATE_PROVIDER, {
      input: {
        slug: "invalid-header",
        displayName: "Invalid Header",
        baseUrl: fixture.openai.url,
        authStyle: "none",
        endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
        defaultHeaders: { "bad header": "value" },
        forwardHarnessHeaders: false,
        enabled: true
      }
    });
    expect(invalidHeader.errors?.[0]?.message).toBe("provider_default_header_invalid");
    expect(invalidHeader.errors?.[0]?.extensions?.issues).toEqual(expect.arrayContaining([
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
