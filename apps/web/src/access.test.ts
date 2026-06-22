import { describe, expect, it } from "vitest";

import { canAccessPath, isAdminPath, isAdminRole } from "./access";

describe("access helpers", () => {
  it("recognizes owner and admin roles", () => {
    expect(isAdminRole("owner")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("member")).toBe(false);
    expect(isAdminRole("viewer")).toBe(false);
  });

  it("marks admin-only route prefixes", () => {
    expect(isAdminPath("/api-keys")).toBe(true);
    expect(isAdminPath("/api-keys/new")).toBe(true);
    expect(isAdminPath("/limits")).toBe(true);
    expect(isAdminPath("/providers")).toBe(true);
    expect(isAdminPath("/sessions/session_1")).toBe(true);
    expect(isAdminPath("/usage")).toBe(false);
  });

  it("allows non-admin users only on dashboard routes", () => {
    expect(canAccessPath("/usage", false)).toBe(true);
    expect(canAccessPath("/cost", false)).toBe(true);
    expect(canAccessPath("/settings", false)).toBe(false);
    expect(canAccessPath("/settings", true)).toBe(true);
  });
});
