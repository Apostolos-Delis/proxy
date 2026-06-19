import { describe, expect, it } from "vitest";

import { classifyProviderTerminalHealth } from "../src/providerHealth.js";
import { shouldUpdateHealthFromProbe } from "../src/providerHealthProbe.js";

const now = new Date("2026-06-18T12:00:00.000Z");

describe("shouldUpdateHealthFromProbe", () => {
  it("updates for high-confidence account and model failures", () => {
    const rateLimit = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-5",
      terminalStatus: "failed",
      statusCode: 429,
      error: "rate limited",
      now
    });
    const modelUnavailable = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-missing",
      terminalStatus: "failed",
      statusCode: 404,
      error: "model gpt-missing not found",
      now
    });

    expect(shouldUpdateHealthFromProbe(rateLimit)).toBe(true);
    expect(shouldUpdateHealthFromProbe(modelUnavailable)).toBe(true);
  });

  it("does not update for provider-wide, request-only, or unknown failures", () => {
    const providerUnavailable = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-5",
      terminalStatus: "failed",
      statusCode: 503,
      error: "upstream unavailable",
      now
    });
    const requestOnly = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-5",
      terminalStatus: "failed",
      statusCode: 400,
      error: "context_length_exceeded",
      now
    });
    const unknown = classifyProviderTerminalHealth({
      provider: "openai",
      model: "gpt-5",
      terminalStatus: "failed",
      statusCode: 0,
      error: "fetch failed",
      now
    });

    expect(shouldUpdateHealthFromProbe(providerUnavailable)).toBe(false);
    expect(shouldUpdateHealthFromProbe(requestOnly)).toBe(false);
    expect(shouldUpdateHealthFromProbe(unknown)).toBe(false);
  });
});
