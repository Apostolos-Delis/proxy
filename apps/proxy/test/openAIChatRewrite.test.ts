import { describe, expect, it } from "vitest";

import { rewriteSurfaceRequest } from "../src/adapters.js";

function openAIChatDecision(model = "gpt-5.5", settings: Record<string, unknown> = {}) {
  return {
    outcome: "route" as const,
    finalRoute: "hard" as const,
    selectedModel: model,
    surface: "openai-chat" as const,
    provider: "openai" as const,
    providerSettings: {
      providerId: "openai" as const,
      model,
      dialect: "openai-chat" as const,
      ...settings
    }
  };
}

describe("openai-chat rewrite", () => {
  it("injects include_usage for streaming chat requests when absent", () => {
    const body = {
      model: "anthropic-router-hard",
      stream: true,
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision()) as any;

    expect(result.model).toBe("gpt-5.5");
    expect(result.stream_options).toEqual({ include_usage: true });
  });

  it("preserves explicit include_usage and other stream options", () => {
    const body = {
      model: "anthropic-router-hard",
      stream: true,
      stream_options: {
        include_usage: false,
        other: "keep"
      },
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision()) as any;

    expect(result.stream_options).toEqual({ include_usage: false, other: "keep" });
  });

  it("does not add stream_options to non-streaming chat requests", () => {
    const body = {
      model: "anthropic-router-hard",
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision()) as any;

    expect(result.stream_options).toBeUndefined();
  });

  it("drops prompt_cache_retention", () => {
    const body = {
      model: "anthropic-router-hard",
      prompt_cache_retention: "24h",
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision()) as any;

    expect(result.prompt_cache_retention).toBeUndefined();
  });

  it("prepends the proxy system prompt", () => {
    const body = {
      model: "anthropic-router-hard",
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision(), "route carefully") as any;

    expect(result.messages).toEqual([
      { role: "system", content: "route carefully" },
      { role: "user", content: "hi" }
    ]);
  });

  it("applies selected effort and max tokens with chat field names", () => {
    const body = {
      model: "anthropic-router-hard",
      reasoning_effort: "low",
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision("gpt-5.5", {
      effort: "max",
      maxOutputTokens: 1234
    })) as any;

    expect(result.reasoning_effort).toBe("xhigh");
    expect(result.max_completion_tokens).toBe(1234);
  });
});
