import { describe, expect, it } from "vitest";

import { accessProfileFilterValue, accessProfileLabel, apiKeyStatus } from "./apiKeyTableData";
import type { ApiKeySummary } from "./data";

function apiKey(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: "key_1",
    name: "Test key",
    userId: null,
    accessProfileId: null,
    accessProfile: null,
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

describe("access profile helpers", () => {
  it("labels an unassigned key", () => {
    expect(accessProfileLabel(apiKey())).toBe("Unassigned");
    expect(accessProfileFilterValue(apiKey())).toBe("unassigned");
  });

  it("uses the assigned profile id and name", () => {
    const key = apiKey({
      accessProfileId: "profile_9",
      accessProfile: { id: "profile_9", name: "Internal engineering", status: "active" }
    });
    expect(accessProfileLabel(key)).toBe("Internal engineering");
    expect(accessProfileFilterValue(key)).toBe("profile_9");
  });
});
