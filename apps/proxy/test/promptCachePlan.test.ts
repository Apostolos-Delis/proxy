import {
  ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
  CONSERVATIVE_PROVIDER_CACHING_CAPABILITIES,
  OPENAI_PROVIDER_CACHING_CAPABILITIES,
  type ProviderCachingCapabilities
} from "@proxy/schema";
import { describe, expect, it } from "vitest";

import { computePromptCachePlan, promptCachePlanEventPayload } from "../src/promptCachePlan.js";
import type { RouteDecision } from "../src/types.js";
import { sha256 } from "../src/util.js";

const GEMINI_PROVIDER_CACHING_CAPABILITIES = {
  implicitPrefixCaching: true,
  explicitBreakpoints: false,
  supportedTtls: [],
  prewarm: false,
  usageShape: "gemini"
} satisfies ProviderCachingCapabilities;

function decision(
  provider: string,
  dialect: "openai-responses" | "openai-chat" | "anthropic-messages",
  model = modelForProvider(provider)
): RouteDecision {
  let providerSpecificSettings = {};
  if (provider === "openai") {
    providerSpecificSettings = { openai: { provider, model, order: 0, weight: 1, timeoutMs: 60000 } };
  } else if (provider === "anthropic") {
    providerSpecificSettings = { anthropic: { provider, model, order: 0, weight: 1, timeoutMs: 60000 } };
  }

  return {
    outcome: "route",
    surface: dialect,
    requestedModel: "router-hard",
    finalRoute: "hard",
    selectedModel: model,
    provider,
    providerSettings: {
      provider,
      model,
      dialect,
      deployment: {
        key: `test-${provider}`,
        provider,
        model,
        order: 0,
        weight: 1,
        timeoutMs: 60000
      },
      ...providerSpecificSettings
    } as RouteDecision["providerSettings"],
    guardrailActions: [],
    reasonCodes: []
  };
}

function modelForProvider(provider: string) {
  if (provider === "anthropic") return "claude-opus-4-8";
  if (provider === "openai") return "gpt-5.5";
  return "gemini-2.5-pro";
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
      context: { surface: "openai-responses", estimatedInputTokens: 1200, sessionId: "session_abc" },
      decision: decision("openai", "openai-responses"),
      capabilities: OPENAI_PROVIDER_CACHING_CAPABILITIES
    });

    expect(plan).toMatchObject({
      mode: "implicit",
      provider: "openai",
      dialect: "openai-responses",
      cacheKey: "provided",
      cacheGroup: {
        source: "prompt_cache_key",
        key: sha256("prompt_cache_key:customer-session-123")
      },
      retention: "24h",
      appliedControls: ["implicit_prefix_caching", "cache_key_preserved", "retention_preserved"]
    });
    expect(JSON.stringify(plan)).not.toContain("customer-session-123");
    expect(JSON.stringify(promptCachePlanEventPayload({
      surface: "openai-responses",
      model: "gpt-5.5",
      route: "hard",
      plan
    }))).not.toContain("customer-session-123");
  });

  it("falls OpenAI implicit cache grouping back to the session identity", () => {
    const plan = computePromptCachePlan({
      body: {
        model: "router-hard",
        input: "hello"
      },
      context: { surface: "openai-responses", sessionId: "session_abc" },
      decision: decision("openai", "openai-responses"),
      capabilities: OPENAI_PROVIDER_CACHING_CAPABILITIES
    });

    expect(plan.cacheGroup).toEqual({ source: "session", key: "session_abc" });
  });

  it("preserves OpenAI cache fields across Responses to Chat translation", () => {
    const body = {
      model: "router-hard",
      input: "hello",
      prompt_cache_key: "responses-cache-key",
      prompt_cache_retention: "24h"
    };

    const plan = computePromptCachePlan({
      body,
      sourceBody: body,
      context: { surface: "openai-responses" },
      decision: {
        ...decision("openai", "openai-chat"),
        surface: "openai-responses"
      },
      capabilities: OPENAI_PROVIDER_CACHING_CAPABILITIES
    });

    expect(plan.appliedControls).toEqual([
      "implicit_prefix_caching",
      "cache_key_preserved",
      "retention_preserved"
    ]);
    expect(plan.skippedControls).toEqual([]);
  });

  it("preserves OpenAI cache fields across Chat to Responses translation", () => {
    const body = {
      model: "router-hard",
      messages: [{ role: "user", content: "hello" }],
      prompt_cache_key: "chat-cache-key",
      prompt_cache_retention: "24h"
    };

    const plan = computePromptCachePlan({
      body,
      sourceBody: body,
      context: { surface: "openai-chat" },
      decision: {
        ...decision("openai", "openai-responses"),
        surface: "openai-chat"
      },
      capabilities: OPENAI_PROVIDER_CACHING_CAPABILITIES
    });

    expect(plan.appliedControls).toEqual([
      "implicit_prefix_caching",
      "cache_key_preserved",
      "retention_preserved"
    ]);
    expect(plan.skippedControls).toEqual([]);
  });

  it("reports dropped OpenAI cache fields on Responses to Anthropic translation", () => {
    const body = {
      model: "router-hard",
      input: "hello",
      prompt_cache_key: "responses-cache-key",
      prompt_cache_retention: "24h"
    };

    const plan = computePromptCachePlan({
      body,
      sourceBody: body,
      context: { surface: "openai-responses" },
      decision: {
        ...decision("anthropic", "anthropic-messages"),
        surface: "openai-responses"
      },
      capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
      settings: { automaticCaching: false, cacheTtlUpgrade: false }
    });

    expect(plan.skippedControls).toEqual([
      { control: "top_level_auto_breakpoint", reason: "setting_disabled" },
      { control: "cache_key_preserved", reason: "translated_request" },
      { control: "retention_preserved", reason: "translated_request" },
      { control: "cross_dialect_cache_fields", reason: "translated_request" }
    ]);
  });

  it("reports dropped Anthropic cache controls on Anthropic to OpenAI translation", () => {
    const body = {
      model: "claude-router-hard",
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hello" }]
    };

    const plan = computePromptCachePlan({
      body,
      sourceBody: body,
      context: { surface: "anthropic-messages" },
      decision: {
        ...decision("openai", "openai-chat"),
        surface: "anthropic-messages"
      },
      capabilities: OPENAI_PROVIDER_CACHING_CAPABILITIES
    });

    expect(plan.appliedControls).toEqual(["implicit_prefix_caching"]);
    expect(plan.skippedControls).toEqual([
      { control: "client_breakpoints_preserved", reason: "translated_request" },
      { control: "cross_dialect_cache_fields", reason: "translated_request" }
    ]);
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

  it("skips Anthropic TTL upgrade when the marked prefix is below the threshold", () => {
    const largeText = "x".repeat(12000);
    const plan = computePromptCachePlan({
      body: {
        model: "claude-router-hard",
        system: [{ type: "text", text: "short stable prefix", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: largeText },
          { role: "user", content: "follow up" }
        ]
      },
      context: { surface: "anthropic-messages" },
      decision: decision("anthropic", "anthropic-messages"),
      capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
      settings: { automaticCaching: true, cacheTtlUpgrade: true }
    });

    expect(plan.appliedControls).toContain("client_breakpoints_preserved");
    expect(plan.appliedControls).not.toContain("ttl_1h");
    expect(plan.skippedControls).toContainEqual({ control: "ttl_1h", reason: "not_eligible" });
  });

  it("skips Anthropic TTL upgrade when every breakpoint already has an explicit TTL", () => {
    const largeText = "x".repeat(12000);
    const plan = computePromptCachePlan({
      body: {
        model: "claude-router-hard",
        system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral", ttl: "5m" } }],
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

    expect(plan.appliedControls).toContain("client_breakpoints_preserved");
    expect(plan.appliedControls).not.toContain("ttl_1h");
    expect(plan.skippedControls).toContainEqual({ control: "ttl_1h", reason: "not_eligible" });
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

  it("represents Gemini implicit caching in observe-only plan data", () => {
    const plan = computePromptCachePlan({
      body: {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "large shared prefix" }],
        prompt_cache_key: "client-cache-key",
        prompt_cache_retention: "24h"
      },
      context: { surface: "openai-chat", sessionId: "session_gemini" },
      decision: decision("google-gemini", "openai-chat"),
      capabilities: GEMINI_PROVIDER_CACHING_CAPABILITIES
    });

    expect(plan).toEqual({
      mode: "implicit",
      provider: "google-gemini",
      dialect: "openai-chat",
      cacheGroup: { source: "session", key: "session_gemini" },
      appliedControls: ["implicit_prefix_caching"],
      skippedControls: [
        { control: "cache_key_preserved", reason: "provider_capability_unavailable" },
        { control: "retention_preserved", reason: "provider_capability_unavailable" }
      ]
    });

    expect(promptCachePlanEventPayload({
      surface: "openai-chat",
      model: "gemini-2.5-pro",
      route: "hard",
      plan
    })).toMatchObject({
      provider: "google-gemini",
      mode: "implicit",
      appliedControls: ["implicit_prefix_caching"],
      skippedControls: [
        { control: "cache_key_preserved", reason: "provider_capability_unavailable" },
        { control: "retention_preserved", reason: "provider_capability_unavailable" }
      ]
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
