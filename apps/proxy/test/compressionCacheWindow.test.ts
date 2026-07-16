import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  defaultWorkspaceId,
  events as eventTable,
  requests,
  usageLedger
} from "@proxy/db";

import {
  CompressionCacheWindowResolver,
  compressionCacheWindowEventPayload,
  noCompressionCacheWindow
} from "../src/compressionCacheWindow.js";
import { CACHE_TTL_DEFAULT_MS } from "../src/cacheWindows.js";
import { sessionRowId } from "../src/persistence/identity.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("CompressionCacheWindowResolver", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("resolves no frozen prefix when there is no cache evidence", async () => {
    fixture = await captureFixture("org_compression_cache_none");
    const resolver = new CompressionCacheWindowResolver(fixture.db);

    await expect(resolver.resolve({
      organizationId: "org_compression_cache_none",
      workspaceId: defaultWorkspaceId("org_compression_cache_none"),
      sessionId: "session_empty",
      surface: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      now: new Date("2026-06-23T13:00:00.000Z")
    })).resolves.toEqual(noCompressionCacheWindow());
  });

  it("resolves a conservative whole-item prefix from recent provider cache evidence", async () => {
    fixture = await captureFixture("org_compression_cache_hit");
    const organizationId = "org_compression_cache_hit";
    const workspaceId = defaultWorkspaceId(organizationId);
    const now = new Date("2026-06-23T13:00:00.000Z");
    await seedCacheEvidence(fixture, {
      organizationId,
      workspaceId,
      externalSessionId: "session_cache_hit",
      requestId: "request_cache_hit",
      surface: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 6000,
      cachedInputTokens: 4096,
      cacheCreationInputTokens: 256,
      createdAt: new Date(now.getTime() - 30_000)
    });
    const resolver = new CompressionCacheWindowResolver(fixture.db);

    await expect(resolver.resolve({
      organizationId,
      workspaceId,
      sessionId: "session_cache_hit",
      surface: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      body: {
        messages: [
          { role: "user", content: "cached question" },
          { role: "assistant", content: "cached answer" },
          { role: "user", content: "live follow up" }
        ]
      },
      now
    })).resolves.toMatchObject({
      source: "provider_usage",
      frozenPrefixItems: 2,
      cachedInputTokens: 4096,
      cacheCreationInputTokens: 256,
      inputTokens: 6000,
      evidenceRequestId: "request_cache_hit",
      evidenceCreatedAt: "2026-06-23T12:59:30.000Z"
    });
  });

  it("treats stale or mismatched evidence as insufficient", async () => {
    fixture = await captureFixture("org_compression_cache_stale");
    const organizationId = "org_compression_cache_stale";
    const workspaceId = defaultWorkspaceId(organizationId);
    const now = new Date("2026-06-23T13:00:00.000Z");
    await seedCacheEvidence(fixture, {
      organizationId,
      workspaceId,
      externalSessionId: "session_stale",
      requestId: "request_cache_stale",
      surface: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 6000,
      cachedInputTokens: 4096,
      cacheCreationInputTokens: 0,
      createdAt: new Date(now.getTime() - CACHE_TTL_DEFAULT_MS - 1)
    });
    const resolver = new CompressionCacheWindowResolver(fixture.db);

    await expect(resolver.resolve({
      organizationId,
      workspaceId,
      sessionId: "session_stale",
      surface: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      body: { messages: [{ role: "user", content: "old" }, { role: "user", content: "live" }] },
      now
    })).resolves.toEqual(noCompressionCacheWindow());

    await expect(resolver.resolve({
      organizationId,
      workspaceId,
      sessionId: "session_stale",
      surface: "anthropic-messages",
      provider: "openai",
      model: "claude-sonnet-4-5",
      body: { messages: [{ role: "user", content: "old" }, { role: "user", content: "live" }] },
      now: new Date("2026-06-23T12:59:59.999Z")
    })).resolves.toEqual(noCompressionCacheWindow());
  });

  it("emits sanitized cache-window evidence before compression", async () => {
    fixture = await captureFixture("org_compression_cache_event");
    const organizationId = "org_compression_cache_event";
    const workspaceId = defaultWorkspaceId(organizationId);
    await seedCacheEvidence(fixture, {
      organizationId,
      workspaceId,
      externalSessionId: "session_cache_event",
      requestId: "request_cache_event_prior",
      surface: "anthropic-messages",
      provider: "anthropic",
      model: "claude-fable-5",
      inputTokens: 5000,
      cachedInputTokens: 3072,
      cacheCreationInputTokens: 128,
      createdAt: new Date()
    });

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-claude-code-session-id": "session_cache_event"
      },
      body: JSON.stringify({
        model: "fable",
        max_tokens: 128,
        messages: [
          { role: "user", content: "cached secret prompt" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"items\":[1,2,3]}" }] }
        ]
      })
    });

    expect(response.status).toBe(200);
    const rows = await fixture.db.select().from(eventTable);
    const event = rows.find((row) => row.eventType === "compression.cache_window_resolved");
    expect(event?.payload).toMatchObject({
      surface: "anthropic-messages",
      provider: "anthropic",
      model: "claude-fable-5",
      source: "provider_usage",
      frozenPrefixItems: 2,
      cachedInputTokens: 3072,
      cacheCreationInputTokens: 128,
      inputTokens: 5000,
      evidenceRequestId: "request_cache_event_prior"
    });
    expect(JSON.stringify(event?.payload)).not.toContain("cached secret prompt");
    expect(compressionCacheWindowEventPayload(noCompressionCacheWindow())).toEqual({
      source: "none",
      frozenPrefixItems: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      inputTokens: 0,
      evidenceRequestId: null,
      evidenceCreatedAt: null
    });
  });
});

async function seedCacheEvidence(fixture: PromptTestFixture, input: {
  organizationId: string;
  workspaceId: string;
  externalSessionId: string;
  requestId: string;
  surface: "anthropic-messages" | "openai-responses" | "openai-chat";
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  createdAt: Date;
}) {
  const sessionId = sessionRowId(input.workspaceId, input.surface, input.externalSessionId);
  await fixture.db.insert(agentSessions).values({
    id: sessionId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    surface: input.surface,
    externalSessionId: input.externalSessionId,
    startedAt: input.createdAt,
    updatedAt: input.createdAt
  }).onConflictDoNothing();
  await fixture.db.insert(requests).values({
    id: input.requestId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    sessionId,
    surface: input.surface,
    idempotencyKey: `${input.requestId}:idem`,
    requestedModel: input.model,
    inputHash: `${input.requestId}:hash`,
    inputChars: input.inputTokens * 4,
    status: "completed",
    createdAt: input.createdAt,
    completedAt: input.createdAt
  });
  await fixture.db.insert(usageLedger).values({
    id: `${input.requestId}:usage`,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    sessionId,
    requestId: input.requestId,
    kind: "provider",
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    cachedInputTokens: input.cachedInputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    totalTokens: input.inputTokens,
    usage: {
      inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens
    },
    createdAt: input.createdAt
  });
}
