import { describe, expect, it } from "vitest";

import { pageScopeFromMatch, pageScopeLabel } from "./pageScope";

describe("page scope mapping", () => {
  it("maps detail route matches to entity scopes with pre-decoded params", () => {
    expect(pageScopeFromMatch("/routing-configs/$configId", { configId: "config_1" })).toEqual({
      page: "routing-config-detail",
      configId: "config_1"
    });
    expect(pageScopeFromMatch("/sessions/$sessionId", { sessionId: "session x" })).toEqual({
      page: "session-detail",
      sessionId: "session x"
    });
    expect(pageScopeFromMatch("/logs/$artifactId", { artifactId: "artifact_9" })).toEqual({
      page: "log-detail",
      artifactId: "artifact_9"
    });
  });

  it("maps list routes and ignores unknown route ids", () => {
    expect(pageScopeFromMatch("/usage", {})).toEqual({ page: "usage" });
    expect(pageScopeFromMatch("/login", {})).toBeUndefined();
    expect(pageScopeFromMatch("__root__", {})).toBeUndefined();
  });

  it("ignores non-string params", () => {
    expect(pageScopeFromMatch("/sessions/$sessionId", { sessionId: 42 })).toEqual({
      page: "session-detail"
    });
  });

  it("labels entity scopes for display", () => {
    expect(pageScopeLabel({ page: "session-detail", sessionId: "s1" })).toBe("sessionId s1");
    expect(pageScopeLabel({ page: "usage" })).toBeNull();
    expect(pageScopeLabel(undefined)).toBeNull();
  });
});
