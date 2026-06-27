import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  createTransactionalDatabase,
  encryptSecret,
  events,
  modelCatalog,
  providerAccounts
} from "@proxy/db";

import { BedrockModelDiscoveryJob } from "../src/jobs/bedrockModelDiscovery.js";
import type { BedrockDiscoveryClientFactory } from "../src/providerAdapters/bedrockDiscovery.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const ENCRYPTION_KEY = Buffer.from("bedrock-discovery-test-key-00000").toString("base64");

const REFRESH_BEDROCK = `mutation Refresh($input: RefreshBedrockModelCatalogInput!) {
  refreshBedrockModelCatalog(input: $input) {
    status
    provider
    providerAccountId
    error
    regions
    modelsSeen
    modelsApplied
    inserted
    updated
    skipped
    errors { region error }
  }
}`;

const MODEL_CATALOG = `query ModelCatalog {
  modelCatalog {
    provider
    model
    providerAccountId
    region
    bedrockModelSource
    bedrockInferenceProfileArn
    bedrockInferenceProfileId
    bedrockInferenceProfileSource
    bedrockInferenceProfileGeography
    bedrockBaseModelId
    bedrockFoundationModelId
  }
}`;

describe("Bedrock model discovery", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("imports active foundation models and inference profiles for a provider account region", async () => {
    const fixture = await setup("org_bedrock_discovery_import");
    const accountId = await configureBedrockAccount(fixture, "org_bedrock_discovery_import", ["us-east-1"]);
    const job = discoveryJob(fixture, async (command) => {
      if (commandName(command) === "ListFoundationModelsCommand") {
        return {
          modelSummaries: [
            {
              modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
              modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
              modelName: "Claude 3.5 Sonnet",
              providerName: "Anthropic",
              inputModalities: ["TEXT", "IMAGE"],
              outputModalities: ["TEXT"],
              responseStreamingSupported: true,
              modelLifecycle: { status: "ACTIVE" }
            },
            {
              modelId: "amazon.titan-embed-text-v2:0",
              modelName: "Titan Embeddings",
              inputModalities: ["TEXT"],
              outputModalities: ["EMBEDDING"],
              responseStreamingSupported: false,
              modelLifecycle: { status: "ACTIVE" }
            },
            {
              modelId: "anthropic.claude-old:0",
              modelName: "Claude Old",
              inputModalities: ["TEXT"],
              outputModalities: ["TEXT"],
              responseStreamingSupported: true,
              modelLifecycle: { status: "LEGACY" }
            }
          ]
        };
      }
      if (commandName(command) === "ListInferenceProfilesCommand") {
        return {
          inferenceProfileSummaries: [{
            inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
            inferenceProfileName: "US Claude 3.5 Sonnet",
            inferenceProfileArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
            status: "ACTIVE"
          }, {
            inferenceProfileId: "app-profile",
            inferenceProfileName: "Application profile",
            inferenceProfileArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/app-profile",
            status: "ACTIVE",
            type: "APPLICATION",
            models: [{
              modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0"
            }]
          }]
        };
      }
      if (commandName(command) === "GetInferenceProfileCommand") {
        return {
          inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
          inferenceProfileName: "US Claude 3.5 Sonnet",
          inferenceProfileArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
          status: "ACTIVE",
          type: "SYSTEM_DEFINED",
          models: [{
            modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0"
          }]
        };
      }
      throw new Error(`unexpected_command_${commandName(command)}`);
    });

    const result = await job.refreshProviderAccount({
      organizationId: "org_bedrock_discovery_import",
      providerAccountId: accountId,
      actorUserId: "local-user"
    });
    const rows = await catalogRows(fixture, "org_bedrock_discovery_import", accountId);
    const auditRows = await fixture.db.select().from(events);

    expect(result).toEqual(expect.objectContaining({
      status: "completed",
      provider: "amazon-bedrock",
      providerAccountId: accountId,
      regions: ["us-east-1"],
      modelsSeen: 5,
      modelsApplied: 2,
      inserted: 2,
      updated: 0,
      skipped: 3,
      errors: []
    }));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.model === "anthropic.claude-3-5-sonnet-20241022-v2:0")).toEqual(expect.objectContaining({
      catalogSource: "bedrock-discovery",
      region: "us-east-1",
      capabilities: expect.objectContaining({
        source: "bedrock-discovery",
        displayName: "Claude 3.5 Sonnet",
        region: "us-east-1",
        providerAccountId: accountId,
        dialects: ["bedrock-converse"],
        modalities: ["text", "image"],
        outputModalities: ["text"],
        streaming: true,
        image: true,
        contextWindow: 200000,
        maxOutputTokens: 8192,
        toolCall: true,
        promptCaching: true,
        bedrockMetadataOverlay: "curated",
        bedrockModelSource: "foundation_model"
      }),
      pricing: expect.objectContaining({
        source: "bedrock-curated",
        inputCostPerMtok: 6,
        outputCostPerMtok: 30,
        cacheWriteCostPerMtok: 7.5,
        cacheReadCostPerMtok: 0.6
      })
    }));
    expect(rows.find((row) => row.model === "us.anthropic.claude-3-5-sonnet-20241022-v2:0")?.capabilities).toEqual(expect.objectContaining({
      bedrockModelSource: "inference_profile",
      bedrockFoundationModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      bedrockInferenceProfileSource: "system_cross_region",
      bedrockInferenceProfileGeography: "us",
      bedrockBaseModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      streaming: true,
      toolCall: true,
      contextWindow: 200000
    }));
    const catalog = await adminGql(fixture.proxyUrl, fixture.adminHeaders, MODEL_CATALOG);
    const profileEntry = catalog.data?.modelCatalog.find((entry: any) =>
      entry.provider === "amazon-bedrock" && entry.model === "us.anthropic.claude-3-5-sonnet-20241022-v2:0"
    );
    expect(profileEntry).toEqual(expect.objectContaining({
      providerAccountId: accountId,
      region: "us-east-1",
      bedrockModelSource: "inference_profile",
      bedrockInferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      bedrockInferenceProfileSource: "system_cross_region",
      bedrockInferenceProfileGeography: "us",
      bedrockBaseModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      bedrockFoundationModelId: "anthropic.claude-3-5-sonnet-20241022-v2:0"
    }));
    expect(rows.some((row) => row.model === "app-profile")).toBe(false);
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeType: "provider_account",
        scopeId: accountId,
        eventType: "model_catalog.bedrock_discovery_completed",
        payload: expect.objectContaining({
          inserted: 2,
          providerAccountId: accountId
        })
      })
    ]));
    expect(JSON.stringify(auditRows)).not.toContain("bedrock-test-token");
  });

  it("records discovery failures without erasing prior catalog rows", async () => {
    const fixture = await setup("org_bedrock_discovery_failure");
    const accountId = await configureBedrockAccount(fixture, "org_bedrock_discovery_failure", ["us-east-1"]);
    await fixture.db.insert(modelCatalog).values({
      id: "model_existing_bedrock_discovery",
      organizationId: "org_bedrock_discovery_failure",
      providerId: "00000000-0000-0000-0000-000000000003",
      providerAccountId: accountId,
      region: "us-east-1",
      model: "anthropic.claude-existing:0",
      catalogSource: "bedrock-discovery",
      capabilities: { source: "bedrock-discovery", region: "us-east-1" },
      pricing: { source: "bedrock-discovery" }
    });
    const job = discoveryJob(fixture, async () => {
      throw new Error("bedrock control plane unavailable");
    });

    const result = await job.refreshProviderAccount({
      organizationId: "org_bedrock_discovery_failure",
      providerAccountId: accountId,
      actorUserId: "local-user"
    });
    const rows = await catalogRows(fixture, "org_bedrock_discovery_failure", accountId);
    const auditRows = await fixture.db.select().from(events);

    expect(result).toEqual(expect.objectContaining({
      status: "failed",
      providerAccountId: accountId,
      error: "bedrock control plane unavailable",
      inserted: 0,
      updated: 0,
      modelsApplied: 0,
      errors: [{ region: "us-east-1", error: "bedrock control plane unavailable" }]
    }));
    expect(rows.map((row) => row.model)).toEqual(["anthropic.claude-existing:0"]);
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeId: accountId,
        eventType: "model_catalog.bedrock_discovery_failed"
      })
    ]));
  });

  it("exposes an admin mutation for manual Bedrock discovery refresh", async () => {
    const fixture = await setup("org_bedrock_discovery_graphql");
    const accountId = await configureBedrockAccount(fixture, "org_bedrock_discovery_graphql", ["us-east-1"]);
    const refresh = vi.fn(async () => ({
      status: "completed" as const,
      provider: "amazon-bedrock",
      providerAccountId: accountId,
      regions: ["us-east-1"],
      modelsSeen: 1,
      modelsApplied: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
      errors: []
    }));
    fixture.persistence.bedrockModelDiscovery.refreshProviderAccount = refresh;

    const result = await adminGql(fixture.proxyUrl, fixture.adminHeaders, REFRESH_BEDROCK, {
      input: { providerAccountId: accountId }
    });

    expect(result.errors).toBeUndefined();
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org_bedrock_discovery_graphql",
      actorUserId: "local-user",
      providerAccountId: accountId
    }));
    expect(result.data?.refreshBedrockModelCatalog).toEqual(expect.objectContaining({
      status: "completed",
      provider: "amazon-bedrock",
      providerAccountId: accountId,
      inserted: 1,
      errors: []
    }));
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        PROVIDER_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
      }
    });
    return activeFixture;
  }
});

async function configureBedrockAccount(
  fixture: PromptTestFixture,
  organizationId: string,
  discoveryRegions: string[]
) {
  const accountId = `${organizationId}:provider:amazon-bedrock`;
  await fixture.db
    .update(providerAccounts)
    .set({
      secretCiphertext: encryptSecret("bedrock-test-token", ENCRYPTION_KEY),
      secretHint: "toke",
      settings: {
        credentialMode: "aws_bedrock_bearer_token",
        region: discoveryRegions[0],
        discoveryRegions
      }
    })
    .where(and(
      eq(providerAccounts.organizationId, organizationId),
      eq(providerAccounts.id, accountId)
    ));
  fixture.persistence.providerCredentials.clearCache();
  return accountId;
}

function discoveryJob(
  fixture: PromptTestFixture,
  send: (command: unknown) => Promise<unknown>
) {
  const clientFactory: BedrockDiscoveryClientFactory = () => ({ send });
  return new BedrockModelDiscoveryJob(
    createTransactionalDatabase(fixture.db),
    fixture.persistence.providerCredentials,
    fixture.config,
    { clientFactory }
  );
}

async function catalogRows(
  fixture: PromptTestFixture,
  organizationId: string,
  providerAccountId: string
) {
  return fixture.db
    .select()
    .from(modelCatalog)
    .where(and(
      eq(modelCatalog.organizationId, organizationId),
      eq(modelCatalog.providerAccountId, providerAccountId)
    ));
}

function commandName(command: unknown) {
  return command && typeof command === "object" ? command.constructor.name : "UnknownCommand";
}
