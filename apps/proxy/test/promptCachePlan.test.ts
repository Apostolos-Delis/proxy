import {
  ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
  CONSERVATIVE_PROVIDER_CACHING_CAPABILITIES,
  OPENAI_PROVIDER_CACHING_CAPABILITIES
} from "@proxy/schema";
import { describe, expect, it } from "vitest";

import { computePromptCachePlan } from "../src/promptCachePlan.js";
import type { RouteDecision } from "../src/types.js";

function decision(provider: "openai" | "anthropic", dialect: "openai-responses" | "openai-chat" | "anthropic-messages"): RouteDecision {
  return {
    outcome: "route",
    surface: dialect,
    requestedModel: "router-hard",
    finalRoute: "hard",
    selectedModel: provider === "openai" ? "gpt-5.5" : "claude-opus-4-8",
    provider,
    providerSettings: {
      provider,
      model: provider === "openai" ? "gpt-5.5" : "claude-opus-4-8",
      dialect,
      deployment: {
        key: `test-${provider}`,
        provider,
        model: provider === "openai" ? "gpt-5.5" : "claude-opus-4-8",
        order: 0,
        weight: 1,
        timeoutMs: 60000
      },
      ...(provider === "openai"
        ? { openai: { provider, model: "gpt-5.5", order: 0, weight: 1, timeoutMs: 60000 } }
        : { anthropic: { provider, model: "claude-opus-4-8", order: 0, weight: 1, timeoutMs: 60000 } })
    } as RouteDecision["providerSettings"],
    guardrailActions: [],
    reasonCodes: []
  };
}

describe("computePromptCachePlan", () => {
  it("reports OpenAI implicit prefix controls without exposing cache-key values", () => {
    const body = {
      model: "router-hard",
      input: "hello",
      prompt_cache_key: "customer-session-123",
      prompt_cache_retention: "24h"
    };

    const plan = computePromptCachePlan({
      body,
      context: { surface: "openai-responses", estimatedInputTokens: 1200 },
      decision: decision("openai", "openai-responses"),
      capabilities: OPENAI_PROVIDER_CACHING_CAPABILITIES
    });

    expect(plan).toMatchObject({
      mode: "implicit",
      provider: "openai",
      dialect: "openai-responses",
      cacheKey: "provided",
      retention: "24h",
      appliedControls: ["implicit_prefix_caching", "cache_key_preserved", "retention_preserved"]
    });
    expect(JSON.stringify(plan)).not.toContain("customer-session-123");
  });

  it("plans Anthropic automatic caching for eligible multi-turn requests", () => {
    const plan = computePromptCachePlan({
      body: {
        model: "claude-router-hard",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "follow up" }
        ]
      },
      context: { surface: "anthropic-messages" },
      decision: decision("anthropic", "anthropic-messages"),
      capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
      settings: { automaticCaching: true, cacheTtlUpgrade: false }
    });

    expect(plan).toMatchObject({
      mode: "explicit",
      provider: "anthropic",
      dialect: "anthropic-messages",
      breakpointStrategy: "top_level_auto",
      appliedControls: ["top_level_auto_breakpoint"]
    });
  });

  it("does not apply OpenAI cache fields to translated Anthropic targets", () => {
    const plan = computePromptCachePlan({
      body: {
        model: "router-hard",
        input: "hello",
        prompt_cache_key: "customer-session-123",
        prompt_cache_retention: "24h"
      },
      context: { surface: "openai-responses" },
      decision: {
        ...decision("anthropic", "anthropic-messages"),
        surface: "openai-responses"
      },
      capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
      settings: { automaticCaching: true, cacheTtlUpgrade: true }
    });

    expect(plan.cacheKey).toBeUndefined();
    expect(plan.retention).toBeUndefined();
    expect(plan.appliedControls).not.toContain("cache_key_preserved");
    expect(plan.appliedControls).not.toContain("retention_preserved");
    expect(JSON.stringify(plan)).not.toContain("customer-session-123");
  });

  it("preserves client Anthropic breakpoints and observes TTL upgrade eligibility", () => {
    const largeText = "x".repeat(12000);
    const plan = computePromptCachePlan({
      body: {
        model: "claude-router-hard",
        system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "follow up" }
        ]
      },
      context: { surface: "anthropic-messages" },
      decision: decision("anthropic", "anthropic-messages"),
      capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
      settings: { automaticCaching: true, cacheTtlUpgrade: true }
    });

    expect(plan).toMatchObject({
      mode: "explicit",
      breakpointStrategy: "preserve_client",
      appliedControls: ["client_breakpoints_preserved", "ttl_1h"]
    });
  });

  it("uses conservative defaults for providers without cache capabilities", () => {
    const plan = computePromptCachePlan({
      body: { model: "custom", messages: [{ role: "user", content: "hi" }] },
      context: { surface: "openai-chat" },
      decision: {
        ...decision("openai", "openai-chat"),
        provider: "acme-vllm",
        providerSettings: {
          ...decision("openai", "openai-chat").providerSettings!,
          provider: "acme-vllm"
        }
      },
      capabilities: CONSERVATIVE_PROVIDER_CACHING_CAPABILITIES
    });

    expect(plan).toEqual({
      mode: "off",
      provider: "acme-vllm",
      dialect: "openai-chat",
      appliedControls: [],
      skippedControls: [{ control: "prompt_cache", reason: "provider_capability_unavailable" }]
    });
  });

  it("does not mutate the request body", () => {
    const body = {
      model: "claude-router-hard",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow up" }
      ]
    };
    const before = structuredClone(body);

    computePromptCachePlan({
      body,
      context: { surface: "anthropic-messages" },
      decision: decision("anthropic", "anthropic-messages"),
      capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
      settings: { automaticCaching: true, cacheTtlUpgrade: true }
    });

    expect(body).toEqual(before);
  });
});
