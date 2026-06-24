import { SURFACE_NAMES } from "@proxy/schema";
import { describe, expect, it } from "vitest";

import { knownSurfaceValue, normalizeUsage, providerValue, surfaceValue } from "../src/persistence/values.js";

describe("surfaceValue", () => {
  it("passes known surfaces through", () => {
    expect(surfaceValue("openai-responses")).toBe("openai-responses");
    expect(surfaceValue("anthropic-messages")).toBe("anthropic-messages");
  });

  it("passes unknown non-empty strings through verbatim", () => {
    expect(surfaceValue("openai-chat")).toBe("openai-chat");
    expect(surfaceValue("some-future-surface")).toBe("some-future-surface");
  });

  it("returns undefined for absent or non-string values", () => {
    expect(surfaceValue(undefined)).toBeUndefined();
    expect(surfaceValue(null)).toBeUndefined();
    expect(surfaceValue("")).toBeUndefined();
    expect(surfaceValue(42)).toBeUndefined();
  });
});

describe("providerValue", () => {
  it("passes known providers through", () => {
    expect(providerValue("openai")).toBe("openai");
    expect(providerValue("anthropic")).toBe("anthropic");
  });

  it("passes unknown non-empty strings through verbatim", () => {
    expect(providerValue("acme-vllm")).toBe("acme-vllm");
    expect(providerValue("deepseek")).toBe("deepseek");
  });

  it("returns undefined for absent or non-string values", () => {
    expect(providerValue(undefined)).toBeUndefined();
    expect(providerValue(null)).toBeUndefined();
    expect(providerValue("")).toBeUndefined();
    expect(providerValue({})).toBeUndefined();
  });
});

describe("knownSurfaceValue", () => {
  it("accepts exactly the canonical surface set", () => {
    for (const surface of SURFACE_NAMES) {
      expect(knownSurfaceValue(surface)).toBe(surface);
    }
    expect(knownSurfaceValue("some-future-surface")).toBeUndefined();
    expect(knownSurfaceValue("unknown")).toBeUndefined();
    expect(knownSurfaceValue(undefined)).toBeUndefined();
  });
});

describe("normalizeUsage", () => {
  it("keeps openai responses usage inclusive of cached tokens", () => {
    expect(normalizeUsage({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 600 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 1100
    })).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 600,
      cacheCreationInputTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      totalTokens: 1100
    });
  });

  it("folds anthropic cache reads and writes back into total input", () => {
    expect(normalizeUsage({
      input_tokens: 1000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 2000,
      output_tokens: 500
    })).toEqual({
      inputTokens: 13000,
      cachedInputTokens: 10000,
      cacheCreationInputTokens: 2000,
      outputTokens: 500,
      reasoningTokens: 0,
      totalTokens: 13500
    });
  });

  it("treats anthropic zero-cache usage as plain input", () => {
    expect(normalizeUsage({
      input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 5
    })).toEqual({
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 105
    });
  });

  it("normalizes chat-completions usage with cached and reasoning details", () => {
    expect(normalizeUsage({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 600, audio_tokens: 0 },
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 20, audio_tokens: 0 },
      total_tokens: 1100
    })).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 600,
      cacheCreationInputTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      totalTokens: 1100
    });
  });

  it("normalizes bare chat-completions usage without detail blocks", () => {
    expect(normalizeUsage({
      prompt_tokens: 50,
      completion_tokens: 10,
      total_tokens: 60
    })).toEqual({
      inputTokens: 50,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
      totalTokens: 60
    });
  });

  it("prefers responses keys over chat keys when both families are present", () => {
    expect(normalizeUsage({
      input_tokens: 100,
      prompt_tokens: 999,
      output_tokens: 10,
      completion_tokens: 888
    })).toMatchObject({
      inputTokens: 100,
      outputTokens: 10
    });
  });

  it("is idempotent over already-normalized usage", () => {
    const normalized = normalizeUsage({
      input_tokens: 1000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 2000,
      output_tokens: 500
    });

    expect(normalizeUsage(normalized)).toEqual(normalized);
  });
});
