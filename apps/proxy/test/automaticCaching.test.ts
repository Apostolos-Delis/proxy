import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { organizationSettings } from "@proxy/db";

import { rewriteSurfaceRequest } from "../src/adapters.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

// A minimal RouteDecision shape that satisfies rewriteSurfaceRequest
function anthropicDecision(model = "claude-opus-4-8") {
  return {
    outcome: "forward" as const,
    finalRoute: "hard" as const,
    selectedModel: model,
    surface: "anthropic-messages" as const,
    provider: "anthropic" as const,
    providerSettings: {
      providerId: "anthropic" as const,
      model,
      dialect: "anthropic-messages" as const
    }
  };
}

function openaiDecision(model = "gpt-5.5") {
  return {
    outcome: "forward" as const,
    finalRoute: "hard" as const,
    selectedModel: model,
    surface: "openai-responses" as const,
    provider: "openai" as const,
    providerSettings: {
      providerId: "openai" as const,
      model,
      dialect: "openai-responses" as const
    }
  };
}

describe("injectAutomaticCacheControl transform", () => {
  const largeText = "x".repeat(8192);
  const multiTurnMessages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow-up" }
  ];
  const largeMultiTurnMessages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: largeText },
    { role: "user", content: "follow-up" }
  ];

  it("injects the top-level field on multi-turn requests with no breakpoints", () => {
    const body = { model: "claude-router-hard", messages: multiTurnMessages };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { automaticCaching: true }) as any;
    expect(result.cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips single-turn requests so one-shot prompts never pay the write surcharge", () => {
    const body = { model: "claude-router-hard", messages: [{ role: "user", content: "hi" }] };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { automaticCaching: true }) as any;
    expect(result.cache_control).toBeUndefined();
  });

  it("skips requests that already carry a system breakpoint", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
      messages: multiTurnMessages
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { automaticCaching: true }) as any;
    expect(result.cache_control).toBeUndefined();
  });

  it("skips requests that already carry a tool-definition breakpoint", () => {
    const body = {
      model: "claude-router-hard",
      tools: [{ name: "get_weather", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
      messages: multiTurnMessages
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { automaticCaching: true }) as any;
    expect(result.cache_control).toBeUndefined();
  });

  it("skips requests that already carry a message-content breakpoint", () => {
    const body = {
      model: "claude-router-hard",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: [{ type: "text", text: "follow-up", cache_control: { type: "ephemeral" } }] }
      ]
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { automaticCaching: true }) as any;
    expect(result.cache_control).toBeUndefined();
  });

  it("skips requests with a breakpoint nested inside tool_result content", () => {
    const body = {
      model: "claude-router-hard",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: {} }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "result", cache_control: { type: "ephemeral" } }]
            }
          ]
        }
      ]
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { automaticCaching: true }) as any;
    expect(result.cache_control).toBeUndefined();
  });

  it("leaves a client-sent top-level field as-is", () => {
    const body = {
      model: "claude-router-hard",
      cache_control: { type: "ephemeral", ttl: "1h" },
      messages: multiTurnMessages
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, { automaticCaching: true }) as any;
    expect(result.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("gives an injected breakpoint the 1h TTL when both settings are on", () => {
    const body = { model: "claude-router-hard", messages: largeMultiTurnMessages };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, {
      automaticCaching: true,
      upgradeCacheTtl: true
    }) as any;
    expect(result.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps an injected breakpoint at the default TTL for small multi-turn requests", () => {
    const body = { model: "claude-router-hard", messages: multiTurnMessages };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, {
      automaticCaching: true,
      upgradeCacheTtl: true
    }) as any;
    expect(result.cache_control).toEqual({ type: "ephemeral" });
  });

  it("is a no-op when automaticCaching is not set", () => {
    const body = { model: "claude-router-hard", messages: multiTurnMessages };

    const result = rewriteSurfaceRequest(body, anthropicDecision(), undefined, {}) as any;
    expect(result.cache_control).toBeUndefined();
  });
});

describe("prompt_cache_retention on OpenAI rewrites", () => {
  it("does not add prompt_cache_retention", () => {
    const body = { model: "router-hard", input: "hi" };

    const result = rewriteSurfaceRequest(body, openaiDecision(), undefined, {}) as any;
    expect(result.prompt_cache_retention).toBeUndefined();
  });

  it("drops a client-set prompt_cache_retention", () => {
    const body = { model: "router-hard", input: "hi", prompt_cache_retention: "in_memory" };

    const result = rewriteSurfaceRequest(body, openaiDecision(), undefined, {}) as any;
    expect(result.prompt_cache_retention).toBeUndefined();
  });
});

describe("automatic caching end to end (DB-backed)", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("injects the top-level automatic-caching field when the org flag is on", async () => {
    fixture = await captureFixture("org_auto_cache");
    await fixture.persistence.organizationSettings.setAutomaticCaching("org_auto_cache", true);

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        messages: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "follow-up" }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    expect(providerCall?.body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("forwards OpenAI requests without prompt_cache_retention", async () => {
    fixture = await captureFixture("org_pcr");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "router-hard", input: "hello", stream: true, prompt_cache_retention: "24h" })
    });
    await response.text();

    const providerCall = fixture.openai.records.find((rec) => rec.path === "/responses");
    expect(providerCall?.body.prompt_cache_retention).toBeUndefined();
  });

  it("setAutomaticCaching merges into settings without clobbering other keys", async () => {
    fixture = await captureFixture("org_auto_cache_merge");
    await fixture.db
      .update(organizationSettings)
      .set({ settings: { existingKey: "keep-me" } })
      .where(eq(organizationSettings.organizationId, "org_auto_cache_merge"));

    await fixture.persistence.organizationSettings.setAutomaticCaching("org_auto_cache_merge", true);

    const [row] = await fixture.db
      .select({ settings: organizationSettings.settings })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, "org_auto_cache_merge"))
      .limit(1);
    expect(row?.settings).toEqual({ existingKey: "keep-me", automaticCaching: true });
    expect((await fixture.persistence.organizationSettings.editable("org_auto_cache_merge")).automaticCaching).toBe(true);
  });
});
