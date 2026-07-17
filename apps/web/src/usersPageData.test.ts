import { describe, expect, it } from "vitest";

import { adjacentUserId, labelForStatusAction, userRole, userSearchValue, userStatus, type UserSummary } from "./usersPageData";

function user(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    userId: "u1",
    email: "ada@example.com",
    name: "Ada",
    externalId: null,
    membership: { role: "admin", status: "active" },
    apiKeyCount: 0,
    requestCount: 0,
    sessionCount: 0,
    usage: { totalTokens: 0 },
    cost: { selected: 0 },
    usage30d: { totalTokens: 0 },
    cost30d: { selected: 0 },
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

  it("treats users without membership as unknown with no role", () => {
    const unknown = user({ membership: null });
    expect(userStatus(unknown)).toBe("unknown");
    expect(userRole(unknown)).toBe("");
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

describe("adjacentUserId", () => {
  const users = [user({ userId: "u1" }), user({ userId: "u2" }), user({ userId: "u3" })];

  it("moves within the visible user order and stops at either end", () => {
    expect(adjacentUserId(users, "u2", -1)).toBe("u1");
    expect(adjacentUserId(users, "u2", 1)).toBe("u3");
    expect(adjacentUserId(users, "u1", -1)).toBe("u1");
    expect(adjacentUserId(users, "u3", 1)).toBe("u3");
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
