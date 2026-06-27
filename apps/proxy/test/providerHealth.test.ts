import { describe, expect, it } from "vitest";

import { PROVIDER_HEALTH_MESSAGE_MAX_CHARS } from "@proxy/schema";

import { classifyProviderTerminalHealth } from "../src/providerHealth.js";

const now = new Date("2026-06-18T12:00:00.000Z");

describe("classifyProviderTerminalHealth", () => {
  it("returns no health classification for successful attempts", () => {
    expect(classifyProviderTerminalHealth({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      terminalStatus: "completed",
      statusCode: 200,
      now
    })).toBeUndefined();
  });

  it.each([
    ["auth_invalid", 401, "invalid api key", "provider_account"],
    ["auth_expired", 401, "access token expired", "provider_account"],
    ["rate_limited", 429, "too many requests", "provider_account"],
    ["quota_exhausted", 429, "insufficient_quota", "provider_account"],
    ["provider_unavailable", 503, "upstream unavailable", "provider"],
    ["model_unavailable", 404, "model claude-missing not found", "provider_account_model"],
    ["model_access_denied", 403, "does not have access to model claude-opus", "provider_account_model"],
    ["context_overflow", 400, "context_length_exceeded", "request_only"],
    ["request_incompatible", 400, "unsupported_parameter: temperature", "request_only"],
    ["unknown_terminal", 418, "teapot", "request_only"]
  ])("classifies %s", (errorType, statusCode, error, scope) => {
    const result = classifyProviderTerminalHealth({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      terminalStatus: "failed",
      statusCode,
      error,
      now
    });

    expect(result).toEqual(expect.objectContaining({
      errorType,
      scope
    }));
  });

  it("classifies stream observer failures and disconnects", () => {
    const failed = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-5",
      terminalStatus: "failed",
      statusCode: 200,
      error: "stream parser failed",
      streamStatus: "failed",
      now
    });
    const disconnected = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-5",
      terminalStatus: "cancelled",
      now
    });

    expect(failed).toEqual(expect.objectContaining({
      errorType: "stream_failed",
      scope: "request_only"
    }));
    expect(disconnected).toEqual(expect.objectContaining({
      errorType: "stream_disconnected",
      scope: "request_only"
    }));
  });

  it("classifies network-like failures as unknown transient with short cooldown", () => {
    const result = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-5",
      terminalStatus: "failed",
      error: "connect ECONNRESET",
      now
    });

    expect(result).toEqual(expect.objectContaining({
      errorType: "unknown_transient",
      retryable: true,
      scope: "provider_account",
      cooldownUntil: "2026-06-18T12:00:30.000Z"
    }));
  });

  it("uses retry-after for rate-limit cooldowns", () => {
    const result = classifyProviderTerminalHealth({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      terminalStatus: "failed",
      statusCode: 429,
      error: "rate limited",
      headers: { "Retry-After": "15" },
      now
    });

    expect(result?.cooldownUntil).toBe("2026-06-18T12:00:15.000Z");
  });

  it("uses adapter classifications when provided", () => {
    const result = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-5",
      terminalStatus: "failed",
      statusCode: 400,
      error: "provider body did not matter",
      adapterClassification: {
        category: "context_too_large",
        errorType: "context_overflow",
        source: "response_body",
        retryable: false,
        fatal: true,
        scope: "request_only",
        message: "adapter says context overflow"
      },
      now
    });

    expect(result).toEqual(expect.objectContaining({
      errorType: "context_overflow",
      source: "response_body",
      retryable: false,
      scope: "request_only",
      message: "adapter says context overflow",
      metadata: expect.objectContaining({
        adapterCategory: "context_too_large",
        fatal: true,
        provider: "openai",
        model: "gpt-5"
      })
    }));
  });

  it("does not apply retry-after to request-only failures", () => {
    const result = classifyProviderTerminalHealth({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      terminalStatus: "failed",
      statusCode: 400,
      error: "context_length_exceeded",
      headers: { "retry-after": "15" },
      now
    });

    expect(result).toEqual(expect.objectContaining({
      errorType: "context_overflow",
      cooldownUntil: null
    }));
  });

  it("does not classify non-auth expired messages as auth expiration", () => {
    const result = classifyProviderTerminalHealth({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      terminalStatus: "failed",
      statusCode: 400,
      error: "request timestamp expired",
      now
    });

    expect(result?.errorType).not.toBe("auth_expired");
  });

  it("caps sanitized provider error messages", () => {
    const result = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-5",
      terminalStatus: "failed",
      statusCode: 400,
      error: "x".repeat(PROVIDER_HEALTH_MESSAGE_MAX_CHARS + 1),
      now
    });

    expect(result?.message).toHaveLength(PROVIDER_HEALTH_MESSAGE_MAX_CHARS);
  });
});
