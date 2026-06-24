import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { providers, usageLedger } from "@proxy/db";

import { EventService } from "../src/events.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const pricingFields = `{
  model
  provider
  source
  seenInTraffic
  inputCostPerMtok
  outputCostPerMtok
  cacheReadCostPerMtok
  cacheWriteCostPerMtok
  updatedAt
}`;

describe("model pricing admin", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("lists default pricing for shipped models before any traffic", async () => {
    const fixture = await setup("org_pricing_defaults");

    const pricing = await modelPricing(fixture);
    const haiku = pricing.find((entry: any) => entry.model === "claude-haiku-4-5");
    const sonnet = pricing.find((entry: any) => entry.model === "claude-sonnet-4-5");

    expect(haiku).toEqual(expect.objectContaining({
      provider: "anthropic",
      source: "default",
      seenInTraffic: false,
      inputCostPerMtok: 1,
      outputCostPerMtok: 5,
      cacheReadCostPerMtok: 0.1,
      cacheWriteCostPerMtok: 1.25
    }));
    expect(sonnet).toEqual(expect.objectContaining({
      source: "default",
      inputCostPerMtok: 3,
      outputCostPerMtok: 15
    }));
  });

  it("lists the configured classifier model as priced before any traffic", async () => {
    activeFixture = await captureFixture("org_pricing_classifier", "raw_text", false, {
      envOverrides: { CLASSIFIER_MODEL: "gpt-5-nano-2025-08-07" }
    });
    const pricing = await modelPricing(activeFixture);
    // Dated classifier identifier resolves to the priced undated gpt-5-nano.
    const classifier = pricing.find((entry: any) => entry.model === "gpt-5-nano-2025-08-07");

    expect(classifier).toEqual(expect.objectContaining({
      provider: "openai",
      source: "default",
      inputCostPerMtok: 0.05,
      outputCostPerMtok: 0.4
    }));
  });

  it("applies custom pricing to subsequent usage ledger writes and supports revert", async () => {
    const fixture = await setup("org_pricing_override");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_pricing_override");

    const updated = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Set($input: SetModelPricingInput!) { setModelPricing(input: $input) ${pricingFields} }`,
      {
        input: {
          provider: "anthropic",
          model: "claude-custom-test",
          inputCostPerMtok: 2,
          outputCostPerMtok: 4
        }
      }
    ));
    expect(updated.errors).toBeUndefined();
    const customEntry = updated.data?.setModelPricing.find((entry: any) => entry.model === "claude-custom-test");
    expect(customEntry).toEqual(expect.objectContaining({
      source: "custom",
      inputCostPerMtok: 2,
      outputCostPerMtok: 4,
      cacheReadCostPerMtok: 0.2,
      cacheWriteCostPerMtok: 2.5
    }));

    await appendCompletedRequest(events, {
      requestId: "request_pricing_custom",
      model: "claude-custom-test",
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 2000,
        output_tokens: 500
      }
    });

    const [ledgerRow] = await fixture.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.requestId, "request_pricing_custom"));
    expect(ledgerRow).toEqual(expect.objectContaining({
      inputTokens: 13000,
      cachedInputTokens: 10000,
      cacheCreationInputTokens: 2000,
      outputTokens: 500,
      totalTokens: 13500,
      inputCostMicros: 9000,
      outputCostMicros: 2000,
      totalCostMicros: 11000
    }));

    const pricing = await modelPricing(fixture);
    expect(pricing.find((entry: any) => entry.model === "claude-custom-test")).toEqual(
      expect.objectContaining({ source: "custom", seenInTraffic: true })
    );

    const cleared = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Clear($provider: String!, $model: String!) { clearModelPricing(provider: $provider, model: $model) ${pricingFields} }`,
      { provider: "anthropic", model: "claude-custom-test" }
    );
    expect(cleared.errors).toBeUndefined();
    expect(cleared.data?.clearModelPricing.find((entry: any) => entry.model === "claude-custom-test")).toEqual(
      expect.objectContaining({ source: "unpriced", seenInTraffic: true })
    );
  });

  it("applies undated custom overrides to dated model identifiers", async () => {
    const fixture = await setup("org_pricing_dated_override");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_pricing_dated_override");

    const updated = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Set($input: SetModelPricingInput!) { setModelPricing(input: $input) ${pricingFields} }`,
      {
        input: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          inputCostPerMtok: 6,
          outputCostPerMtok: 30
        }
      }
    );
    expect(updated.errors).toBeUndefined();

    await appendCompletedRequest(events, {
      requestId: "request_pricing_dated_override",
      model: "claude-sonnet-4-5-20250929",
      usage: { input_tokens: 100, output_tokens: 20 }
    });

    const [ledgerRow] = await fixture.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.requestId, "request_pricing_dated_override"));
    expect(ledgerRow).toEqual(expect.objectContaining({
      inputCostMicros: 600,
      outputCostMicros: 600,
      totalCostMicros: 1200
    }));

    const pricing = await modelPricing(fixture);
    expect(pricing.find((entry: any) => entry.model === "claude-sonnet-4-5-20250929")).toEqual(
      expect.objectContaining({ source: "custom", seenInTraffic: true, inputCostPerMtok: 6 })
    );
  });

  it("prices dated model identifiers through their undated default entry", async () => {
    const fixture = await setup("org_pricing_dated");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_pricing_dated");

    await appendCompletedRequest(events, {
      requestId: "request_pricing_dated",
      model: "claude-sonnet-4-5-20250929",
      usage: { input_tokens: 100, output_tokens: 20 }
    });

    const [ledgerRow] = await fixture.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.requestId, "request_pricing_dated"));
    expect(ledgerRow).toEqual(expect.objectContaining({
      inputCostMicros: 300,
      outputCostMicros: 300,
      totalCostMicros: 600
    }));

    const overview = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { overview { cost { selected baseline savings } totals { inputTokens cacheCreationInputTokens } } }`
    )).data?.overview;
    expect(overview.cost.selected).toBeCloseTo(0.0006);
    // Baseline replays the same tokens through the default cost baseline
    // model (claude-fable-5 at $10/$50): 100 in + 20 out = $0.002.
    expect(overview.cost.baseline).toBeCloseTo(0.002);
    expect(overview.cost.savings).toBeCloseTo(0.0014);
  });

  it("prices custom provider traffic from provider-specific catalog rows", async () => {
    const fixture = await setup("org_pricing_custom_provider");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_pricing_custom_provider");
    await fixture.db.insert(providers).values({
      id: "00000000-0000-0000-0000-00000000c018",
      organizationId: "org_pricing_custom_provider",
      slug: "oss-host",
      displayName: "OSS Host",
      baseUrl: "https://oss-host.example/v1",
      authStyle: "none",
      endpoints: [{ dialect: "openai-responses", path: "/responses" }],
      defaultHeaders: {},
      forwardHarnessHeaders: false,
      enabled: true
    });

    await appendCompletedRequest(events, {
      requestId: "request_pricing_custom_provider",
      provider: "oss-host",
      surface: "openai-responses",
      model: "shared-model",
      usage: { input_tokens: 100, output_tokens: 10 }
    });
    expect((await ledgerRow(fixture, "request_pricing_custom_provider")).totalCostMicros).toBe(0);

    const updated = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Set($input: SetModelPricingInput!) { setModelPricing(input: $input) ${pricingFields} }`,
      {
        input: {
          provider: "oss-host",
          model: "shared-model",
          inputCostPerMtok: 7,
          outputCostPerMtok: 11
        }
      }
    );
    expect(updated.errors).toBeUndefined();

    expect(await ledgerRow(fixture, "request_pricing_custom_provider")).toEqual(expect.objectContaining({
      inputCostMicros: 700,
      outputCostMicros: 110,
      totalCostMicros: 810
    }));
    expect(updated.data?.setModelPricing.find((entry: any) =>
      entry.provider === "oss-host" && entry.model === "shared-model"
    )).toEqual(expect.objectContaining({
      source: "custom",
      seenInTraffic: true,
      inputCostPerMtok: 7,
      outputCostPerMtok: 11
    }));
  });

  it("rejects clearing pricing that does not exist", async () => {
    const fixture = await setup("org_pricing_missing");

    const cleared = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Clear($provider: String!, $model: String!) { clearModelPricing(provider: $provider, model: $model) { model } }`,
      { provider: "openai", model: "never-priced-model" }
    );

    expect(cleared.errors?.[0]?.message).toBe("model_pricing_not_found");
  });

  async function modelPricing(fixture: PromptTestFixture) {
    const result = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { modelPricing ${pricingFields} }`
    );
    expect(result.errors).toBeUndefined();
    return result.data?.modelPricing ?? [];
  }

  async function ledgerRow(fixture: PromptTestFixture, requestId: string) {
    const [row] = await fixture.db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.requestId, requestId));
    expect(row).toBeDefined();
    return row;
  }

  async function appendCompletedRequest(events: EventService, input: {
    requestId: string;
    provider?: string;
    surface?: "openai-responses" | "anthropic-messages";
    model: string;
    usage: Record<string, number>;
  }) {
    const provider = input.provider ?? "anthropic";
    const surface = input.surface ?? "anthropic-messages";
    await events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: `idem_${input.requestId}`,
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface,
        requestedModel: "claude-router-auto",
        inputHash: `sha256:${input.requestId}`,
        inputChars: 64
      }
    });
    await events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: `idem_${input.requestId}`,
      producer: "test",
      eventType: "provider.request_started",
      payload: {
        surface,
        provider,
        model: input.model,
        providerAttemptId: `attempt_${input.requestId}`
      }
    });
    await events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: `idem_${input.requestId}`,
      producer: "test",
      eventType: "provider.response_completed",
      payload: {
        surface,
        provider,
        selectedModel: input.model,
        providerAttemptId: `attempt_${input.requestId}`,
        upstreamStatus: 200,
        usage: input.usage
      }
    });
  }

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
