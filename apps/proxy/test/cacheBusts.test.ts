import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  defaultWorkspaceId,
  providerAttempts,
  requests,
  routeDecisions,
  usageLedger,
  users
} from "@proxy/db";

import {
  cacheBustEvidenceByRequest,
  detectCacheBusts,
  type CacheBustCause,
  type CacheBustLedgerRow
} from "../src/persistence/cacheBusts.js";
import {
  adminGql,
  captureFixture,
  usageDecision,
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

  it.each([
    ["org_prompt_edit", { orgPromptHash: "sha256:org_v1" }, { orgPromptHash: "sha256:org_v2" }],
    ["tool_schema_churn", { toolSchemaHash: "sha256:tools_v1" }, { toolSchemaHash: "sha256:tools_v2" }],
    ["translator_change", { translatorId: null }, { translatorId: "openai-chat_to_anthropic-messages" }],
    ["compression_policy_change", { compressionPolicyHash: "sha256:policy_v1" }, { compressionPolicyHash: "sha256:policy_v2" }],
    ["logical_model_change", { logicalModelId: "logical_v1" }, { logicalModelId: "logical_v2" }]
  ] satisfies Array<[CacheBustCause, Partial<CacheBustLedgerRow>, Partial<CacheBustLedgerRow>]>)(
    "classifies %s ahead of TTL when both rows carry evidence",
    (cause, previousEvidence, currentEvidence) => {
      const report = detectCacheBusts([
        row({
          requestId: "r1",
          cachedInputTokens: 50_000,
          createdAt: new Date("2026-06-08T12:00:00Z"),
          ...previousEvidence
        }),
        row({
          requestId: "r2",
          cachedInputTokens: 0,
          cacheCreationInputTokens: 40_000,
          createdAt: new Date("2026-06-08T12:30:00Z"),
          ...currentEvidence
        })
      ]);
      expect(report.busts[0].cause).toBe(cause);
      expect(report.countsByCause[cause]).toBe(1);
    }
  );

  it("keeps unknown classification when operator-controlled evidence is incomplete", () => {
    const report = detectCacheBusts([
      row({
        requestId: "r1",
        cachedInputTokens: 50_000,
        createdAt: new Date("2026-06-08T12:00:00Z")
      }),
      row({
        requestId: "r2",
        cachedInputTokens: 0,
        cacheCreationInputTokens: 40_000,
        orgPromptHash: "sha256:org_v2",
        toolSchemaHash: "sha256:tools_v2",
        translatorId: "openai-chat_to_anthropic-messages",
        compressionPolicyHash: "sha256:policy_v2",
        logicalModelId: "logical_v2",
        createdAt: new Date("2026-06-08T12:01:00Z")
      })
    ]);

    expect(report.busts[0].cause).toBe("unknown");
  });
});

describe("cacheBustEvidenceByRequest", () => {
  it("derives request fingerprints from token attribution and compression events", () => {
    const evidence = cacheBustEvidenceByRequest([
      {
        requestId: "r1",
        eventType: "tokens.attributed",
        payload: {
          orgSystemPromptHash: "sha256:org_v1",
          toolSchemaHashesByName: [
            { name: "Read", schemaHash: "sha256:read_v1" },
            { name: "Bash", schemaHash: "sha256:bash_v1" }
          ]
        }
      },
      {
        requestId: "r2",
        eventType: "tokens.attributed",
        payload: {
          orgSystemPromptHash: "sha256:org_v2",
          toolSchemaHashesByName: [{ name: "Bash", schemaHash: "sha256:bash_v2" }]
        }
      },
      {
        requestId: "r2",
        eventType: "routing.compression_evidence_recorded",
        payload: { policy: { mode: "compress_lossless", enabledRules: ["json-whitespace"] } }
      }
    ]);

    expect(evidence.get("r1")).toMatchObject({
      orgPromptHash: "sha256:org_v1",
      toolSchemaHash: expect.stringMatching(/^sha256:/)
    });
    expect(evidence.get("r2")).toMatchObject({
      orgPromptHash: "sha256:org_v2",
      toolSchemaHash: expect.stringMatching(/^sha256:/),
      compressionPolicyHash: expect.stringMatching(/^sha256:/)
    });
    expect(evidence.get("r1")?.toolSchemaHash).not.toBe(evidence.get("r2")?.toolSchemaHash);
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
        ...usageRow("bust_usage_1", "bust_request_1", "bust_attempt_1", "org_cache_busts", "anthropic", "claude-hard", 100, 50, 1000),
        sessionId: "session_bust",
        cachedInputTokens: 60_000,
        createdAt: first
      },
      {
        ...usageRow("bust_usage_2", "bust_request_2", "bust_attempt_2", "org_cache_busts", "anthropic", "claude-hard", 200, 50, 1000),
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
        estimatedRecoverableCacheReadTokens
        recommendationThresholdTokens
        recommendedTtlUpgrade
        sampledRequests
        sampleWindowStart
        sampleWindowEnd
      } }`
    )).data?.idleGaps;

    expect(idleGaps.totalGaps).toBe(1);
    expect(idleGaps.overTtl).toBe(1);
    expect(idleGaps.recoverableByOneHourTtl).toBe(1);
    expect(idleGaps.estimatedRecoverableCacheReadTokens).toBe(55_000);
    expect(idleGaps.recommendationThresholdTokens).toBe(100_000);
    expect(idleGaps.recommendedTtlUpgrade).toBe(false);
    expect(idleGaps.sampledRequests).toBe(2);
    expect(idleGaps.sampleWindowStart).toBe("2026-06-08T12:00:00.000Z");
    expect(idleGaps.sampleWindowEnd).toBe("2026-06-08T12:10:00.000Z");
    const gapCounts = Object.fromEntries(idleGaps.buckets.map((bucket: any) => [bucket.key, bucket.count]));
    expect(gapCounts["5m_15m"]).toBe(1);
  });

  it("attributes logical model changes from gateway decision evidence", async () => {
    activeFixture = await captureFixture("org_logical_model_busts");
    const fixture = activeFixture;
    const organizationId = "org_logical_model_busts";
    const workspaceId = defaultWorkspaceId(organizationId);
    const first = new Date("2026-06-08T12:00:00.000Z");
    const second = new Date("2026-06-08T12:01:00.000Z");

    await fixture.db.insert(users).values([{ id: "user_route_bust", email: "route-bust@example.com", name: "Route Bust" }]);
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_route_bust",
        organizationId,
        workspaceId,
        userId: "user_route_bust",
        surface: "anthropic-messages",
        externalSessionId: "claude-route-bust",
        startedAt: first,
        updatedAt: second
      }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("route_bust_request_1", organizationId, "user_route_bust", "session_route_bust", "anthropic-messages", first),
      usageRequest("route_bust_request_2", organizationId, "user_route_bust", "session_route_bust", "anthropic-messages", second)
    ]);
    await fixture.db.insert(routeDecisions).values([
      {
        ...usageDecision("route_bust_decision_1", "route_bust_request_1", organizationId, "anthropic-messages", "anthropic", "claude-haiku-4-5"),
        requestedModel: "economy-auto",
        requestedLogicalModel: "economy-auto",
        resolvedLogicalModelId: `${workspaceId}:logical-model:economy-auto`,
        accessProfileId: `${workspaceId}:access-profile:opendoor-engineer`,
        routerKind: "classifier",
        deploymentId: `${workspaceId}:deployment:anthropic:claude-haiku-4-5`,
        providerConnectionId: `${workspaceId}:connection:anthropic`,
        egressWireId: "anthropic-messages",
        wireAdapterVersion: "1"
      },
      {
        ...usageDecision("route_bust_decision_2", "route_bust_request_2", organizationId, "anthropic-messages", "anthropic", "claude-haiku-4-5"),
        resolvedLogicalModelId: `${workspaceId}:logical-model:coding-auto`,
        accessProfileId: `${workspaceId}:access-profile:opendoor-engineer`,
        routerKind: "classifier",
        deploymentId: `${workspaceId}:deployment:anthropic:claude-haiku-4-5`,
        providerConnectionId: `${workspaceId}:connection:anthropic`,
        egressWireId: "anthropic-messages",
        wireAdapterVersion: "1"
      }
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("route_bust_attempt_1", "route_bust_request_1", organizationId, "anthropic-messages", "anthropic", "claude-haiku-4-5", "completed", first),
      usageAttempt("route_bust_attempt_2", "route_bust_request_2", organizationId, "anthropic-messages", "anthropic", "claude-haiku-4-5", "completed", second)
    ]);
    await fixture.db.insert(usageLedger).values([
      {
        ...usageRow("route_bust_usage_1", "route_bust_request_1", "route_bust_attempt_1", organizationId, "anthropic", "claude-haiku-4-5", 100, 50, 1000),
        sessionId: "session_route_bust",
        cachedInputTokens: 60_000,
        createdAt: first
      },
      {
        ...usageRow("route_bust_usage_2", "route_bust_request_2", "route_bust_attempt_2", organizationId, "anthropic", "claude-haiku-4-5", 200, 50, 1000),
        sessionId: "session_route_bust",
        cachedInputTokens: 0,
        cacheCreationInputTokens: 55_000,
        createdAt: second
      }
    ]);

    const report = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { cacheBusts {
        busts { requestId cause gapMs }
        countsByCause
      } }`
    )).data?.cacheBusts;

    expect(report.busts).toHaveLength(1);
    expect(report.busts[0]).toMatchObject({
      requestId: "route_bust_request_2",
      cause: "logical_model_change",
      gapMs: 60_000
    });
    expect(report.countsByCause.logical_model_change).toBe(1);
    expect(report.countsByCause.ttl_expiry).toBe(0);
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

  it("keeps the 5m warm window when cacheTtlUpgrade has no recent recoverable gap", async () => {
    activeFixture = await captureFixture("org_active_1h_no_gap");
    const fixture = activeFixture;
    await fixture.persistence.organizationSettings.setCacheTtlUpgrade("org_active_1h_no_gap", true);
    const now = new Date();
    const within1h = new Date(now.getTime() - 30 * 60 * 1000); // 30m ago — cold at 5m, warm at 1h
    const staleGapStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const staleGapEnd = new Date(staleGapStart.getTime() + 30 * 60 * 1000);

    await fixture.db.insert(users).values([{ id: "user_1h", email: "h@example.com", name: "H" }]);
    await fixture.db.insert(agentSessions).values([
      { id: "session_30m", organizationId: "org_active_1h_no_gap", workspaceId: defaultWorkspaceId("org_active_1h_no_gap"), userId: "user_1h", surface: "anthropic-messages", externalSessionId: "s30", startedAt: within1h, updatedAt: within1h },
      { id: "session_old_gap", organizationId: "org_active_1h_no_gap", workspaceId: defaultWorkspaceId("org_active_1h_no_gap"), userId: "user_1h", surface: "anthropic-messages", externalSessionId: "old-gap", startedAt: staleGapStart, updatedAt: staleGapEnd }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("req_30m", "org_active_1h_no_gap", "user_1h", "session_30m", "anthropic-messages", within1h),
      usageRequest("req_old_gap_1", "org_active_1h_no_gap", "user_1h", "session_old_gap", "anthropic-messages", staleGapStart),
      usageRequest("req_old_gap_2", "org_active_1h_no_gap", "user_1h", "session_old_gap", "anthropic-messages", staleGapEnd)
    ]);

    const result = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { activeSessionCount { activeSessions windowMs } }`
    )).data?.activeSessionCount;

    expect(result.activeSessions).toBe(0);
    expect(result.windowMs).toBe(5 * 60 * 1000);
  });

  it("widens the warm window to 1h when cacheTtlUpgrade has observed recoverable gaps", async () => {
    activeFixture = await captureFixture("org_active_1h");
    const fixture = activeFixture;
    await fixture.persistence.organizationSettings.setCacheTtlUpgrade("org_active_1h", true);
    const now = new Date();
    const earlier = new Date(now.getTime() - 31 * 60 * 1000);
    const recent = new Date(now.getTime() - 60 * 1000);

    await fixture.db.insert(users).values([{ id: "user_1h", email: "h@example.com", name: "H" }]);
    await fixture.db.insert(agentSessions).values([
      { id: "session_30m", organizationId: "org_active_1h", workspaceId: defaultWorkspaceId("org_active_1h"), userId: "user_1h", surface: "anthropic-messages", externalSessionId: "s30", startedAt: earlier, updatedAt: recent }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("req_30m_1", "org_active_1h", "user_1h", "session_30m", "anthropic-messages", earlier),
      usageRequest("req_30m_2", "org_active_1h", "user_1h", "session_30m", "anthropic-messages", recent)
    ]);
    await fixture.db.insert(providerAttempts).values([
      usageAttempt("att_30m_1", "req_30m_1", "org_active_1h", "anthropic-messages", "anthropic", "claude-hard", "completed", earlier),
      usageAttempt("att_30m_2", "req_30m_2", "org_active_1h", "anthropic-messages", "anthropic", "claude-hard", "completed", recent)
    ]);
    await fixture.db.insert(usageLedger).values([
      {
        ...usageRow("use_30m_1", "req_30m_1", "att_30m_1", "org_active_1h", "anthropic", "claude-hard", 60_000, 100, 1000),
        userId: "user_1h",
        sessionId: "session_30m",
        cachedInputTokens: 55_000,
        createdAt: earlier
      },
      {
        ...usageRow("use_30m_2", "req_30m_2", "att_30m_2", "org_active_1h", "anthropic", "claude-hard", 60_000, 100, 1000),
        userId: "user_1h",
        sessionId: "session_30m",
        cachedInputTokens: 0,
        cacheCreationInputTokens: 55_000,
        createdAt: recent
      }
    ]);

    const result = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { activeSessionCount { activeSessions windowMs } }`
    )).data?.activeSessionCount;

    expect(result.activeSessions).toBe(1);
    expect(result.windowMs).toBe(60 * 60 * 1000);
  });

});
