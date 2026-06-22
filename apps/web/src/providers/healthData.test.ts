import { describe, expect, it } from "vitest";

import type { ProviderAccountSummary } from "./data";
import {
  modelHealthRows,
  providerHealthLabel,
  providerHealthSearchTokens,
  providerHealthTone
} from "./healthData";

describe("provider health display helpers", () => {
  it("distinguishes missing health from a healthy account", () => {
    expect(providerHealthLabel(null)).toBe("No data");
    expect(providerHealthTone(null)).toBe("default");

    expect(providerHealthLabel(account({ status: "healthy" }).health)).toBe("Healthy");
    expect(providerHealthTone(account({ status: "healthy" }).health)).toBe("success");
  });

  it("surfaces cooldown and terminal health as operator-visible states", () => {
    const cooldown = account({
      status: "cooldown",
      cooldownUntil: "2026-06-18T12:05:00.000Z",
      lastErrorType: "rate_limited"
    }).health;
    const terminal = account({ status: "terminal", lastErrorType: "auth_invalid" }).health;

    expect(providerHealthLabel(cooldown)).toBe("Cooldown");
    expect(providerHealthTone(cooldown)).toBe("warn");
    expect(providerHealthLabel(terminal)).toBe("Terminal");
    expect(providerHealthTone(terminal)).toBe("danger");
  });

  it("adds health and model lockout values to provider account search tokens", () => {
    const tokens = providerHealthSearchTokens(account({
      status: "cooldown",
      lastErrorType: "rate_limited",
      modelHealth: [
        model({ model: "gpt-locked", status: "locked_out", lastErrorType: "model_unavailable" })
      ]
    }));

    expect(tokens).toEqual(expect.arrayContaining([
      "Cooldown",
      "cooldown",
      "rate_limited",
      "gpt-locked",
      "locked_out",
      "model_unavailable"
    ]));
  });

  it("orders model health rows by lockouts first, then by model", () => {
    const rows = modelHealthRows(account({
      modelHealth: [
        model({ model: "z-healthy", status: "healthy" }),
        model({ model: "a-locked", status: "locked_out" }),
        model({ model: "b-error", status: "unknown", lastErrorType: "provider_unavailable" })
      ]
    }).health);

    expect(rows.map((row) => row.model)).toEqual(["a-locked", "b-error", "z-healthy"]);
  });
});

function account(health: Partial<NonNullable<ProviderAccountSummary["health"]>> | null): ProviderAccountSummary {
  return {
    id: "account_1",
    organizationId: "org_1",
    provider: "openai",
    name: "OpenAI key",
    authType: "api_key",
    status: "active",
    baseUrl: null,
    secretHint: "sk_1234",
    ownerUserId: null,
    boundKeyCount: 0,
    health: health ? {
      status: "healthy",
      cooldownUntil: null,
      lastErrorType: null,
      lastErrorAt: null,
      lastSuccessAt: null,
      lastCheckedAt: null,
      consecutiveFailures: 0,
      modelHealth: [],
      ...health
    } : null,
    createdAt: "2026-06-18T12:00:00.000Z",
    lastUsedAt: null
  };
}

function model(overrides: Partial<NonNullable<ProviderAccountSummary["health"]>["modelHealth"][number]>) {
  return {
    providerId: "00000000-0000-0000-0000-000000000001",
    providerAccountId: "account_1",
    model: "gpt-test",
    status: "healthy",
    lastErrorType: null,
    lastErrorAt: null,
    lockoutUntil: null,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    ...overrides
  };
}
