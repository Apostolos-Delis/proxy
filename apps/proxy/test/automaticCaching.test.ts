import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { organizationSettings } from "@proxy/db";
import { ANTHROPIC_PROVIDER_CACHING_CAPABILITIES } from "@proxy/schema";

import {
  applyPromptCachePlan,
  computePromptCachePlan
} from "../src/promptCachePlan.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

function rewriteAnthropicWithPlan(body: unknown, settings: { automaticCaching?: boolean; cacheTtlUpgrade?: boolean }) {
  const request = structuredClone(body);
  const plan = computePromptCachePlan({
    body: request,
    context: { surface: "anthropic-messages" },
    target: { provider: "anthropic", dialect: "anthropic-messages" },
    capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
    settings
  });
  applyPromptCachePlan(request, plan, true);
  return request as any;
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
    const body = { model: "fable", messages: multiTurnMessages };

    const result = rewriteAnthropicWithPlan(body, { automaticCaching: true });
    expect(result.cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips single-turn requests so one-shot prompts never pay the write surcharge", () => {
    const body = { model: "fable", messages: [{ role: "user", content: "hi" }] };

    const result = rewriteAnthropicWithPlan(body, { automaticCaching: true });
    expect(result.cache_control).toBeUndefined();
  });

  it("skips requests that already carry a system breakpoint", () => {
    const body = {
      model: "fable",
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
      messages: multiTurnMessages
    };

    const result = rewriteAnthropicWithPlan(body, { automaticCaching: true });
    expect(result.cache_control).toBeUndefined();
  });

  it("skips requests that already carry a tool-definition breakpoint", () => {
    const body = {
      model: "fable",
      tools: [{ name: "get_weather", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
      messages: multiTurnMessages
    };

    const result = rewriteAnthropicWithPlan(body, { automaticCaching: true });
    expect(result.cache_control).toBeUndefined();
  });

  it("skips requests that already carry a message-content breakpoint", () => {
    const body = {
      model: "fable",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: [{ type: "text", text: "follow-up", cache_control: { type: "ephemeral" } }] }
      ]
    };

    const result = rewriteAnthropicWithPlan(body, { automaticCaching: true });
    expect(result.cache_control).toBeUndefined();
  });

  it("skips requests with a breakpoint nested inside tool_result content", () => {
    const body = {
      model: "fable",
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

    const result = rewriteAnthropicWithPlan(body, { automaticCaching: true });
    expect(result.cache_control).toBeUndefined();
  });

  it("leaves a client-sent top-level field as-is", () => {
    const body = {
      model: "fable",
      cache_control: { type: "ephemeral", ttl: "1h" },
      messages: multiTurnMessages
    };

    const result = rewriteAnthropicWithPlan(body, { automaticCaching: true });
    expect(result.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("gives an injected breakpoint the 1h TTL when both settings are on", () => {
    const body = { model: "fable", messages: largeMultiTurnMessages };

    const result = rewriteAnthropicWithPlan(body, {
      automaticCaching: true,
      cacheTtlUpgrade: true
    });
    expect(result.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps an injected breakpoint at the default TTL for small multi-turn requests", () => {
    const body = { model: "fable", messages: multiTurnMessages };

    const result = rewriteAnthropicWithPlan(body, {
      automaticCaching: true,
      cacheTtlUpgrade: true
    });
    expect(result.cache_control).toEqual({ type: "ephemeral" });
  });

  it("is a no-op when automaticCaching is not set", () => {
    const body = { model: "fable", messages: multiTurnMessages };

    const result = rewriteAnthropicWithPlan(body, {});
    expect(result.cache_control).toBeUndefined();
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
        model: "fable",
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

  it("forwards OpenAI requests with client-set prompt_cache_retention", async () => {
    fixture = await captureFixture("org_pcr");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({ model: "coding-auto", input: "hello", stream: true, prompt_cache_retention: "24h" })
    });
    await response.text();

    const providerCall = fixture.openai.records.find((rec) =>
      rec.path === "/responses" && rec.body.model !== "route-classifier-cheap"
    );
    expect(providerCall?.body.prompt_cache_retention).toBe("24h");
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
