import { and, eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTransactionalDatabase,
  events,
  modelCatalog,
  providers
} from "@proxy/db";

import { ModelCatalogRefreshJob } from "../src/jobs/modelCatalogRefresh.js";
import { catalogPricingForModel } from "../src/persistence/modelPricing.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("models.dev catalog refresh", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("additively refreshes default catalog rows without downgrading capabilities or org overrides", async () => {
    const organizationId = "org_model_catalog_refresh";
    activeFixture = await captureFixture(organizationId);
    const openai = await builtinProvider(activeFixture, "openai");

    await activeFixture.db
      .update(modelCatalog)
      .set({
        capabilities: {
          source: "test",
          modalities: ["text", "image"],
          reasoning: true,
          toolCall: true,
          contextWindow: 400000,
          maxOutputTokens: 128000,
          routes: ["fast"],
          surfaces: ["openai-responses"]
        },
        pricing: {
          source: "test",
          inputCostPerMtok: 9,
          outputCostPerMtok: 18
        }
      })
      .where(and(
        isNull(modelCatalog.organizationId),
        eq(modelCatalog.providerId, openai.id),
        eq(modelCatalog.model, "gpt-5.4-mini")
      ));
    await activeFixture.db.insert(modelCatalog).values({
      id: "model_override_refresh_new",
      organizationId,
      providerId: openai.id,
      model: "gpt-refresh-new",
      capabilities: { source: "org-test" },
      pricing: {
        inputCostPerMtok: 99,
        outputCostPerMtok: 199
      }
    });

    const result = await activeFixture.persistence.modelCatalogRefresh.refreshPayload({
      openai: {
        models: {
          "gpt-5.4-mini": {
            id: "gpt-5.4-mini",
            name: "GPT 5.4 Mini Latest",
            reasoning: false,
            tool_call: false,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 1000, output: 1024 },
            cost: { input: 0.5, output: 1, cache_read: 0.25 }
          },
          "gpt-refresh-new": {
            id: "gpt-refresh-new",
            name: "GPT Refresh New",
            reasoning: true,
            tool_call: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 64000, output: 8192 },
            cost: { input: 2, output: 8, cache_write: 3 }
          }
        }
      },
      "unknown-provider": {
        models: {
          ignored: {
            id: "ignored",
            cost: { input: 1, output: 1 }
          }
        }
      }
    });

    const defaultRows = await activeFixture.db
      .select()
      .from(modelCatalog)
      .where(and(
        isNull(modelCatalog.organizationId),
        eq(modelCatalog.providerId, openai.id)
      ));
    const refreshedMini = defaultRows.find((row) => row.model === "gpt-5.4-mini");
    const insertedDefault = defaultRows.find((row) => row.model === "gpt-refresh-new");
    const effectiveOverride = await catalogPricingForModel(
      activeFixture.db,
      organizationId,
      "openai",
      "gpt-refresh-new"
    );
    const auditRows = await activeFixture.db.select().from(events);

    expect(result).toEqual(expect.objectContaining({
      status: "completed",
      providersSeen: 2,
      providersMatched: 1,
      modelsSeen: 3,
      modelsApplied: 2,
      inserted: 1,
      updated: 1,
      skippedProviders: ["unknown-provider"]
    }));
    expect(refreshedMini?.capabilities).toEqual(expect.objectContaining({
      source: "models.dev-refresh",
      name: "GPT 5.4 Mini Latest",
      modalities: ["text", "image"],
      reasoning: true,
      toolCall: true,
      contextWindow: 400000,
      maxOutputTokens: 128000,
      routes: ["fast"],
      surfaces: ["openai-responses"]
    }));
    expect(refreshedMini?.pricing).toEqual(expect.objectContaining({
      source: "models.dev-refresh",
      inputCostPerMtok: 0.5,
      outputCostPerMtok: 1,
      cacheReadCostPerMtok: 0.25
    }));
    expect(insertedDefault?.pricing).toEqual(expect.objectContaining({
      inputCostPerMtok: 2,
      outputCostPerMtok: 8,
      cacheWriteCostPerMtok: 3
    }));
    expect(effectiveOverride).toEqual(expect.objectContaining({
      inputCostPerMtok: 99,
      outputCostPerMtok: 199
    }));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeType: "model_catalog_refresh",
        scopeId: "models.dev",
        actorType: "system",
        eventType: "model_catalog.refresh_completed"
      })
    ]));
  });

  it("records a failed refresh without throwing", async () => {
    const organizationId = "org_model_catalog_refresh_failure";
    activeFixture = await captureFixture(organizationId);
    const job = new ModelCatalogRefreshJob(createTransactionalDatabase(activeFixture.db), {
      auditOrganizationId: organizationId,
      fetcher: async () => {
        throw new Error("network down");
      }
    });

    const result = await job.refresh();
    const auditRows = await activeFixture.db.select().from(events);

    expect(result).toEqual({
      status: "failed",
      error: "network down"
    });
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeType: "model_catalog_refresh",
        scopeId: "models.dev",
        actorType: "system",
        eventType: "model_catalog.refresh_failed",
        payload: expect.objectContaining({
          status: "failed",
          error: "network down"
        })
      })
    ]));
  });
});

async function builtinProvider(fixture: PromptTestFixture, slug: string) {
  const [provider] = await fixture.db
    .select()
    .from(providers)
    .where(and(
      isNull(providers.organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  expect(provider).toBeTruthy();
  return provider!;
}
