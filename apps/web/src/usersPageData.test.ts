import { describe, expect, it } from "vitest";

import { labelForStatusAction, userRole, userSearchValue, userStatus, type UserSummary } from "./usersPageData";

function user(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    userId: "u1",
    email: "ada@example.com",
    name: "Ada",
    externalId: null,
    membership: { role: "admin", status: "active" },
    requestCount: 0,
    sessionCount: 0,
    usage: { totalTokens: 0 },
    cost: { selected: 0 },
    recentActivity: null,
    createdAt: "2026-06-01T00:00:00Z",
    ...overrides
  } as UserSummary;
}

describe("userStatus / userRole", () => {
  it("reads membership status and role when present", () => {
    expect(userStatus(user())).toBe("active");
    expect(userRole(user())).toBe("admin");
  });

  it("treats users without membership as observed with no role", () => {
    const observed = user({ membership: null });
    expect(userStatus(observed)).toBe("observed");
    expect(userRole(observed)).toBe("");
  });
});

describe("userSearchValue", () => {
  it("collects truthy identity and membership fields", () => {
    expect(userSearchValue(user({ externalId: "ext-9" }))).toEqual([
      "u1",
      "Ada",
      "ada@example.com",
      "ext-9",
      "admin",
      "active"
    ]);
  });
});

describe("labelForStatusAction", () => {
  it("uses progressive labels while pending and resting labels otherwise", () => {
    expect(labelForStatusAction(false, true)).toBe("Deactivating");
    expect(labelForStatusAction(true, true)).toBe("Reactivating");
    expect(labelForStatusAction(false, false)).toBe("Deactivate");
    expect(labelForStatusAction(true, false)).toBe("Reactivate");
  });
});
