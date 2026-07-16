import { describe, expect, it } from "vitest";

import { rewriteSurfaceRequest } from "../src/adapters.js";

function openAIChatDecision(model = "gpt-5.5", settings: Record<string, unknown> = {}) {
  const { effort, maxOutputTokens, ...rest } = settings;
  return {
    outcome: "route" as const,
    requestedModel: "coding-auto",
    selectedModel: model,
    surface: "openai-chat" as const,
    provider: "openai" as const,
    deployment: {
      key: "test-openai",
      provider: "openai" as const,
      model,
      order: 0,
      weight: 1,
      timeoutMs: 60000
    },
    providerSettings: {
      provider: "openai" as const,
      model,
      dialect: "openai-chat" as const,
      ...rest,
      deployment: {
        key: "test-openai",
        provider: "openai" as const,
        model,
        order: 0,
        weight: 1,
        timeoutMs: 60000
      },
      openai: {
        provider: "openai" as const,
        model,
        order: 0,
        weight: 1,
        timeoutMs: 60000,
        reasoning: typeof effort === "string" ? { effort } : undefined,
        maxOutputTokens: typeof maxOutputTokens === "number" ? maxOutputTokens : undefined
      }
    },
    guardrailActions: [],
    reasonCodes: [],
    policyVersion: "test"
  };
}

function anthropicDecision(
  surface: "anthropic-messages" | "openai-responses" = "anthropic-messages",
  model = "claude-sonnet-4-5",
  settings: Record<string, unknown> = {}
) {
  const { thinking, ...rest } = settings;
  return {
    outcome: "route" as const,
    requestedModel: "economy-auto",
    selectedModel: model,
    surface,
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
      ...rest,
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
        timeoutMs: 60000,
        thinking
      }
    },
    guardrailActions: [],
    reasonCodes: [],
    policyVersion: "test"
  };
}

describe("openai-chat rewrite", () => {
  it("injects include_usage for streaming chat requests when absent", () => {
    const body = {
      model: "fable",
      stream: true,
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision()) as any;

    expect(result.model).toBe("gpt-5.5");
    expect(result.stream_options).toEqual({ include_usage: true });
  });

  it("preserves explicit include_usage and other stream options", () => {
    const body = {
      model: "fable",
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
      model: "fable",
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision()) as any;

    expect(result.stream_options).toBeUndefined();
  });

  it("preserves prompt_cache_retention", () => {
    const body = {
      model: "fable",
      prompt_cache_retention: "24h",
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision()) as any;

    expect(result.prompt_cache_retention).toBe("24h");
  });

  it("prepends the proxy system prompt", () => {
    const body = {
      model: "fable",
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
      model: "fable",
      reasoning_effort: "low",
      messages: [{ role: "user", content: "hi" }]
    };

    const result = rewriteSurfaceRequest(body, openAIChatDecision("gpt-5.5", {
      effort: "xhigh",
      maxOutputTokens: 1234
    })) as any;

    expect(result.reasoning_effort).toBe("xhigh");
    expect(result.max_completion_tokens).toBe(1234);
  });
});

describe("anthropic-messages rewrite", () => {
  it("fills required max tokens when translating Responses without an output limit", () => {
    const body = {
      model: "economy-auto",
      input: "hi"
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision("openai-responses")) as any;

    expect(result.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(result.max_tokens).toBe(4096);
  });

  it("removes clear-thinking context management when thinking is not forwarded", () => {
    const body = {
      model: "fable",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
      context_management: {
        edits: [
          { type: "clear_thinking_20251015", keep: "all" },
          { type: "clear_tool_uses_20250919" }
        ]
      },
      max_tokens: 16
    };

    const result = rewriteSurfaceRequest(body, anthropicDecision("anthropic-messages", "claude-sonnet-4-5")) as any;

    expect(result.thinking).toBeUndefined();
    expect(result.context_management).toEqual({
      edits: [{ type: "clear_tool_uses_20250919" }]
    });
    expect(result.max_tokens).toBe(16);
  });

  it("keeps clear-thinking context management when adaptive thinking is forwarded", () => {
    const body = {
      model: "fable",
      messages: [{ role: "user", content: "hi" }],
      context_management: {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }]
      },
      max_tokens: 16
    };

    const result = rewriteSurfaceRequest(
      body,
      anthropicDecision("anthropic-messages", "claude-sonnet-4-6", {
        thinking: { type: "adaptive", display: "omitted" }
      })
    ) as any;

    expect(result.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(result.context_management).toEqual({
      edits: [{ type: "clear_thinking_20251015", keep: "all" }]
    });
  });
});
