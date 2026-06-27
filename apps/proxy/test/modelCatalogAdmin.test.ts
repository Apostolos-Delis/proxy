import { afterEach, describe, expect, it } from "vitest";

import { modelCatalog, providerAccounts, providers } from "@proxy/db";

import { ModelDiscoveryStore } from "../src/modelDiscovery.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const MODEL_CATALOG_FIELDS = `
  provider
  model
  displayName
  catalogSource
  providerAccountId
  region
  bedrockModelSource
  bedrockInferenceProfileArn
  bedrockInferenceProfileId
  bedrockInferenceProfileSource
  bedrockInferenceProfileGeography
  bedrockBaseModelId
  bedrockFoundationModelId
  dialects
  contextWindow
  maxOutputTokens
  supportsStreaming
  supportsTools
  supportsImages
  supportsReasoning
  warnings
  pricingKnown
  inputCostPerMtok
  outputCostPerMtok
  cacheReadCostPerMtok
  cacheWriteCostPerMtok
`;

const UPSERT_MODEL = `mutation Upsert($input: UpsertModelCatalogInput!) {
  upsertModelCatalogEntry(input: $input) { ${MODEL_CATALOG_FIELDS} }
}`;

const MODEL_CATALOG = `query ModelCatalog { modelCatalog { ${MODEL_CATALOG_FIELDS} } }`;

const ROUTING_DETAIL = `query Detail($configId: ID!) {
  routingConfig(configId: $configId) {
    versions { id active config }
  }
}`;

const CREATE_VERSION = `mutation CreateVersion($configId: ID!, $config: JSON!) {
  createRoutingConfigVersion(configId: $configId, config: $config) {
    versions { id active config }
  }
}`;

describe("model catalog admin", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("upserts manual custom provider models and leaves them untouched by models.dev refresh", async () => {
    const fixture = await setup("org_model_catalog_manual");
    await insertCustomProvider(fixture, "org_model_catalog_manual", "oss-host");

    const upserted = await adminGql(fixture.proxyUrl, fixture.adminHeaders, UPSERT_MODEL, {
      input: {
        provider: "oss-host",
        model: "llama-3.1-8b-instruct",
        displayName: "Llama 3.1 8B Instruct",
        dialects: ["openai-chat"],
        contextWindow: 128000,
        maxOutputTokens: 8192,
        supportsStreaming: true,
        supportsTools: true,
        supportsImages: false,
        supportsReasoning: false,
        pricing: {
          inputCostPerMtok: 0.2,
          outputCostPerMtok: 0.4
        }
      }
    });

    expect(upserted.errors).toBeUndefined();
    expect(upserted.data?.upsertModelCatalogEntry).toEqual(expect.objectContaining({
      provider: "oss-host",
      model: "llama-3.1-8b-instruct",
      displayName: "Llama 3.1 8B Instruct",
      catalogSource: "manual",
      dialects: ["openai-chat"],
      contextWindow: 128000,
      maxOutputTokens: 8192,
      supportsStreaming: true,
      supportsTools: true,
      supportsImages: false,
      supportsReasoning: false,
      pricingKnown: true,
      inputCostPerMtok: 0.2,
      outputCostPerMtok: 0.4
    }));

    const refresh = await fixture.persistence.modelCatalogRefresh.refreshPayload({
      "oss-host": {
        models: {
          "llama-3.1-8b-instruct": {
            id: "llama-3.1-8b-instruct",
            name: "Should Not Overwrite",
            cost: { input: 9, output: 9 }
          }
        }
      }
    });
    const listed = await adminGql(fixture.proxyUrl, fixture.adminHeaders, MODEL_CATALOG);
    const row = listed.data?.modelCatalog.find((entry: any) =>
      entry.provider === "oss-host" && entry.model === "llama-3.1-8b-instruct"
    );

    expect(refresh).toEqual(expect.objectContaining({
      status: "completed",
      inserted: 0,
      updated: 0,
      skippedProviders: ["oss-host"]
    }));
    expect(row).toEqual(expect.objectContaining({
      displayName: "Llama 3.1 8B Instruct",
      catalogSource: "manual",
      inputCostPerMtok: 0.2,
      outputCostPerMtok: 0.4
    }));
  });

  it("exposes unknown manual capability and pricing state", async () => {
    const fixture = await setup("org_model_catalog_unknown");
    await insertCustomProvider(fixture, "org_model_catalog_unknown", "unknown-host");

    const upserted = await adminGql(fixture.proxyUrl, fixture.adminHeaders, UPSERT_MODEL, {
      input: {
        provider: "unknown-host",
        model: "unknown-model"
      }
    });

    expect(upserted.errors).toBeUndefined();
    expect(upserted.data?.upsertModelCatalogEntry).toEqual(expect.objectContaining({
      provider: "unknown-host",
      model: "unknown-model",
      displayName: null,
      dialects: [],
      contextWindow: null,
      maxOutputTokens: null,
      supportsStreaming: null,
      supportsTools: null,
      supportsImages: null,
      supportsReasoning: null,
      pricingKnown: false,
      inputCostPerMtok: null,
      outputCostPerMtok: null
    }));
  });

  it("requires custom route target models to be present in the model catalog", async () => {
    const organizationId = "org_model_catalog_route_validation";
    const fixture = await setup(organizationId);
    const configId = `${organizationId}:routing-config:default`;
    await insertCustomProvider(fixture, organizationId, "catalog-routed");
    const baseConfig = await activeConfig(fixture, configId);

    const missing = await adminGql(fixture.proxyUrl, fixture.adminHeaders, CREATE_VERSION, {
      configId,
      config: routeToCustomModel(baseConfig, "catalog-routed", "missing-model")
    });
    expect(missing.errors?.[0]?.message).toBe("routing_config_target_validation_failed");
    expect(missing.errors?.[0]?.extensions?.issues).toEqual([{
      path: "routes.fast.openai.deployments.0.model",
      message: "Target model must be present in the model catalog before publishing."
    }]);

    const approved = await adminGql(fixture.proxyUrl, fixture.adminHeaders, UPSERT_MODEL, {
      input: {
        provider: "catalog-routed",
        model: "approved-model",
        dialects: ["openai-chat"]
      }
    });
    expect(approved.errors).toBeUndefined();

    const created = await adminGql(fixture.proxyUrl, fixture.adminHeaders, CREATE_VERSION, {
      configId,
      config: routeToCustomModel(baseConfig, "catalog-routed", "approved-model")
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createRoutingConfigVersion.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ active: false })
    ]));
  });

  it("merges Bedrock discovery metadata with org manual overrides deterministically", async () => {
    const organizationId = "org_model_catalog_bedrock_merge";
    const fixture = await setup(organizationId);
    const providerId = "00000000-0000-0000-0000-000000000003";
    const providerAccountId = `${organizationId}:provider:amazon-bedrock`;

    await fixture.db.insert(modelCatalog).values({
      id: "model_bedrock_unknown_discovered",
      organizationId,
      providerId,
      providerAccountId,
      region: "us-east-1",
      model: "vendor.unknown-chat-model-v1:0",
      catalogSource: "bedrock-discovery",
      capabilities: {
        source: "bedrock-discovery",
        dialects: ["bedrock-converse"],
        streaming: true,
        image: false,
        toolCall: false,
        warnings: ["bedrock_capabilities_unknown", "bedrock_pricing_unknown"]
      },
      pricing: {
        source: "bedrock-discovery",
        warnings: ["bedrock_pricing_unknown"]
      }
    });

    const unknownList = await adminGql(fixture.proxyUrl, fixture.adminHeaders, MODEL_CATALOG);
    const unknownRow = unknownList.data?.modelCatalog.find((entry: any) =>
      entry.provider === "amazon-bedrock" && entry.model === "vendor.unknown-chat-model-v1:0"
    );
    expect(unknownRow).toEqual(expect.objectContaining({
      supportsTools: false,
      supportsStreaming: true,
      pricingKnown: false,
      warnings: ["bedrock_capabilities_unknown", "bedrock_pricing_unknown"]
    }));

    await adminGql(fixture.proxyUrl, fixture.adminHeaders, UPSERT_MODEL, {
      input: {
        provider: "amazon-bedrock",
        model: "vendor.unknown-chat-model-v1:0",
        dialects: ["bedrock-converse"],
        contextWindow: 64000,
        maxOutputTokens: 4096,
        supportsStreaming: true,
        supportsTools: true,
        supportsImages: false,
        supportsReasoning: false,
        pricing: {
          inputCostPerMtok: 0.5,
          outputCostPerMtok: 1.5
        }
      }
    });

    const capabilities = await new ModelDiscoveryStore(fixture.db).targetCapabilities({
      organizationId,
      providerId,
      providerAccountId,
      region: "us-east-1",
      model: "vendor.unknown-chat-model-v1:0"
    });
    const overridden = await adminGql(fixture.proxyUrl, fixture.adminHeaders, MODEL_CATALOG);
    const overriddenRow = overridden.data?.modelCatalog.find((entry: any) =>
      entry.provider === "amazon-bedrock" && entry.model === "vendor.unknown-chat-model-v1:0"
    );

    expect(capabilities).toEqual(expect.objectContaining({
      toolCall: true,
      image: false,
      streaming: true,
      contextWindow: 64000
    }));
    expect(overriddenRow).toEqual(expect.objectContaining({
      catalogSource: "manual",
      contextWindow: 64000,
      maxOutputTokens: 4096,
      supportsTools: true,
      pricingKnown: true,
      inputCostPerMtok: 0.5,
      outputCostPerMtok: 1.5,
      warnings: []
    }));
  });

  it("preserves Bedrock catalog rows per provider account and region", async () => {
    const organizationId = "org_model_catalog_bedrock_scopes";
    const fixture = await setup(organizationId);
    const providerId = "00000000-0000-0000-0000-000000000003";
    await fixture.db.insert(providerAccounts).values([
      {
        id: "bedrock_account_east",
        organizationId,
        providerId,
        name: "Bedrock east",
        settings: {
          credentialMode: "aws_default_chain",
          region: "us-east-1"
        }
      },
      {
        id: "bedrock_account_west",
        organizationId,
        providerId,
        name: "Bedrock west",
        settings: {
          credentialMode: "aws_default_chain",
          region: "us-west-2"
        }
      }
    ]);

    await fixture.db.insert(modelCatalog).values([
      {
        id: "model_bedrock_scope_east",
        organizationId,
        providerId,
        providerAccountId: "bedrock_account_east",
        region: "us-east-1",
        model: "vendor.shared-chat-model-v1:0",
        catalogSource: "bedrock-discovery",
        capabilities: {
          source: "bedrock-discovery",
          providerAccountId: "bedrock_account_east",
          region: "us-east-1",
          dialects: ["bedrock-converse"],
          streaming: true
        },
        pricing: { source: "bedrock-discovery" }
      },
      {
        id: "model_bedrock_scope_west",
        organizationId,
        providerId,
        providerAccountId: "bedrock_account_west",
        region: "us-west-2",
        model: "vendor.shared-chat-model-v1:0",
        catalogSource: "bedrock-discovery",
        capabilities: {
          source: "bedrock-discovery",
          providerAccountId: "bedrock_account_west",
          region: "us-west-2",
          dialects: ["bedrock-converse"],
          streaming: true
        },
        pricing: { source: "bedrock-discovery" }
      }
    ]);

    const catalog = await adminGql(fixture.proxyUrl, fixture.adminHeaders, MODEL_CATALOG);
    const scopedRows = catalog.data?.modelCatalog
      .filter((entry: any) =>
        entry.provider === "amazon-bedrock" &&
        entry.model === "vendor.shared-chat-model-v1:0"
      )
      .map((entry: any) => ({
        providerAccountId: entry.providerAccountId,
        region: entry.region
      }))
      .sort((left: any, right: any) => left.providerAccountId.localeCompare(right.providerAccountId));

    expect(scopedRows).toEqual([
      { providerAccountId: "bedrock_account_east", region: "us-east-1" },
      { providerAccountId: "bedrock_account_west", region: "us-west-2" }
    ]);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});

async function insertCustomProvider(fixture: PromptTestFixture, organizationId: string, slug: string) {
  await fixture.db.insert(providers).values({
    id: providerId(slug),
    organizationId,
    slug,
    displayName: slug,
    baseUrl: "https://example.invalid/v1",
    authStyle: "none",
    endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
    defaultHeaders: {},
    forwardHarnessHeaders: false,
    enabled: true
  });
}

async function activeConfig(fixture: PromptTestFixture, configId: string) {
  const detail = await adminGql(fixture.proxyUrl, fixture.adminHeaders, ROUTING_DETAIL, { configId });
  expect(detail.errors).toBeUndefined();
  return detail.data?.routingConfig.versions.find((version: any) => version.active).config;
}

function routeToCustomModel(baseConfig: any, provider: string, model: string) {
  return {
    ...baseConfig,
    routes: {
      ...baseConfig.routes,
      fast: {
        ...baseConfig.routes.fast,
        openai: {
          deployments: [{
            provider,
            model,
            order: 0,
            weight: 1,
            timeoutMs: 60000
          }]
        },
        anthropic: undefined
      }
    }
  };
}

function providerId(slug: string) {
  const suffix = Buffer.from(slug).toString("hex").padEnd(12, "0").slice(0, 12);
  return `00000000-0000-0000-0000-${suffix}`;
}
