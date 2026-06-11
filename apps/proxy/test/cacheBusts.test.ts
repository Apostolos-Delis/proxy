import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  defaultWorkspaceId,
  providerAttempts,
  requests,
  usageLedger,
  users
} from "@prompt-proxy/db";

import { detectCacheBusts, type CacheBustLedgerRow } from "../src/persistence/cacheBusts.js";
import {
  adminGql,
  captureFixture,
  usageAttempt,
  usageRequest,
  usageRow,
  type PromptTestFixture
} from "./promptTestFixture.js";

function row(overrides: Partial<CacheBustLedgerRow>): CacheBustLedgerRow {
  return {
    sessionId: "session_1",
    requestId: "request_1",
    provider: "anthropic",
    model: "claude-hard",
    inputTokens: 500,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    createdAt: new Date("2026-06-08T12:00:00.000Z"),
    ...overrides
  };
}

describe("detectCacheBusts", () => {
  it("flags a TTL expiry when reads collapse after a long gap and the context re-bills", () => {
    const report = detectCacheBusts([
      row({ requestId: "r1", cachedInputTokens: 50_000, createdAt: new Date("2026-06-08T12:00:00Z") }),
      row({
        requestId: "r2",
        cachedInputTokens: 0,
        cacheCreationInputTokens: 40_000,
        createdAt: new Date("2026-06-08T12:10:00Z")
      })
    ]);

    expect(report.busts).toHaveLength(1);
    expect(report.busts[0]).toMatchObject({
      requestId: "r2",
      cause: "ttl_expiry",
      droppedCacheReadTokens: 50_000,
      rebuiltTokens: 40_000,
      gapMs: 600_000
    });
    expect(report.countsByCause.ttl_expiry).toBe(1);
    expect(report.sessionsScanned).toBe(1);
  });

  it("classifies model and provider switches ahead of TTL", () => {
    const report = detectCacheBusts([
      row({ requestId: "r1", cachedInputTokens: 50_000, createdAt: new Date("2026-06-08T12:00:00Z") }),
      row({
        requestId: "r2",
        model: "claude-deep",
        cachedInputTokens: 0,
        cacheCreationInputTokens: 40_000,
        createdAt: new Date("2026-06-08T12:30:00Z")
      })
    ]);
    expect(report.busts[0].cause).toBe("model_switch");
  });

  it("does not flag warm continuations or small sidecar requests", () => {
    const report = detectCacheBusts([
      row({ requestId: "r1", cachedInputTokens: 50_000, createdAt: new Date("2026-06-08T12:00:00Z") }),
      row({
        requestId: "r2",
        cachedInputTokens: 48_000,
        cacheCreationInputTokens: 3_000,
        createdAt: new Date("2026-06-08T12:01:00Z")
      }),
      row({
        requestId: "r3",
        cachedInputTokens: 0,
        cacheCreationInputTokens: 1_000,
        createdAt: new Date("2026-06-08T12:02:00Z")
      })
    ]);
    expect(report.busts).toHaveLength(0);
  });

  it("keeps only the latest ledger row per request so retries cannot read as busts", () => {
    const report = detectCacheBusts([
      row({ requestId: "r1", cachedInputTokens: 50_000, createdAt: new Date("2026-06-08T12:00:00Z") }),
      // Failed first attempt of r2: no cache read recorded.
      row({
        requestId: "r2",
        cachedInputTokens: 0,
        cacheCreationInputTokens: 40_000,
        createdAt: new Date("2026-06-08T12:01:00Z")
      }),
      // Successful retry of r2 ~2s later with warm reads.
      row({
        requestId: "r2",
        cachedInputTokens: 49_000,
        cacheCreationInputTokens: 2_000,
        createdAt: new Date("2026-06-08T12:01:02Z")
      })
    ]);
    expect(report.busts).toHaveLength(0);
  });

  it("uses uncached input as the rebuild signal on OpenAI", () => {
    const report = detectCacheBusts([
      row({
        requestId: "r1",
        provider: "openai",
        model: "gpt-hard",
        inputTokens: 100_000,
        cachedInputTokens: 90_000,
        createdAt: new Date("2026-06-08T12:00:00Z")
      }),
      row({
        requestId: "r2",
        provider: "openai",
        model: "gpt-hard",
        inputTokens: 100_000,
        cachedInputTokens: 0,
        createdAt: new Date("2026-06-08T12:01:00Z")
      })
    ]);
    expect(report.busts).toHaveLength(1);
    expect(report.busts[0].cause).toBe("unknown");
    expect(report.busts[0].rebuiltTokens).toBe(100_000);
  });
});

describe("cacheBusts admin query", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("detects busts from org-scoped ledger rows", async () => {
    activeFixture = await captureFixture("org_cache_busts");
    const fixture = activeFixture;
    const first = new Date("2026-06-08T12:00:00.000Z");
    const second = new Date("2026-06-08T12:10:00.000Z");

    await fixture.db.insert(users).values([{ id: "user_bust", email: "bust@example.com", name: "Bust" }]);
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_bust",
        organizationId: "org_cache_busts",
        workspaceId: defaultWorkspaceId("org_cache_busts"),
        userId: "user_bust",
        surface: "anthropic-messages",
        externalSessionId: "claude-bust",
        startedAt: first,
        updatedAt: second
      }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("bust_request_1", "org_cache_busts", "user_bust", "session_bust", "anthropic-messages", first),
      usageRequest("bust_request_2", "org_cache_busts", "user_bust", "session_bust", "anthropic-messages", second)
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("bust_attempt_1", "bust_request_1", "org_cache_busts", "anthropic-messages", "anthropic", "claude-hard", "completed", first),
      usageAttempt("bust_attempt_2", "bust_request_2", "org_cache_busts", "anthropic-messages", "anthropic", "claude-hard", "completed", second)
    ]);
    await fixture.db.insert(usageLedger).values([
      {
        ...usageRow("bust_usage_1", "bust_request_1", "bust_attempt_1", "org_cache_busts", "anthropic", "claude-hard", "hard", 100, 50, 1000),
        sessionId: "session_bust",
        cachedInputTokens: 60_000,
        createdAt: first
      },
      {
        ...usageRow("bust_usage_2", "bust_request_2", "bust_attempt_2", "org_cache_busts", "anthropic", "claude-hard", "hard", 200, 50, 1000),
        sessionId: "session_bust",
        cachedInputTokens: 0,
        cacheCreationInputTokens: 55_000,
        createdAt: second
      }
    ]);

    const report = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { cacheBusts {
        busts { sessionId requestId cause droppedCacheReadTokens rebuiltTokens gapMs }
        countsByCause
        sessionsScanned
        sampled
      } }`
    )).data?.cacheBusts;

    expect(report.busts).toHaveLength(1);
    expect(report.busts[0]).toMatchObject({
      sessionId: "session_bust",
      requestId: "bust_request_2",
      cause: "ttl_expiry",
      droppedCacheReadTokens: 60_000,
      rebuiltTokens: 55_000
    });
    expect(report.countsByCause.ttl_expiry).toBe(1);
    expect(report.sampled).toBe(false);

    const idleGaps = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { idleGaps {
        buckets { key count }
        totalGaps
        overTtl
        recoverableByOneHourTtl
      } }`
    )).data?.idleGaps;

    expect(idleGaps.totalGaps).toBe(1);
    expect(idleGaps.overTtl).toBe(1);
    expect(idleGaps.recoverableByOneHourTtl).toBe(1);
    const gapCounts = Object.fromEntries(idleGaps.buckets.map((bucket: any) => [bucket.key, bucket.count]));
    expect(gapCounts["5m_15m"]).toBe(1);
  });

  it("counts sessions active within the cache-warm window for the blast-radius warning", async () => {
    activeFixture = await captureFixture("org_active_sessions");
    const fixture = activeFixture;
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 1000); // 1m ago — warm
    const stale = new Date(now.getTime() - 30 * 60 * 1000); // 30m ago — cold

    await fixture.db.insert(users).values([{ id: "user_active", email: "active@example.com", name: "Active" }]);
    await fixture.db.insert(agentSessions).values([
      { id: "session_warm", organizationId: "org_active_sessions", workspaceId: defaultWorkspaceId("org_active_sessions"), userId: "user_active", surface: "anthropic-messages", externalSessionId: "warm", startedAt: recent, updatedAt: recent },
      { id: "session_cold", organizationId: "org_active_sessions", workspaceId: defaultWorkspaceId("org_active_sessions"), userId: "user_active", surface: "anthropic-messages", externalSessionId: "cold", startedAt: stale, updatedAt: stale }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("active_req_warm", "org_active_sessions", "user_active", "session_warm", "anthropic-messages", recent),
      usageRequest("active_req_cold", "org_active_sessions", "user_active", "session_cold", "anthropic-messages", stale)
    ]);

    const result = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { activeSessionCount { activeSessions windowMs } }`
    )).data?.activeSessionCount;

    expect(result.activeSessions).toBe(1);
    expect(result.windowMs).toBe(5 * 60 * 1000);
  });

  it("widens the warm window to 1h when cacheTtlUpgrade is enabled", async () => {
    activeFixture = await captureFixture("org_active_1h");
    const fixture = activeFixture;
    await fixture.persistence.organizationSettings.setCacheTtlUpgrade("org_active_1h", true);
    const now = new Date();
    const within1h = new Date(now.getTime() - 30 * 60 * 1000); // 30m ago — cold at 5m, warm at 1h

    await fixture.db.insert(users).values([{ id: "user_1h", email: "h@example.com", name: "H" }]);
    await fixture.db.insert(agentSessions).values([
      { id: "session_30m", organizationId: "org_active_1h", workspaceId: defaultWorkspaceId("org_active_1h"), userId: "user_1h", surface: "anthropic-messages", externalSessionId: "s30", startedAt: within1h, updatedAt: within1h }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("req_30m", "org_active_1h", "user_1h", "session_30m", "anthropic-messages", within1h)
    ]);

    const result = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { activeSessionCount { activeSessions windowMs } }`
    )).data?.activeSessionCount;

    expect(result.activeSessions).toBe(1);
    expect(result.windowMs).toBe(60 * 60 * 1000);
  });

  it("reports output tokens and reasoning share per route", async () => {
    activeFixture = await captureFixture("org_route_output");
    const fixture = activeFixture;
    const at = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(users).values([{ id: "user_ro", email: "ro@example.com", name: "RO" }]);
    await fixture.db.insert(agentSessions).values([
      { id: "ro_session", organizationId: "org_route_output", workspaceId: defaultWorkspaceId("org_route_output"), userId: "user_ro", surface: "anthropic-messages", externalSessionId: "ro", startedAt: at, updatedAt: at }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("ro_req_fast", "org_route_output", "user_ro", "ro_session", "anthropic-messages", at),
      usageRequest("ro_req_deep", "org_route_output", "user_ro", "ro_session", "anthropic-messages", at)
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("ro_att_fast", "ro_req_fast", "org_route_output", "anthropic-messages", "anthropic", "claude-fast", "completed", at),
      usageAttempt("ro_att_deep", "ro_req_deep", "org_route_output", "anthropic-messages", "anthropic", "claude-deep", "completed", at)
    ]);
    await fixture.db.insert(usageLedger).values([
      { ...usageRow("ro_use_fast", "ro_req_fast", "ro_att_fast", "org_route_output", "anthropic", "claude-fast", "fast", 100, 200, 1000), reasoningTokens: 0 },
      { ...usageRow("ro_use_deep", "ro_req_deep", "ro_att_deep", "org_route_output", "anthropic", "claude-deep", "hard", 100, 1000, 5000), route: "deep", reasoningTokens: 400 }
    ]);

    const report = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { routeOutputReport { routes { route requests outputTokens avgOutputTokens reasoningShare } } }`
    )).data?.routeOutputReport;

    const byRoute = Object.fromEntries(report.routes.map((row: any) => [row.route, row]));
    expect(byRoute.fast.avgOutputTokens).toBe(200);
    expect(byRoute.fast.reasoningShare).toBe(0);
    expect(byRoute.deep.avgOutputTokens).toBe(1000);
    expect(byRoute.deep.reasoningShare).toBeCloseTo(0.4, 5);
    // Sorted fast < deep by route rank.
    expect(report.routes[0].route).toBe("fast");
  });
});
