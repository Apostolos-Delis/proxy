import { describe, expect, it } from "vitest";

import type { ApiKeySummary } from "../routing/data";
import { apiKeyStatus, providerBindingValue, routingConfigFilterValue, routingConfigLabel } from "./apiKeyTableData";

function apiKey(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: "key_1",
    name: "Test key",
    userId: null,
    scopes: ["proxy"],
    routingConfigId: null,
    routingConfig: null,
    providerCredentials: [],
    createdAt: "2026-06-01T00:00:00Z",
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides
  } as ApiKeySummary;
}

describe("apiKeyStatus", () => {
  it("is revoked when revokedAt is set, regardless of expiry", () => {
    expect(apiKeyStatus(apiKey({ revokedAt: "2026-06-02T00:00:00Z" }))).toBe("revoked");
  });

  it("is expired when expiresAt is in the past", () => {
    expect(apiKeyStatus(apiKey({ expiresAt: "2000-01-01T00:00:00Z" }))).toBe("expired");
  });

  it("is active otherwise", () => {
    expect(apiKeyStatus(apiKey({ expiresAt: "2999-01-01T00:00:00Z" }))).toBe("active");
  });
});

describe("routingConfig helpers", () => {
  it("falls back to the organization default label and filter value", () => {
    expect(routingConfigLabel(apiKey())).toBe("Organization default");
    expect(routingConfigFilterValue(apiKey())).toBe("default");
  });

  it("uses the assigned config id and name when present", () => {
    const key = apiKey({ routingConfigId: "rc_9", routingConfig: { name: "Latency" } as ApiKeySummary["routingConfig"] });
    expect(routingConfigLabel(key)).toBe("Latency");
    expect(routingConfigFilterValue(key)).toBe("rc_9");
  });
});

describe("providerBindingValue", () => {
  it("reports the company default when no credentials are bound", () => {
    expect(providerBindingValue(apiKey())).toBe("company default");
  });

  it("joins bound provider credentials", () => {
    const key = apiKey({
      providerCredentials: [
        { provider: "openai", name: "prod" },
        { provider: "anthropic", name: null }
      ] as ApiKeySummary["providerCredentials"]
    });
    expect(providerBindingValue(key)).toBe("openai prod anthropic");
  });
});
