import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  apiKeys,
  createPgliteDatabase,
  events,
  hashApiKey,
  organizations,
  providerAttempts,
  requests,
  routeDecisions,
  organizationSettings,
  routingConfigs,
  routingConfigVersions,
  usageLedger
} from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";

import { buildModelCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { EventService } from "../src/events.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import type { RouteContext } from "../src/types.js";

describe("postgres persistence", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("keeps the canonical request id for duplicate idempotency after restart", async () => {
    const fixture = await persistenceFixture("org_a");
    const context = routeContext();
    const first = await fixture.persistence.requestStates.begin("idem_1", "request_first", context);
    await fixture.persistence.requestStates.finish("idem_1", "completed");

    const restarted = createDatabasePersistence(fixture.db, fixture.catalog, fixture.config, false);
    const duplicate = await restarted.requestStates.begin("idem_1", "request_second", context);

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.state.requestId).toBe("request_first");
    expect(duplicate.state.status).toBe("completed");
  });

  it("does not mirror events when durable append fails", async () => {
    const eventService = new EventService(undefined, undefined, {
      append: async () => {
        throw new Error("db_failed");
      }
    }, "org_fail");

    await expect(eventService.append({
      scopeType: "request",
      scopeId: "request_fail",
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "openai-responses",
        requestedModel: "router-auto",
        inputHash: "sha256:input",
        inputChars: 1
      }
    })).rejects.toThrow("db_failed");

    expect(eventService.listEvents()).toEqual([]);
    expect(eventService.listOutbox()).toEqual([]);
  });

  it("persists request lifecycle rows and usage cost from events", async () => {
    const fixture = await persistenceFixture("org_cost");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_cost");

    await eventService.append({
      scopeType: "request",
      scopeId: "request_cost",
      correlationId: "request_cost",
      idempotencyKey: "idem_cost",
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "openai-responses",
        requestedModel: "router-auto",
        inputHash: "sha256:input",
        inputChars: 400
      }
    });
    await eventService.append({
      scopeType: "request",
      scopeId: "request_cost",
      correlationId: "request_cost",
      idempotencyKey: "idem_cost",
      producer: "test",
      eventType: "routing.context_built",
      payload: {
        surface: "openai-responses",
        requestedModel: "router-auto",
        inputHash: "sha256:input",
        inputChars: 400,
        estimatedInputTokens: 100,
        routingInputHash: "sha256:routing",
        routingInputChars: 200,
        routingEstimatedInputTokens: 50,
        routingConfig: {
          configId: "routing_config_test",
          configName: "Test routing config",
          versionId: "routing_config_test:v3",
          version: 3,
          configHash: "sha256:routing-config-test"
        }
      }
    });
    await eventService.append({
      scopeType: "request",
      scopeId: "request_cost",
      correlationId: "request_cost",
      idempotencyKey: "idem_cost",
      producer: "test",
      eventType: "routing.decision_recorded",
      payload: {
        outcome: "route",
        surface: "openai-responses",
        requestedModel: "router-auto",
        finalRoute: "hard",
        selectedModel: "gpt-routed-hard-test",
        provider: "openai",
        reasoningEffort: "high",
        verbosity: "medium",
        guardrailActions: [],
        reasonCodes: ["test"],
        classifier: { confidence: 0.8 },
        routingConfig: {
          configId: "routing_config_test",
          configName: "Test routing config",
          versionId: "routing_config_test:v3",
          version: 3,
          configHash: "sha256:routing-config-test"
        },
        policyVersion: "test"
      }
    });
    await eventService.append({
      scopeType: "request",
      scopeId: "request_cost",
      correlationId: "request_cost",
      idempotencyKey: "idem_cost",
      producer: "test",
      eventType: "provider.request_started",
      payload: {
        surface: "openai-responses",
        provider: "openai",
        model: "gpt-routed-hard-test",
        providerAttemptId: "attempt_cost"
      }
    });
    await eventService.append({
      scopeType: "request",
      scopeId: "request_cost",
      correlationId: "request_cost",
      idempotencyKey: "idem_cost",
      producer: "test",
      eventType: "provider.response_completed",
      payload: {
        surface: "openai-responses",
        provider: "openai",
        selectedModel: "gpt-routed-hard-test",
        providerAttemptId: "attempt_cost",
        upstreamStatus: 200,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120
        }
      }
    });

    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_cost"));
    const decisionRows = await fixture.db.select().from(routeDecisions).where(eq(routeDecisions.requestId, "request_cost"));
    const attemptRows = await fixture.db.select().from(providerAttempts).where(eq(providerAttempts.id, "attempt_cost"));
    const usageRows = await fixture.db.select().from(usageLedger).where(eq(usageLedger.providerAttemptId, "attempt_cost"));
    const eventRows = await fixture.db.select().from(events).where(eq(events.scopeId, "request_cost"));

    expect(requestRows[0]?.status).toBe("completed");
    expect(requestRows[0]?.routingConfigId).toBe("routing_config_test");
    expect(requestRows[0]?.routingConfigVersionId).toBe("routing_config_test:v3");
    expect(requestRows[0]?.routingConfigVersion).toBe(3);
    expect(requestRows[0]?.routingConfigHash).toBe("sha256:routing-config-test");
    expect(decisionRows[0]?.finalRoute).toBe("hard");
    expect(decisionRows[0]?.routingConfigId).toBe("routing_config_test");
    expect(decisionRows[0]?.routingConfigVersionId).toBe("routing_config_test:v3");
    expect(decisionRows[0]?.routingConfigVersion).toBe(3);
    expect(decisionRows[0]?.routingConfigHash).toBe("sha256:routing-config-test");
    expect(attemptRows[0]?.terminalStatus).toBe("completed");
    expect(usageRows[0]?.totalTokens).toBe(120);
    expect(usageRows[0]?.totalCostMicros).toBe(400);
    expect(eventRows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("persists cancelled provider terminal status from events", async () => {
    const fixture = await persistenceFixture("org_cancel");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_cancel");

    await eventService.append({
      scopeType: "request",
      scopeId: "request_cancel",
      correlationId: "request_cancel",
      idempotencyKey: "idem_cancel",
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "openai-responses",
        requestedModel: "router-auto",
        inputHash: "sha256:input",
        inputChars: 400
      }
    });
    await eventService.append({
      scopeType: "request",
      scopeId: "request_cancel",
      correlationId: "request_cancel",
      idempotencyKey: "idem_cancel",
      producer: "test",
      eventType: "provider.request_started",
      payload: {
        surface: "openai-responses",
        provider: "openai",
        model: "gpt-routed-hard-test",
        providerAttemptId: "attempt_cancel"
      }
    });
    await eventService.append({
      scopeType: "request",
      scopeId: "request_cancel",
      correlationId: "request_cancel",
      idempotencyKey: "idem_cancel",
      producer: "test",
      eventType: "provider.response_cancelled",
      payload: {
        surface: "openai-responses",
        provider: "openai",
        selectedModel: "gpt-routed-hard-test",
        providerAttemptId: "attempt_cancel",
        terminalStatus: "cancelled",
        upstreamStatus: 0,
        usage: null,
        error: "client_closed"
      }
    });

    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_cancel"));
    const attemptRows = await fixture.db.select().from(providerAttempts).where(eq(providerAttempts.id, "attempt_cancel"));

    expect(requestRows[0]?.status).toBe("cancelled");
    expect(attemptRows[0]?.terminalStatus).toBe("cancelled");
    expect(attemptRows[0]?.error).toBe("client_closed");
  });

  it("keeps provider terminal state owned by terminal event projection", async () => {
    const fixture = await persistenceFixture("org_terminal_owner");
    await fixture.persistence.requestStates.begin("idem_terminal", "request_terminal", routeContext());
    await fixture.persistence.requestStates.markProviderPending("idem_terminal", "attempt_terminal");
    await fixture.persistence.requestStates.finish("idem_terminal", "completed", {
      providerAttemptId: "attempt_terminal"
    });

    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_terminal"));

    expect(requestRows[0]?.status).toBe("provider_pending");
  });

  it("resolves active api keys by hash and records last use", async () => {
    const fixture = await persistenceFixture("org_api_key");
    await fixture.db.insert(organizations).values({
      id: "org_api_key",
      slug: "org_api_key",
      name: "org_api_key"
    }).onConflictDoNothing();
    await fixture.db.insert(apiKeys).values({
      id: "api_key_1",
      organizationId: "org_api_key",
      keyHash: hashApiKey("secret-token"),
      name: "Local Proxy Key",
      scopes: ["proxy"]
    });

    const identity = await fixture.persistence.apiKeys.resolve("secret-token", new Date("2026-06-08T00:00:00.000Z"));
    const rows = await fixture.db.select().from(apiKeys).where(eq(apiKeys.id, "api_key_1"));

    expect(identity).toEqual({
      apiKeyId: "api_key_1",
      organizationId: "org_api_key",
      userId: undefined,
      scopes: ["proxy"],
      routingConfigId: null
    });
    expect(rows[0]?.lastUsedAt?.toISOString()).toBe("2026-06-08T00:00:00.000Z");
    await expect(fixture.persistence.apiKeys.resolve("wrong-token")).resolves.toBeUndefined();
  });

  it("resolves api key routing config assignments", async () => {
    const fixture = await persistenceFixture("org_assigned_api_key");
    await fixture.db.insert(organizations).values({
      id: "org_assigned_api_key",
      slug: "org_assigned_api_key",
      name: "org_assigned_api_key"
    }).onConflictDoNothing();
    await fixture.db.insert(routingConfigs).values({
      id: "routing_config_assigned",
      organizationId: "org_assigned_api_key",
      name: "Assigned config",
      slug: "assigned",
      status: "active"
    });
    await fixture.db.insert(apiKeys).values({
      id: "api_key_assigned",
      organizationId: "org_assigned_api_key",
      keyHash: hashApiKey("assigned-token"),
      name: "Assigned Proxy Key",
      routingConfigId: "routing_config_assigned",
      scopes: ["proxy"]
    });

    const identity = await fixture.persistence.apiKeys.resolve("assigned-token");

    expect(identity).toEqual(expect.objectContaining({
      apiKeyId: "api_key_assigned",
      organizationId: "org_assigned_api_key",
      routingConfigId: "routing_config_assigned"
    }));
  });

  it("resolves the seeded local proxy token through the API-key identity store", async () => {
    const fixture = await persistenceFixture("org_seed_identity");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_seed_identity",
      SEED_USER_ID: "seed_identity_user",
      PROMPT_PROXY_TOKEN: "seeded-secret-token"
    }));

    const identity = await fixture.persistence.apiKeys.resolve("seeded-secret-token");

    expect(identity).toEqual(expect.objectContaining({
      apiKeyId: "org_seed_identity:api-key:default",
      organizationId: "org_seed_identity",
      userId: undefined,
      scopes: ["proxy", "admin", "harness_identity"],
      routingConfigId: "org_seed_identity:routing-config:default"
    }));
  });

  it("resolves routing configs by API key assignment before org defaults", async () => {
    const fixture = await persistenceFixture("org_assigned_config");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_assigned_config",
      SEED_USER_ID: "seed_config_user",
      PROMPT_PROXY_TOKEN: "seeded-config-token"
    }));
    const defaultVersion = await activeVersion(fixture, "org_assigned_config:routing-config:default:v1");
    const assignedConfigId = "org_assigned_config:routing-config:assigned";
    const assignedVersionId = `${assignedConfigId}:v1`;
    const assignedConfig = {
      ...defaultVersion.config,
      displayName: "Assigned coding router"
    };

    await fixture.db.insert(routingConfigs).values({
      id: assignedConfigId,
      organizationId: "org_assigned_config",
      name: "Assigned routing config",
      slug: "assigned",
      status: "active"
    });
    await fixture.db.insert(routingConfigVersions).values({
      id: assignedVersionId,
      organizationId: "org_assigned_config",
      routingConfigId: assignedConfigId,
      version: 1,
      configHash: "sha256:assigned-config",
      config: assignedConfig,
      status: "active",
      createdByUserId: "seed_config_user",
      activatedAt: new Date("2026-06-08T00:00:00.000Z")
    });
    await fixture.db
      .update(routingConfigs)
      .set({ activeVersionId: assignedVersionId })
      .where(eq(routingConfigs.id, assignedConfigId));

    const resolved = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_assigned_config",
      routingConfigId: assignedConfigId
    });

    expect(resolved).toEqual(expect.objectContaining({
      configId: assignedConfigId,
      configName: "Assigned routing config",
      versionId: assignedVersionId,
      version: 1,
      configHash: "sha256:assigned-config"
    }));
    expect(resolved.config.displayName).toBe("Assigned coding router");
  });

  it("falls back from org default to seeded routing config ids", async () => {
    const fixture = await persistenceFixture("org_default_config");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_default_config",
      SEED_USER_ID: "seed_default_config_user",
      PROMPT_PROXY_TOKEN: "seeded-default-config-token"
    }));

    const orgDefault = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_default_config",
      routingConfigId: null
    });

    await fixture.db
      .update(organizationSettings)
      .set({ defaultRoutingConfigId: null })
      .where(eq(organizationSettings.organizationId, "org_default_config"));
    const seededDefault = await fixture.persistence.routingConfigs.resolve({
      organizationId: "org_default_config",
      routingConfigId: null
    });

    expect(orgDefault.configId).toBe("org_default_config:routing-config:default");
    expect(seededDefault.configId).toBe("org_default_config:routing-config:default");
    expect(seededDefault.versionId).toBe("org_default_config:routing-config:default:v1");
  });

  it("fails closed when the active routing config version is missing", async () => {
    const fixture = await persistenceFixture("org_missing_active_config");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_missing_active_config",
      SEED_USER_ID: "seed_missing_active_user",
      PROMPT_PROXY_TOKEN: "seeded-missing-active-token"
    }));
    await fixture.db
      .update(routingConfigs)
      .set({ activeVersionId: null })
      .where(eq(routingConfigs.id, "org_missing_active_config:routing-config:default"));

    await expect(fixture.persistence.routingConfigs.resolve({
      organizationId: "org_missing_active_config",
      routingConfigId: null
    })).rejects.toThrow("routing_config_active_version_missing");
  });

  it("fails closed when active routing config JSON is invalid", async () => {
    const fixture = await persistenceFixture("org_invalid_config");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_invalid_config",
      SEED_USER_ID: "seed_invalid_config_user",
      PROMPT_PROXY_TOKEN: "seeded-invalid-config-token"
    }));
    await fixture.db
      .update(routingConfigVersions)
      .set({ config: { schemaVersion: 1 } as never })
      .where(eq(routingConfigVersions.id, "org_invalid_config:routing-config:default:v1"));

    await expect(fixture.persistence.routingConfigs.resolve({
      organizationId: "org_invalid_config",
      routingConfigId: null
    })).rejects.toThrow(/routing_config_invalid/);
  });

  it("uses route context organization for request idempotency", async () => {
    const fixture = await persistenceFixture("org_default");
    const first = await fixture.persistence.requestStates.begin("idem_shared", "request_a", {
      ...routeContext(),
      organizationId: "org_a"
    });
    const second = await fixture.persistence.requestStates.begin("idem_shared", "request_b", {
      ...routeContext(),
      organizationId: "org_b"
    });

    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_b"));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(requestRows[0]?.organizationId).toBe("org_b");
  });

  it("normalizes Codex and Claude Code session ids into durable sessions", async () => {
    const fixture = await persistenceFixture("org_sessions");
    await fixture.persistence.requestStates.begin("idem_codex", "request_codex", {
      ...routeContext(),
      organizationId: "org_sessions",
      surface: "openai-responses",
      sessionId: "codex-session",
      userId: "user_codex"
    });
    await fixture.persistence.requestStates.begin("idem_claude", "request_claude", {
      ...routeContext(),
      organizationId: "org_sessions",
      surface: "anthropic-messages",
      sessionId: "claude-session",
      userId: "user_claude"
    });

    const rows = await fixture.db.select().from(agentSessions);
    const requestRows = await fixture.db.select().from(requests);

    expect(rows.map((row) => ({
      id: row.id,
      externalSessionId: row.externalSessionId,
      metadata: row.metadata
    }))).toEqual(expect.arrayContaining([
      {
        id: "org_sessions:openai-responses:codex-session",
        externalSessionId: "codex-session",
        metadata: { sessionIdentity: "harness" }
      },
      {
        id: "org_sessions:anthropic-messages:claude-session",
        externalSessionId: "claude-session",
        metadata: { sessionIdentity: "harness" }
      }
    ]));
    expect(requestRows.find((row) => row.id === "request_codex")?.sessionId)
      .toBe("org_sessions:openai-responses:codex-session");
    expect(requestRows.find((row) => row.id === "request_claude")?.sessionId)
      .toBe("org_sessions:anthropic-messages:claude-session");
  });

  it("creates request-scoped fallback sessions when harness session identity is absent", async () => {
    const fixture = await persistenceFixture("org_fallback_session");
    await fixture.persistence.requestStates.begin("idem_fallback", "request_fallback", {
      ...routeContext(),
      organizationId: "org_fallback_session",
      sessionId: undefined
    });

    const rows = await fixture.db.select().from(agentSessions);
    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_fallback"));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("org_fallback_session:openai-responses:request:request_fallback");
    expect(rows[0]?.externalSessionId).toBe("request:request_fallback");
    expect(rows[0]?.metadata).toEqual({ sessionIdentity: "request_fallback" });
    expect(requestRows[0]?.sessionId).toBe(rows[0]?.id);
  });

  it("projects request-scoped fallback sessions from request events", async () => {
    const fixture = await persistenceFixture("org_event_fallback");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_event_fallback");

    await eventService.append({
      scopeType: "request",
      scopeId: "request_event_fallback",
      correlationId: "request_event_fallback",
      idempotencyKey: "idem_event_fallback",
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "anthropic-messages",
        requestedModel: "claude-router-auto",
        inputHash: "sha256:event-fallback",
        inputChars: 12
      }
    });

    const rows = await fixture.db.select().from(agentSessions);
    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_event_fallback"));

    expect(rows[0]?.id).toBe("org_event_fallback:anthropic-messages:request:request_event_fallback");
    expect(rows[0]?.metadata).toEqual({ sessionIdentity: "request_fallback" });
    expect(requestRows[0]?.sessionId).toBe(rows[0]?.id);
  });

  it("keeps identical external session ids separate by organization and surface", async () => {
    const fixture = await persistenceFixture("org_scope_default");
    await fixture.persistence.requestStates.begin("idem_org_a", "request_org_a", {
      ...routeContext(),
      organizationId: "org_a",
      surface: "openai-responses",
      sessionId: "shared-session"
    });
    await fixture.persistence.requestStates.begin("idem_org_b", "request_org_b", {
      ...routeContext(),
      organizationId: "org_b",
      surface: "openai-responses",
      sessionId: "shared-session"
    });
    await fixture.persistence.requestStates.begin("idem_surface", "request_surface", {
      ...routeContext(),
      organizationId: "org_a",
      surface: "anthropic-messages",
      sessionId: "shared-session"
    });

    const rows = await fixture.db.select().from(agentSessions);

    expect(rows.map((row) => row.id).sort()).toEqual([
      "org_a:anthropic-messages:shared-session",
      "org_a:openai-responses:shared-session",
      "org_b:openai-responses:shared-session"
    ]);
  });

  it("admin overview counts beyond the request page size", async () => {
    const fixture = await persistenceFixture("org_admin_overview");
    await fixture.db.insert(organizations).values({
      id: "org_admin_overview",
      slug: "org_admin_overview",
      name: "org_admin_overview"
    }).onConflictDoNothing();

    const ids = Array.from({ length: 201 }, (_, index) => `request_page_${index}`);
    await fixture.db.insert(requests).values(ids.map((id, index) => ({
      id,
      organizationId: "org_admin_overview",
      surface: "openai-responses" as const,
      idempotencyKey: `idem_page_${index}`,
      requestedModel: "router-auto",
      inputHash: `sha256:page:${index}`,
      inputChars: 10,
      status: "completed" as const
    })));
    await fixture.db.insert(routeDecisions).values(ids.map((id, index) => ({
      id: `decision_page_${index}`,
      requestId: id,
      organizationId: "org_admin_overview",
      requestedModel: "router-auto",
      finalRoute: "hard" as const,
      selectedProvider: "openai" as const,
      selectedModel: "gpt-routed-hard-test",
      policyVersion: "test"
    })));
    await fixture.db.insert(providerAttempts).values(ids.map((id, index) => ({
      id: `attempt_page_${index}`,
      requestId: id,
      organizationId: "org_admin_overview",
      surface: "openai-responses" as const,
      provider: "openai" as const,
      model: "gpt-routed-hard-test",
      terminalStatus: "completed" as const,
      startedAt: new Date(2026, 0, 1, 0, 0, index),
      completedAt: new Date(2026, 0, 1, 0, 0, index, 1)
    })));
    await fixture.db.insert(usageLedger).values(ids.map((id, index) => ({
      id: `usage_page_${index}`,
      organizationId: "org_admin_overview",
      requestId: id,
      providerAttemptId: `attempt_page_${index}`,
      provider: "openai" as const,
      model: "gpt-routed-hard-test",
      route: "hard" as const,
      inputTokens: 1,
      totalTokens: 1,
      inputCostMicros: 2,
      totalCostMicros: 2
    })));

    const overview = await fixture.persistence.adminQueries.overview();
    const requestPage = await fixture.persistence.adminQueries.requests();

    expect(overview.requestCount).toBe(201);
    expect(overview.totals.totalTokens).toBe(201);
    expect(requestPage.data).toHaveLength(200);
  });

  it("admin request summaries use one latest attempt per request", async () => {
    const fixture = await persistenceFixture("org_admin_retry");
    await fixture.db.insert(organizations).values({
      id: "org_admin_retry",
      slug: "org_admin_retry",
      name: "org_admin_retry"
    }).onConflictDoNothing();
    await fixture.db.insert(routingConfigs).values({
      id: "routing_config_retry",
      organizationId: "org_admin_retry",
      name: "Retry routing config",
      slug: "retry-routing-config"
    });
    await fixture.db.insert(requests).values({
      id: "request_retry",
      organizationId: "org_admin_retry",
      surface: "openai-responses",
      idempotencyKey: "idem_retry",
      requestedModel: "router-auto",
      inputHash: "sha256:retry",
      inputChars: 10,
      routingConfigId: "routing_config_retry",
      routingConfigVersionId: "routing_config_retry:v2",
      routingConfigVersion: 2,
      routingConfigHash: "sha256:routing-config-retry",
      status: "completed"
    });
    await fixture.db.insert(routeDecisions).values({
      id: "decision_retry",
      requestId: "request_retry",
      organizationId: "org_admin_retry",
      requestedModel: "router-auto",
      finalRoute: "hard",
      selectedProvider: "openai",
      selectedModel: "gpt-routed-hard-test",
      routingConfigId: "routing_config_retry",
      routingConfigVersionId: "routing_config_retry:v2",
      routingConfigVersion: 2,
      routingConfigHash: "sha256:routing-config-retry",
      policyVersion: "test"
    });
    await fixture.db.insert(providerAttempts).values([
      {
        id: "attempt_retry_old",
        requestId: "request_retry",
        organizationId: "org_admin_retry",
        surface: "openai-responses",
        provider: "openai",
        model: "gpt-routed-hard-test",
        terminalStatus: "failed",
        startedAt: new Date(2026, 0, 1),
        completedAt: new Date(2026, 0, 1, 0, 0, 1)
      },
      {
        id: "attempt_retry_new",
        requestId: "request_retry",
        organizationId: "org_admin_retry",
        surface: "openai-responses",
        provider: "openai",
        model: "gpt-routed-hard-test",
        terminalStatus: "completed",
        startedAt: new Date(2026, 0, 2),
        completedAt: new Date(2026, 0, 2, 0, 0, 1)
      }
    ]);
    await fixture.db.insert(usageLedger).values([
      {
        id: "usage_retry_old",
        organizationId: "org_admin_retry",
        requestId: "request_retry",
        providerAttemptId: "attempt_retry_old",
        provider: "openai",
        model: "gpt-routed-hard-test",
        inputTokens: 1,
        totalTokens: 1
      },
      {
        id: "usage_retry_new",
        organizationId: "org_admin_retry",
        requestId: "request_retry",
        providerAttemptId: "attempt_retry_new",
        provider: "openai",
        model: "gpt-routed-hard-test",
        inputTokens: 9,
        totalTokens: 9
      }
    ]);

    const requestsPage = await fixture.persistence.adminQueries.requests();
    const detail = await fixture.persistence.adminQueries.requestDetail("request_retry");

    expect(requestsPage.data).toHaveLength(1);
    expect(requestsPage.data[0]?.terminalStatus).toBe("completed");
    expect(requestsPage.data[0]?.usage.totalTokens).toBe(9);
    expect(requestsPage.data[0]?.routingConfig).toEqual({
      configId: "routing_config_retry",
      configName: "Retry routing config",
      versionId: "routing_config_retry:v2",
      version: 2,
      configHash: "sha256:routing-config-retry"
    });
    expect(detail.request?.terminalStatus).toBe("completed");
    expect(detail.request?.routingConfig).toEqual({
      configId: "routing_config_retry",
      configName: "Retry routing config",
      versionId: "routing_config_retry:v2",
      version: 2,
      configHash: "sha256:routing-config-retry"
    });
  });

  it("keeps identical external session ids separate by organization", async () => {
    const fixture = await persistenceFixture("org_a");
    const orgBConfig = loadConfig({
      ...process.env,
      DEFAULT_ORGANIZATION_ID: "org_b",
      MODEL_COSTS_JSON: JSON.stringify({ "gpt-routed-hard-test": { inputCostPerMtok: 2, outputCostPerMtok: 10 } })
    });
    const orgBPersistence = createDatabasePersistence(fixture.db, fixture.catalog, orgBConfig, false);

    await new EventService(undefined, undefined, fixture.persistence.eventSink, "org_a").append({
      scopeType: "session",
      scopeId: "session_scope_a",
      sessionId: "shared-session",
      producer: "test",
      eventType: "session.route_memory_recorded",
      payload: {
        surface: "openai-responses",
        sessionId: "shared-session",
        currentRoute: "hard"
      }
    });
    await new EventService(undefined, undefined, orgBPersistence.eventSink, "org_b").append({
      scopeType: "session",
      scopeId: "session_scope_b",
      sessionId: "shared-session",
      producer: "test",
      eventType: "session.route_memory_recorded",
      payload: {
        surface: "openai-responses",
        sessionId: "shared-session",
        currentRoute: "fast"
      }
    });

    const rows = await fixture.db.select().from(agentSessions);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id).sort()).toEqual([
      "org_a:openai-responses:shared-session",
      "org_b:openai-responses:shared-session"
    ]);
    expect(rows.map((row) => row.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionIdentity: "harness" })
    ]));
  });

  async function persistenceFixture(organizationId: string) {
    client = new PGlite();
    const migration = await readFile(
      fileURLToPath(new URL("../../../packages/db/migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    await client.exec(migration);
    const db = createPgliteDatabase(client);
    const config = loadConfig({
      ...process.env,
      DEFAULT_ORGANIZATION_ID: organizationId,
      OPENAI_HARD_MODEL: "gpt-routed-hard-test",
      MODEL_COSTS_JSON: JSON.stringify({ "gpt-routed-hard-test": { inputCostPerMtok: 2, outputCostPerMtok: 10 } })
    });
    const catalog = buildModelCatalog(config);
    const persistence = createDatabasePersistence(db, catalog, config, false);
    return { db, config, catalog, persistence };
  }

  async function activeVersion(
    fixture: Awaited<ReturnType<typeof persistenceFixture>>,
    versionId: string
  ) {
    const [version] = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, versionId))
      .limit(1);
    expect(version).toBeTruthy();
    return version!;
  }
});

function routeContext(): RouteContext {
  return {
    surface: "openai-responses",
    requestedModel: "router-auto",
    inputChars: 400,
    inputHash: "sha256:input",
    estimatedInputTokens: 100,
    routingInputSource: "latest_user_message",
    routingInputText: "test",
    routingInputChars: 4,
    routingInputHash: "sha256:routing",
    routingEstimatedInputTokens: 1,
    hasTools: false,
    toolCount: 0,
    hasPreviousResponseId: false,
    hasImages: false,
    extractedHints: [],
    routingExtractedHints: []
  };
}
