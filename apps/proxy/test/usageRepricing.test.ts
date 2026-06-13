import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { modelCatalog, usageLedger } from "@prompt-proxy/db";

import { EventService } from "../src/events.js";
import { repriceZeroCostUsage } from "../src/persistence/usageRepricing.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("zero-cost usage repricing", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("reprices traffic that booked $0 once the missing rate is set", async () => {
    const fixture = await setup("org_reprice_set");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_reprice_set");

    await appendCompletedRequest(events, {
      requestId: "request_reprice_set",
      model: "claude-unpriced-test",
      usage: { input_tokens: 1000, output_tokens: 500 }
    });
    const before = await ledgerRow(fixture, "request_reprice_set");
    expect(before.totalCostMicros).toBe(0);

    const updated = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Set($input: SetModelPricingInput!) { setModelPricing(input: $input) { model } }`,
      {
        input: {
          provider: "anthropic",
          model: "claude-unpriced-test",
          inputCostPerMtok: 2,
          outputCostPerMtok: 4
        }
      }
    );
    expect(updated.errors).toBeUndefined();

    const after = await ledgerRow(fixture, "request_reprice_set");
    expect(after).toEqual(expect.objectContaining({
      inputCostMicros: 2000,
      outputCostMicros: 2000,
      totalCostMicros: 4000
    }));
  });

  it("reprices dated identifiers when their undated rate is set", async () => {
    const fixture = await setup("org_reprice_dated");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_reprice_dated");

    await appendCompletedRequest(events, {
      requestId: "request_reprice_dated",
      model: "claude-unpriced-test-20260601",
      usage: { input_tokens: 100, output_tokens: 20 }
    });
    expect((await ledgerRow(fixture, "request_reprice_dated")).totalCostMicros).toBe(0);

    const updated = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Set($input: SetModelPricingInput!) { setModelPricing(input: $input) { model } }`,
      {
        input: {
          provider: "anthropic",
          model: "claude-unpriced-test",
          inputCostPerMtok: 6,
          outputCostPerMtok: 30
        }
      }
    );
    expect(updated.errors).toBeUndefined();

    expect(await ledgerRow(fixture, "request_reprice_dated")).toEqual(expect.objectContaining({
      inputCostMicros: 600,
      outputCostMicros: 600,
      totalCostMicros: 1200
    }));
  });

  it("keeps ingest-time snapshots when a rate changes", async () => {
    const fixture = await setup("org_reprice_snapshot");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_reprice_snapshot");

    await appendCompletedRequest(events, {
      requestId: "request_reprice_snapshot",
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 100, output_tokens: 20 }
    });
    const before = await ledgerRow(fixture, "request_reprice_snapshot");
    expect(before.totalCostMicros).toBe(600);

    const updated = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation Set($input: SetModelPricingInput!) { setModelPricing(input: $input) { model } }`,
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

    expect((await ledgerRow(fixture, "request_reprice_snapshot")).totalCostMicros).toBe(600);
  });

  it("boot repricing heals rows whose model gained a catalog rate", async () => {
    const fixture = await setup("org_reprice_boot");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_reprice_boot");

    await appendCompletedRequest(events, {
      requestId: "request_reprice_boot",
      model: "claude-boot-test",
      usage: { input_tokens: 1000, output_tokens: 100 }
    });
    expect((await ledgerRow(fixture, "request_reprice_boot")).totalCostMicros).toBe(0);

    await fixture.db.insert(modelCatalog).values({
      id: "model:anthropic:claude-boot-test",
      organizationId: null,
      providerId: "00000000-0000-0000-0000-000000000002",
      model: "claude-boot-test",
      capabilities: {},
      pricing: { inputCostPerMtok: 5, outputCostPerMtok: 25 }
    });
    const repriced = await repriceZeroCostUsage(fixture.db);
    expect(repriced).toBe(1);

    expect(await ledgerRow(fixture, "request_reprice_boot")).toEqual(expect.objectContaining({
      inputCostMicros: 5000,
      outputCostMicros: 2500,
      totalCostMicros: 7500
    }));
  });

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
