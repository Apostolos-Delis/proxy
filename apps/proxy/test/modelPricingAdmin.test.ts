import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { usageLedger } from "@prompt-proxy/db";

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
    // Baseline replays the same tokens through the balanced route model
    // (claude-sonnet-4-5), which is also what this request used.
    expect(overview.cost.baseline).toBeCloseTo(0.0006);
    expect(overview.cost.savings).toBeCloseTo(0);
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

  async function appendCompletedRequest(events: EventService, input: {
    requestId: string;
    model: string;
    usage: Record<string, number>;
  }) {
    await events.append({
      scopeType: "request",
      scopeId: input.requestId,
      correlationId: input.requestId,
      idempotencyKey: `idem_${input.requestId}`,
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "anthropic-messages",
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
        surface: "anthropic-messages",
        provider: "anthropic",
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
        surface: "anthropic-messages",
        provider: "anthropic",
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
