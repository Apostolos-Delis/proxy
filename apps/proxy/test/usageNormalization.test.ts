import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { usageLedger } from "@proxy/db";

import { EventService } from "../src/events.js";
import { normalizeLegacyCachedUsage } from "../src/persistence/usageNormalization.js";
import { normalizeUsage, type NormalizedUsage } from "../src/persistence/values.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("provider usage normalization fixtures", () => {
  it.each([
    {
      name: "openai responses cached read",
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 400 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 10 },
        total_tokens: 1050
      },
      expected: {
        inputTokens: 1000,
        cachedInputTokens: 400,
        cacheCreationInputTokens: 0,
        outputTokens: 50,
        reasoningTokens: 10,
        totalTokens: 1050
      }
    },
    {
      name: "openai chat cached read",
      usage: {
        prompt_tokens: 900,
        prompt_tokens_details: { cached_tokens: 300 },
        completion_tokens: 70,
        completion_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 970
      },
      expected: {
        inputTokens: 900,
        cachedInputTokens: 300,
        cacheCreationInputTokens: 0,
        outputTokens: 70,
        reasoningTokens: 20,
        totalTokens: 970
      }
    },
    {
      name: "anthropic cached read and write",
      usage: {
        input_tokens: 250,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 100,
        output_tokens: 80
      },
      expected: {
        inputTokens: 1050,
        cachedInputTokens: 700,
        cacheCreationInputTokens: 100,
        outputTokens: 80,
        reasoningTokens: 0,
        totalTokens: 1130
      }
    },
    {
      name: "partial openai usage",
      usage: {
        input_tokens: 125,
        output_tokens: 25
      },
      expected: {
        inputTokens: 125,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 25,
        reasoningTokens: 0,
        totalTokens: 150
      }
    },
    {
      name: "provider adapter normalized output",
      usage: {
        inputTokens: 1200,
        cachedInputTokens: 450,
        cacheCreationInputTokens: 150,
        outputTokens: 90,
        reasoningTokens: 30,
        totalTokens: 1290
      },
      expected: {
        inputTokens: 1200,
        cachedInputTokens: 450,
        cacheCreationInputTokens: 150,
        outputTokens: 90,
        reasoningTokens: 30,
        totalTokens: 1290
      }
    },
    {
      name: "gemini interactions usage",
      usage: {
        total_input_tokens: 1600,
        total_cached_tokens: 600,
        total_output_tokens: 75,
        total_thought_tokens: 25,
        total_tokens: 1700
      },
      expected: {
        inputTokens: 1600,
        cachedInputTokens: 600,
        cacheCreationInputTokens: 0,
        outputTokens: 75,
        reasoningTokens: 25,
        totalTokens: 1700
      }
    },
    {
      name: "gemini generateContent usage metadata",
      usage: {
        promptTokenCount: 1600,
        cachedContentTokenCount: 600,
        candidatesTokenCount: 75,
        thoughtsTokenCount: 25,
        totalTokenCount: 1700
      },
      expected: {
        inputTokens: 1600,
        cachedInputTokens: 600,
        cacheCreationInputTokens: 0,
        outputTokens: 75,
        reasoningTokens: 25,
        totalTokens: 1700
      }
    },
    {
      name: "missing usage",
      usage: {},
      expected: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
      }
    },
    {
      name: "unknown provider shape",
      usage: {
        prompt_cache_read_tokens: 999,
        prompt_cache_write_tokens: 111,
        billed_total: 1234
      },
      expected: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0
      }
    }
  ] satisfies Array<{ name: string; usage: Record<string, unknown>; expected: NormalizedUsage }>)(
    "normalizes $name",
    ({ usage, expected }) => {
      expect(normalizeUsage(usage)).toEqual(expected);
    }
  );

  it("keeps cached reads and writes as subsets of total input", () => {
    const normalized = normalizeUsage({
      input_tokens: 250,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 100,
      output_tokens: 80
    });

    expect(normalized.inputTokens - normalized.cachedInputTokens - normalized.cacheCreationInputTokens).toBe(250);
    expect(normalized.inputTokens).toBe(1050);
    expect(normalized.totalTokens).toBe(1130);
  });
});

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
