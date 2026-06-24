import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { usageLedger } from "@proxy/db";

import { EventService } from "../src/events.js";
import { normalizeLegacyCachedUsage } from "../src/persistence/usageNormalization.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("legacy cached-usage normalization", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("folds exclusive-shape cache counts into input and total, keeping cost snapshots", async () => {
    const fixture = await setup("org_normalize_fold");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_normalize_fold");

    await appendCompletedRequest(events, {
      requestId: "request_normalize_fold",
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 44, output_tokens: 10 }
    });
    const ingested = await ledgerRow(fixture, "request_normalize_fold");
    // Rewind the row to the pre-normalizeUsage wire shape: input excludes cache counts.
    await fixture.db
      .update(usageLedger)
      .set({ cachedInputTokens: 321060, cacheCreationInputTokens: 5000 })
      .where(eq(usageLedger.id, ingested.id));

    expect(await normalizeLegacyCachedUsage(fixture.db)).toBe(1);

    const healed = await ledgerRow(fixture, "request_normalize_fold");
    expect(healed).toEqual(expect.objectContaining({
      inputTokens: 44 + 321060 + 5000,
      cachedInputTokens: 321060,
      cacheCreationInputTokens: 5000,
      totalTokens: 54 + 321060 + 5000,
      inputCostMicros: ingested.inputCostMicros,
      totalCostMicros: ingested.totalCostMicros
    }));
  });

  it("is a no-op on healed and on already-normalized rows", async () => {
    const fixture = await setup("org_normalize_noop");
    const events = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_normalize_noop");

    await appendCompletedRequest(events, {
      requestId: "request_normalize_noop",
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 600 }
    });
    // Ingest already folds the anthropic wire shape: 1000 + 600 reads.
    const ingested = await ledgerRow(fixture, "request_normalize_noop");
    expect(ingested.inputTokens).toBe(1600);

    expect(await normalizeLegacyCachedUsage(fixture.db)).toBe(0);
    expect(await ledgerRow(fixture, "request_normalize_noop")).toEqual(ingested);
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
