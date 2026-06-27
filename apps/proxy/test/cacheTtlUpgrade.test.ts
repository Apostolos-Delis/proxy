import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  defaultWorkspaceId,
  organizationSettings,
  requests,
  users
} from "@proxy/db";
import { ANTHROPIC_PROVIDER_CACHING_CAPABILITIES } from "@proxy/schema";

import {
  rewriteSurfaceRequestWithPromptCachePlan,
  rewriteTokenCountRequestWithPromptCachePlan
} from "../src/adapters.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { captureFixture, usageRequest, type PromptTestFixture } from "./promptTestFixture.js";
import { listen, startAnthropicMock, startOpenAIMock, type MockServer } from "./helpers.js";

// A minimal RouteDecision shape that satisfies rewriteSurfaceRequest
function anthropicDecision(model = "claude-opus-4-8") {
  return {
    outcome: "forward" as const,
    finalRoute: "hard" as const,
    selectedModel: model,
    surface: "anthropic-messages" as const,
    provider: "anthropic" as const,
    deployment: {
      key: "test-anthropic",
      provider: "anthropic" as const,
      model,
      order: 0,
      weight: 1,
      timeoutMs: 60000
    },
    providerSettings: {
      provider: "anthropic" as const,
      model,
      dialect: "anthropic-messages" as const,
      deployment: {
        key: "test-anthropic",
        provider: "anthropic" as const,
        model,
        order: 0,
        weight: 1,
        timeoutMs: 60000
      },
      anthropic: {
        provider: "anthropic" as const,
        model,
        order: 0,
        weight: 1,
        timeoutMs: 60000
      }
    }
  };
}

function rewriteAnthropicWithPlan(body: unknown, settings: { automaticCaching?: boolean; cacheTtlUpgrade?: boolean }) {
  return rewriteSurfaceRequestWithPromptCachePlan(body, anthropicDecision(), undefined, {
    context: { surface: "anthropic-messages" },
    capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
    settings
  }).body as any;
}

function rewriteAnthropicTokenCountWithPlan(body: unknown, settings: { automaticCaching?: boolean; cacheTtlUpgrade?: boolean }) {
  return rewriteTokenCountRequestWithPromptCachePlan(body, anthropicDecision(), undefined, {
    context: { surface: "anthropic-messages" },
    capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
    settings
  }).body as any;
}

describe("upgradeCacheControlTtl transform", () => {
  const largeText = "x".repeat(8192);
  const largeMultiTurnMessages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: largeText },
    { role: "user", content: "follow-up" }
  ];

  it("upgrades ephemeral breakpoints in system array to 1h TTL", () => {
    const body = {
      model: "claude-router-hard",
      system: [
        { type: "text", text: largeText, cache_control: { type: "ephemeral" } },
        { type: "text", text: "More instructions." }
      ],
      messages: largeMultiTurnMessages
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });

    expect(result.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(result.system[1].cache_control).toBeUndefined();
  });

  it("upgrades breakpoints in every message's content (byte-stable across turns)", () => {
    const body = {
      model: "claude-router-hard",
      messages: [
        { role: "user", content: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: largeText },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "output", cache_control: { type: "ephemeral" } }
          ]
        }
      ]
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });

    // Every breakpoint upgraded — a block keeps ttl:1h once it becomes history,
    // so the cached prefix bytes do not shift turn over turn.
    expect(result.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(result.messages[2].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("upgrades breakpoints nested inside tool_result content", () => {
    const body = {
      model: "claude-router-hard",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: largeText },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "output", cache_control: { type: "ephemeral" } }]
            }
          ]
        }
      ]
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.messages[2].content[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("does not touch blocks that already have a TTL", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("is a no-op when upgradeCacheTtl is false", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: false });
    expect(result.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("also applies to rewriteTokenCountRequest", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral" } }],
      messages: largeMultiTurnMessages
    };

    const result = rewriteAnthropicTokenCountWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("upgrades a client-sent top-level cache_control (automatic caching field)", () => {
    const body = {
      model: "claude-router-hard",
      cache_control: { type: "ephemeral" },
      messages: largeMultiTurnMessages
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("leaves an explicit top-level TTL untouched", () => {
    const body = {
      model: "claude-router-hard",
      cache_control: { type: "ephemeral", ttl: "5m" },
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  it("upgrades breakpoints on tool definitions", () => {
    // Tools sit first in the cached prefix, so leaving them at 5m while later
    // breakpoints read 1h would violate the longer-TTL-first ordering rule.
    const body = {
      model: "claude-router-hard",
      tools: [
        { name: "get_weather", input_schema: { type: "object" } },
        { name: "get_time", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }
      ],
      system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral" } }],
      messages: largeMultiTurnMessages
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.tools[0].cache_control).toBeUndefined();
    expect(result.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(result.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("upgrades a top-level cache_control in rewriteTokenCountRequest", () => {
    const body = {
      model: "claude-router-hard",
      cache_control: { type: "ephemeral" },
      messages: largeMultiTurnMessages
    };

    const result = rewriteAnthropicTokenCountWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("skips one-shot requests so true one-offs do not pay the 1h write premium", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips small multi-turn requests below the cacheable-prefix threshold", () => {
    const body = {
      model: "claude-router-hard",
      cache_control: { type: "ephemeral" },
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "follow-up" }
      ]
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips large requests when the marked cache prefix is small", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: "short stable prefix", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: largeText },
        { role: "user", content: "follow-up" }
      ]
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not count unmarked later tools toward an earlier tool breakpoint", () => {
    const body = {
      model: "claude-router-hard",
      tools: [
        { name: "small_marked_tool", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        {
          name: "large_unmarked_tool",
          description: largeText,
          input_schema: { type: "object", properties: { value: { type: "string", description: largeText } } }
        }
      ],
      messages: largeMultiTurnMessages
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.tools[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not count unmarked later nested content toward an earlier nested breakpoint", () => {
    const body = {
      model: "claude-router-hard",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "short output", cache_control: { type: "ephemeral" } },
                { type: "text", text: largeText }
              ]
            }
          ]
        }
      ]
    };

    const result = rewriteAnthropicWithPlan(body, { cacheTtlUpgrade: true });
    expect(result.messages[2].content[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("cacheTtlUpgrade in proxy request flow (no-persistence path)", () => {
  let openai: MockServer;
  let anthropic: MockServer;

  beforeEach(async () => {
    openai = await startOpenAIMock();
    anthropic = await startAnthropicMock();
  });

  afterEach(async () => {
    await openai.close();
    await anthropic.close();
  });

  it("does not mutate cache_control when cacheTtlUpgrade is not set (default off)", async () => {
    const app = buildServer(
      loadConfig({
        ...process.env,
        DATABASE_URL: "",
        EVENT_STORE_PATH: "",
        PROXY_TOKEN: "proxy-token",
        ANTHROPIC_API_KEY: "anthropic-upstream-key",
        ANTHROPIC_BASE_URL: anthropic.url,
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: openai.url,
        LOG_LEVEL: "fatal"
      })
    );
    const proxyUrl = await listen(app);

    await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "hi" }]
      })
    });
    await app.close();

    const providerCall = anthropic.records.find((rec) => rec.path === "/messages");
    expect(providerCall?.body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("cacheTtlUpgrade end to end (DB-backed)", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("keeps large multi-turn Anthropic bodies on the default TTL until org reuse data supports 1h", async () => {
    fixture = await captureFixture("org_cache_ttl_no_reuse");
    await fixture.persistence.organizationSettings.setCacheTtlUpgrade("org_cache_ttl_no_reuse", true);

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        system: [{ type: "text", text: "x".repeat(8192), cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "x".repeat(8192) },
          { role: "user", content: "follow-up" }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    expect(providerCall?.body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("rewrites large multi-turn outbound Anthropic bodies to ttl:1h when observed org reuse supports it", async () => {
    fixture = await captureFixture("org_cache_ttl");
    await fixture.persistence.organizationSettings.setCacheTtlUpgrade("org_cache_ttl", true);
    const firstGap = new Date(Date.now() - 40 * 60 * 1000);
    const secondGap = new Date(Date.now() - 10 * 60 * 1000);
    await fixture.db.insert(users).values([{ id: "user_cache_ttl", email: "ttl@example.com", name: "TTL" }]);
    await fixture.db.insert(agentSessions).values([{
      id: "session_cache_ttl_gap",
      organizationId: "org_cache_ttl",
      workspaceId: defaultWorkspaceId("org_cache_ttl"),
      userId: "user_cache_ttl",
      surface: "anthropic-messages",
      externalSessionId: "ttl-gap",
      startedAt: firstGap,
      updatedAt: secondGap
    }]);
    await fixture.db.insert(requests).values([
      usageRequest("cache_ttl_gap_1", "org_cache_ttl", "user_cache_ttl", "session_cache_ttl_gap", "anthropic-messages", firstGap),
      usageRequest("cache_ttl_gap_2", "org_cache_ttl", "user_cache_ttl", "session_cache_ttl_gap", "anthropic-messages", secondGap)
    ]);

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        system: [{ type: "text", text: "x".repeat(8192), cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "x".repeat(8192) },
          { role: "user", content: "follow-up" }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    expect(providerCall?.body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps one-shot Anthropic bodies on the default TTL when the org flag is on", async () => {
    fixture = await captureFixture("org_cache_ttl_one_shot");
    await fixture.persistence.organizationSettings.setCacheTtlUpgrade("org_cache_ttl_one_shot", true);

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        system: [{ type: "text", text: "x".repeat(8192), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "hello" }]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    expect(providerCall?.body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("setCacheTtlUpgrade merges into settings without clobbering other keys", async () => {
    fixture = await captureFixture("org_cache_merge");
    await fixture.db
      .update(organizationSettings)
      .set({ settings: { existingKey: "keep-me" } })
      .where(eq(organizationSettings.organizationId, "org_cache_merge"));

    await fixture.persistence.organizationSettings.setCacheTtlUpgrade("org_cache_merge", true);

    const [row] = await fixture.db
      .select({ settings: organizationSettings.settings })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, "org_cache_merge"))
      .limit(1);
    expect(row?.settings).toEqual({ existingKey: "keep-me", cacheTtlUpgrade: true });
    expect(await fixture.persistence.organizationSettings.cacheTtlUpgrade("org_cache_merge")).toBe(true);
  });
});
