import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  apiKeys,
  createPgliteDatabase,
  defaultWorkspaceId,
  deploymentHealth,
  eventOutbox,
  events,
  hashApiKey,
  organizations,
  providerConnectionHealth,
  providerAttempts,
  requests,
  routeDecisions,
  usageLedger,
  workspaces
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";

import { loadConfig } from "../src/config.js";
import { BoundedEventWriter, EventService } from "../src/events.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { ApiKeyIdentityStore } from "../src/persistence/identity.js";
import type { RouteContext } from "../src/types.js";

describe("postgres persistence", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("reprocesses completed idempotency keys under the canonical request id after restart", async () => {
    const fixture = await persistenceFixture("org_a");
    const context = routeContext();
    const first = await fixture.persistence.requestStates.begin("idem_1", "request_first", context);
    await fixture.persistence.requestStates.finish("idem_1", "completed");

    const restarted = createDatabasePersistence(fixture.db, fixture.config, false);
    const retry = await restarted.requestStates.begin("idem_1", "request_second", context);

    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(false);
    expect(retry.state.requestId).toBe("request_first");
    expect(retry.state.status).toBe("classifying");
  });

  it("reprocesses failed idempotency keys instead of replaying the failure", async () => {
    const fixture = await persistenceFixture("org_retry");
    const context = routeContext();
    const first = await fixture.persistence.requestStates.begin("idem_retry", "request_first", context);
    await fixture.persistence.requestStates.finish("idem_retry", "failed", { error: "provider unavailable" });

    const retry = await fixture.persistence.requestStates.begin("idem_retry", "request_second", context);
    const [requestRow] = await fixture.db.select().from(requests).where(eq(requests.idempotencyKey, "idem_retry"));

    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(false);
    expect(retry.state.requestId).toBe("request_first");
    expect(retry.state.status).toBe("classifying");
    expect(requestRow?.status).toBe("classifying");
    expect(requestRow?.completedAt).toBeNull();
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
        requestedModel: "coding-auto",
        inputHash: "sha256:input",
        inputChars: 1
      }
    })).rejects.toThrow("db_failed");

    expect(eventService.listEvents()).toEqual([]);
    expect(eventService.listOutbox()).toEqual([]);
  });

  it("flushes queued events through the durable event transaction", async () => {
    const fixture = await persistenceFixture("org_queue");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_queue");
    const writer = new BoundedEventWriter(eventService, {
      maxEntries: 10,
      maxBytes: 10_000,
      retryDelayMs: 1
    });

    writer.enqueue({
      scopeType: "request",
      scopeId: "request_queue",
      correlationId: "request_queue",
      idempotencyKey: "idem_queue",
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "openai-responses",
        requestedModel: "coding-auto",
        inputHash: "sha256:input",
        inputChars: 400
      }
    });
    const stats = await writer.drain(1_000);

    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_queue"));
    const eventRows = await fixture.db.select().from(events).where(eq(events.scopeId, "request_queue"));
    const outboxRows = eventRows[0]
      ? await fixture.db.select().from(eventOutbox).where(eq(eventOutbox.eventId, eventRows[0].id))
      : [];

    expect(stats.depth).toBe(0);
    expect(requestRows).toHaveLength(1);
    expect(eventRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(requestRows[0]?.status).toBe("received");
    expect(eventRows[0]?.eventType).toBe("proxy.request_received");
  });

  it("persists request lifecycle rows and usage cost from events", async () => {
    const fixture = await persistenceFixture("org_cost");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_cost");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_cost",
      SEED_USER_ID: "user_cost",
      PROXY_TOKEN: "token_cost"
    }));
    const workspaceId = defaultWorkspaceId("org_cost");
    const deploymentId = `${workspaceId}:deployment:openai:gpt-5.5`;
    const providerConnectionId = `${workspaceId}:connection:openai`;
    const logicalModelId = `${workspaceId}:logical-model:coding-auto`;
    const accessProfileId = `${workspaceId}:access-profile:opendoor-engineer`;

    await eventService.append({
      scopeType: "request",
      scopeId: "request_cost",
      correlationId: "request_cost",
      idempotencyKey: "idem_cost",
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "openai-responses",
        requestedModel: "coding-auto",
        inputHash: "sha256:input",
        inputChars: 400,
        ingressWireId: "openai-responses",
        operationId: "text.generate",
        requestedLogicalModel: "coding-auto"
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
        requestedModel: "coding-auto",
        inputHash: "sha256:input",
        inputChars: 400,
        estimatedInputTokens: 100,
        routingInputHash: "sha256:routing",
        routingInputChars: 200,
        routingEstimatedInputTokens: 50
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
        requestedModel: "coding-auto",
        selectedModel: "gpt-5.5",
        provider: "openai",
        reasoningEffort: "high",
        verbosity: "medium",
        guardrailActions: [],
        reasonCodes: ["test"],
        ingressWireId: "openai-responses",
        operationId: "text.generate",
        requestedLogicalModel: "coding-auto",
        resolvedLogicalModelId: logicalModelId,
        accessProfileId,
        routerKind: "classifier",
        deploymentId,
        providerConnectionId,
        egressWireId: "openai-responses",
        wireAdapterVersion: "1",
        routerDecisionId: "router_decision_cost",
        routerDecision: { confidence: 0.8 },
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
        model: "gpt-5.5",
        providerAttemptId: "attempt_cost",
        deploymentId,
        providerConnectionId,
        egressWireId: "openai-responses",
        providerAdapterContractVersion: "1"
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
        selectedModel: "gpt-5.5",
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
    expect(requestRows[0]).toMatchObject({
      ingressWireId: "openai-responses",
      operationId: "text.generate",
      requestedLogicalModel: "coding-auto",
      resolvedLogicalModelId: logicalModelId,
      accessProfileId,
      routerKind: "classifier",
      deploymentId,
      providerConnectionId,
      egressWireId: "openai-responses",
      wireAdapterVersion: "1"
    });
    expect(decisionRows[0]).toMatchObject({
      requestedLogicalModel: "coding-auto",
      resolvedLogicalModelId: logicalModelId,
      deploymentId,
      providerConnectionId,
      routerDecisionId: "router_decision_cost",
      routerDecision: { confidence: 0.8 }
    });
    expect(attemptRows[0]?.terminalStatus).toBe("completed");
    expect(attemptRows[0]).toMatchObject({
      deploymentId,
      providerConnectionId,
      egressWireId: "openai-responses",
      providerAdapterContractVersion: "1"
    });
    expect(usageRows[0]?.totalTokens).toBe(120);
    expect(usageRows[0]?.totalCostMicros).toBe(325);
    expect(eventRows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("persists provider connection and deployment ids on provider attempts", async () => {
    const fixture = await persistenceFixture("org_attempt_account_persisted");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_attempt_account_persisted");
    const gateway = await seedHealthGateway(fixture, "org_attempt_account_persisted");

    await eventService.append({
      scopeType: "request",
      scopeId: "request_attempt_account_persisted",
      correlationId: "request_attempt_account_persisted",
      idempotencyKey: "idem_attempt_account_persisted",
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "anthropic-messages",
        requestedModel: "coding-auto",
        inputHash: "sha256:attempt-account",
        inputChars: 10
      }
    });
    await eventService.append({
      scopeType: "request",
      scopeId: "request_attempt_account_persisted",
      correlationId: "request_attempt_account_persisted",
      idempotencyKey: "idem_attempt_account_persisted",
      producer: "test",
      eventType: "provider.request_started",
      payload: {
        surface: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        providerAttemptId: "attempt_account_persisted",
        ...gateway.attemptEvidence
      }
    });

    const attemptRows = await fixture.db.select().from(providerAttempts).where(eq(providerAttempts.id, "attempt_account_persisted"));

    expect(attemptRows[0]).toMatchObject(gateway.attemptEvidence);
  });

  it("updates provider connection health from terminal provider failures", async () => {
    const fixture = await persistenceFixture("org_account_health_projection");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_account_health_projection");
    const gateway = await seedHealthGateway(fixture, "org_account_health_projection");

    await appendHealthRequest(eventService, "request_account_health_projection", "idem_account_health_projection");
    await appendHealthStarted(eventService, "request_account_health_projection", "idem_account_health_projection", gateway.attemptEvidence);
    await eventService.append({
      scopeType: "request",
      scopeId: "request_account_health_projection",
      correlationId: "request_account_health_projection",
      idempotencyKey: "idem_account_health_projection",
      producer: "test",
      eventType: "provider.response_failed",
      payload: {
        surface: "anthropic-messages",
        provider: "anthropic",
        selectedModel: "claude-sonnet-4-5",
        providerAttemptId: "attempt_request_account_health_projection",
        ...gateway.attemptEvidence,
        terminalStatus: "failed",
        upstreamStatus: 429,
        error: "rate limited",
        healthClassification: {
          errorType: "rate_limited",
          source: "provider_status",
          confidence: "exact",
          retryable: true,
          scope: "provider_connection",
          cooldownUntil: "2026-06-18T12:05:00.000Z",
          message: "rate limited",
          metadata: {}
        }
      }
    });

    const rows = await fixture.db
      .select()
      .from(providerConnectionHealth)
      .where(eq(providerConnectionHealth.providerConnectionId, gateway.providerConnectionId));

    expect(rows[0]).toEqual(expect.objectContaining({
      status: "cooldown",
      lastErrorType: "rate_limited",
      consecutiveFailures: 1
    }));
    expect(rows[0]?.cooldownUntil).toBeTruthy();
  });

  it("updates deployment health from terminal deployment failures", async () => {
    const fixture = await persistenceFixture("org_model_health_projection");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_model_health_projection");
    const gateway = await seedHealthGateway(fixture, "org_model_health_projection");

    await appendHealthRequest(eventService, "request_model_health_projection", "idem_model_health_projection");
    await appendHealthStarted(eventService, "request_model_health_projection", "idem_model_health_projection", gateway.attemptEvidence);
    await eventService.append({
      scopeType: "request",
      scopeId: "request_model_health_projection",
      correlationId: "request_model_health_projection",
      idempotencyKey: "idem_model_health_projection",
      producer: "test",
      eventType: "provider.response_failed",
      payload: {
        surface: "anthropic-messages",
        provider: "anthropic",
        selectedModel: "claude-sonnet-4-5",
        providerAttemptId: "attempt_request_model_health_projection",
        ...gateway.attemptEvidence,
        terminalStatus: "failed",
        upstreamStatus: 404,
        error: "model claude-sonnet-4-5 not found",
        healthClassification: {
          errorType: "model_unavailable",
          source: "response_body",
          confidence: "heuristic",
          retryable: true,
          scope: "deployment",
          cooldownUntil: "2026-06-18T12:10:00.000Z",
          message: "model claude-sonnet-4-5 not found",
          metadata: {}
        }
      }
    });

    const rows = await fixture.db
      .select()
      .from(deploymentHealth)
      .where(eq(deploymentHealth.deploymentId, gateway.deploymentId));

    expect(rows[0]).toEqual(expect.objectContaining({
      status: "locked_out",
      lastErrorType: "model_unavailable",
      consecutiveFailures: 1
    }));
    expect(rows[0]?.lockoutUntil).toBeTruthy();
  });

  it("preserves adapter health classification metadata from terminal provider failures", async () => {
    const fixture = await persistenceFixture("org_bedrock_health_projection");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_bedrock_health_projection");
    const gateway = await seedHealthGateway(fixture, "org_bedrock_health_projection");

    await appendHealthRequest(eventService, "request_bedrock_health_projection", "idem_bedrock_health_projection");
    await appendHealthStarted(eventService, "request_bedrock_health_projection", "idem_bedrock_health_projection", gateway.attemptEvidence);
    await eventService.append({
      scopeType: "request",
      scopeId: "request_bedrock_health_projection",
      correlationId: "request_bedrock_health_projection",
      idempotencyKey: "idem_bedrock_health_projection",
      producer: "test",
      eventType: "provider.response_failed",
      payload: {
        surface: "openai-responses",
        provider: "anthropic",
        selectedModel: "claude-sonnet-4-5",
        providerAttemptId: "attempt_request_bedrock_health_projection",
        ...gateway.attemptEvidence,
        terminalStatus: "failed",
        upstreamStatus: 403,
        error: "generic forbidden",
        healthClassification: {
          errorType: "model_access_denied",
          source: "response_body",
          confidence: "exact",
          retryable: false,
          scope: "deployment",
          cooldownUntil: null,
          message: "not authorized for response streaming",
          metadata: {
            bedrockErrorKind: "stream_permission_denied",
            bedrockOperation: "ConverseStream",
            region: "us-east-1",
            model: "claude-sonnet-4-5"
          }
        }
      }
    });

    const rows = await fixture.db
      .select()
      .from(deploymentHealth)
      .where(eq(deploymentHealth.deploymentId, gateway.deploymentId));

    expect(rows[0]).toEqual(expect.objectContaining({
      status: "terminal",
      lastErrorType: "model_access_denied",
      metadata: expect.objectContaining({
        bedrockErrorKind: "stream_permission_denied",
        bedrockOperation: "ConverseStream",
        region: "us-east-1"
      })
    }));
  });

  it("preserves streaming permission health across non-streaming successes", async () => {
    const fixture = await persistenceFixture("org_stream_permission_health_projection");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_stream_permission_health_projection");
    const gateway = await seedHealthGateway(fixture, "org_stream_permission_health_projection");
    const model = "claude-sonnet-4-5";

    await appendHealthRequest(eventService, "request_stream_permission_non_stream", "idem_stream_permission_non_stream");
    await fixture.db.insert(deploymentHealth).values({
      id: "stream_permission_model_health",
      organizationId: "org_stream_permission_health_projection",
      workspaceId: defaultWorkspaceId("org_stream_permission_health_projection"),
      deploymentId: gateway.deploymentId,
      providerConnectionId: gateway.providerConnectionId,
      status: "terminal",
      lastErrorType: "model_access_denied",
      lastErrorAt: new Date("2026-06-18T11:59:00.000Z"),
      consecutiveFailures: 1,
      metadata: {
        bedrockErrorKind: "stream_permission_denied",
        bedrockOperation: "ConverseStream",
        region: "us-east-1"
      }
    });
    await appendHealthStarted(eventService, "request_stream_permission_non_stream", "idem_stream_permission_non_stream", gateway.attemptEvidence);
    await eventService.append({
      scopeType: "request",
      scopeId: "request_stream_permission_non_stream",
      correlationId: "request_stream_permission_non_stream",
      idempotencyKey: "idem_stream_permission_non_stream",
      producer: "test",
      eventType: "provider.response_completed",
      payload: {
        surface: "openai-responses",
        provider: "anthropic",
        selectedModel: model,
        providerAttemptId: "attempt_request_stream_permission_non_stream",
        ...gateway.attemptEvidence,
        terminalStatus: "completed",
        upstreamStatus: 200,
        stream: false,
        usage: null
      }
    });

    const preservedRows = await fixture.db
      .select()
      .from(deploymentHealth)
      .where(eq(deploymentHealth.deploymentId, gateway.deploymentId));
    expect(preservedRows[0]).toEqual(expect.objectContaining({
      status: "terminal",
      lastErrorType: "model_access_denied",
      metadata: expect.objectContaining({ bedrockErrorKind: "stream_permission_denied" })
    }));

    await appendHealthRequest(eventService, "request_stream_permission_stream", "idem_stream_permission_stream");
    await appendHealthStarted(eventService, "request_stream_permission_stream", "idem_stream_permission_stream", gateway.attemptEvidence);
    await eventService.append({
      scopeType: "request",
      scopeId: "request_stream_permission_stream",
      correlationId: "request_stream_permission_stream",
      idempotencyKey: "idem_stream_permission_stream",
      producer: "test",
      eventType: "provider.response_completed",
      payload: {
        surface: "openai-responses",
        provider: "anthropic",
        selectedModel: model,
        providerAttemptId: "attempt_request_stream_permission_stream",
        ...gateway.attemptEvidence,
        terminalStatus: "completed",
        upstreamStatus: 200,
        stream: true,
        usage: null
      }
    });

    const clearedRows = await fixture.db
      .select()
      .from(deploymentHealth)
      .where(eq(deploymentHealth.deploymentId, gateway.deploymentId));
    expect(clearedRows[0]).toEqual(expect.objectContaining({
      status: "healthy",
      lastErrorType: null,
      metadata: {}
    }));
  });

  it("resets provider health state on successful provider attempts", async () => {
    const fixture = await persistenceFixture("org_health_success_projection");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_health_success_projection");
    const gateway = await seedHealthGateway(fixture, "org_health_success_projection");

    await appendHealthRequest(eventService, "request_health_success_projection", "idem_health_success_projection");
    await fixture.db.insert(providerConnectionHealth).values({
      id: "account_health_success_projection_state",
      organizationId: "org_health_success_projection",
      workspaceId: defaultWorkspaceId("org_health_success_projection"),
      providerConnectionId: gateway.providerConnectionId,
      status: "cooldown",
      lastErrorType: "rate_limited",
      lastErrorMessage: "rate limited",
      lastErrorAt: new Date("2026-06-18T11:59:00.000Z"),
      cooldownUntil: new Date("2026-06-18T12:05:00.000Z"),
      consecutiveFailures: 2,
      metadata: {}
    });
    await appendHealthStarted(eventService, "request_health_success_projection", "idem_health_success_projection", gateway.attemptEvidence);
    await eventService.append({
      scopeType: "request",
      scopeId: "request_health_success_projection",
      correlationId: "request_health_success_projection",
      idempotencyKey: "idem_health_success_projection",
      producer: "test",
      eventType: "provider.response_completed",
      payload: {
        surface: "anthropic-messages",
        provider: "anthropic",
        selectedModel: "claude-sonnet-4-5",
        providerAttemptId: "attempt_request_health_success_projection",
        ...gateway.attemptEvidence,
        terminalStatus: "completed",
        upstreamStatus: 200,
        usage: null
      }
    });

    const rows = await fixture.db
      .select()
      .from(providerConnectionHealth)
      .where(eq(providerConnectionHealth.providerConnectionId, gateway.providerConnectionId));

    expect(rows[0]).toEqual(expect.objectContaining({
      status: "healthy",
      lastErrorType: null,
      lastErrorMessage: null,
      cooldownUntil: null,
      consecutiveFailures: 0
    }));
  });

  it("does not update durable health for request-only provider failures", async () => {
    const fixture = await persistenceFixture("org_health_request_only_projection");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_health_request_only_projection");
    const gateway = await seedHealthGateway(fixture, "org_health_request_only_projection");

    await appendHealthRequest(eventService, "request_health_request_only_projection", "idem_health_request_only_projection");
    await appendHealthStarted(eventService, "request_health_request_only_projection", "idem_health_request_only_projection", gateway.attemptEvidence);
    await eventService.append({
      scopeType: "request",
      scopeId: "request_health_request_only_projection",
      correlationId: "request_health_request_only_projection",
      idempotencyKey: "idem_health_request_only_projection",
      producer: "test",
      eventType: "provider.response_failed",
      payload: {
        surface: "anthropic-messages",
        provider: "anthropic",
        selectedModel: "claude-sonnet-4-5",
        providerAttemptId: "attempt_request_health_request_only_projection",
        ...gateway.attemptEvidence,
        terminalStatus: "failed",
        upstreamStatus: 400,
        error: "context_length_exceeded",
        healthClassification: {
          errorType: "context_overflow",
          source: "response_body",
          confidence: "heuristic",
          retryable: false,
          scope: "request_only",
          cooldownUntil: null,
          message: "context_length_exceeded",
          metadata: {}
        }
      }
    });

    const connectionRows = await fixture.db
      .select()
      .from(providerConnectionHealth)
      .where(eq(providerConnectionHealth.providerConnectionId, gateway.providerConnectionId));
    const deploymentRows = await fixture.db
      .select()
      .from(deploymentHealth)
      .where(eq(deploymentHealth.deploymentId, gateway.deploymentId));

    expect(connectionRows).toHaveLength(0);
    expect(deploymentRows).toHaveLength(0);
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
        requestedModel: "coding-auto",
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
        model: "gpt-5.4",
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
        selectedModel: "gpt-5.4",
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

  it("stores unknown surface/provider values verbatim and absent ones as the unknown sentinel", async () => {
    const fixture = await persistenceFixture("org_unknown");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_unknown");
    const append = (eventType: string, payload: Record<string, unknown>) =>
      eventService.append({
        scopeType: "request",
        scopeId: "request_unknown",
        correlationId: "request_unknown",
        idempotencyKey: "idem_unknown",
        producer: "test",
        eventType,
        payload
      });

    await append("proxy.request_received", {
      requestedModel: "coding-auto",
      inputHash: "sha256:input",
      inputChars: 10
    });
    await append("routing.decision_recorded", {
      outcome: "route",
      surface: "openai-chat",
      requestedModel: "coding-auto",
      selectedModel: "qwen3-coder-30b",
      provider: "acme-vllm",
      guardrailActions: [],
      reasonCodes: ["test"],
      routerDecision: { confidence: 0.5 },
      policyVersion: "test"
    });
    await append("provider.request_started", {
      surface: "openai-chat",
      provider: "acme-vllm",
      model: "qwen3-coder-30b",
      providerAttemptId: "attempt_unknown"
    });
    await append("provider.response_completed", {
      surface: "openai-chat",
      provider: "acme-vllm",
      selectedModel: "qwen3-coder-30b",
      providerAttemptId: "attempt_unknown",
      upstreamStatus: 200,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      }
    });

    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_unknown"));
    const decisionRows = await fixture.db.select().from(routeDecisions).where(eq(routeDecisions.requestId, "request_unknown"));
    const attemptRows = await fixture.db.select().from(providerAttempts).where(eq(providerAttempts.id, "attempt_unknown"));
    const usageRows = await fixture.db.select().from(usageLedger).where(eq(usageLedger.providerAttemptId, "attempt_unknown"));

    expect(requestRows[0]?.surface).toBe("unknown");
    expect(decisionRows[0]?.selectedProvider).toBe("acme-vllm");
    expect(attemptRows[0]?.surface).toBe("openai-chat");
    expect(attemptRows[0]?.provider).toBe("acme-vllm");
    expect(usageRows[0]?.provider).toBe("acme-vllm");
    expect(usageRows[0]?.totalTokens).toBe(15);
  });

  it("stores an unrecognized surface verbatim on requests and sessions", async () => {
    const fixture = await persistenceFixture("org_verbatim");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_verbatim");

    await eventService.append({
      scopeType: "request",
      scopeId: "request_verbatim",
      correlationId: "request_verbatim",
      idempotencyKey: "idem_verbatim",
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "openai-chat",
        sessionId: "chat-session",
        requestedModel: "coding-auto",
        inputHash: "sha256:input",
        inputChars: 10
      }
    });

    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_verbatim"));
    const sessionRows = await fixture.db.select().from(agentSessions).where(eq(agentSessions.organizationId, "org_verbatim"));

    expect(requestRows[0]?.surface).toBe("openai-chat");
    expect(sessionRows[0]?.surface).toBe("openai-chat");
    expect(sessionRows[0]?.id).toBe("org_verbatim:workspace:default:openai-chat:chat-session");
  });

  it("books absent provider and surface as unknown sentinels on attempts", async () => {
    const fixture = await persistenceFixture("org_absent");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_absent");
    const append = (eventType: string, payload: Record<string, unknown>) =>
      eventService.append({
        scopeType: "request",
        scopeId: "request_absent",
        correlationId: "request_absent",
        idempotencyKey: "idem_absent",
        producer: "test",
        eventType,
        payload
      });

    await append("proxy.request_received", {
      surface: "openai-responses",
      requestedModel: "coding-auto",
      inputHash: "sha256:input",
      inputChars: 10
    });
    await append("provider.request_started", {
      model: "mystery-model",
      providerAttemptId: "attempt_absent"
    });

    const attemptRows = await fixture.db.select().from(providerAttempts).where(eq(providerAttempts.id, "attempt_absent"));

    expect(attemptRows[0]?.surface).toBe("unknown");
    expect(attemptRows[0]?.provider).toBe("unknown");
  });

  it("treats a route context with an unrecognized surface as absent", async () => {
    const fixture = await persistenceFixture("org_strict_guard");
    const context = { ...routeContext(), surface: "future-surface" } as unknown as RouteContext;

    await fixture.persistence.requestStates.begin("idem_strict_guard", "request_strict_guard", context);

    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_strict_guard"));

    expect(requestRows[0]?.surface).toBe("unknown");
    expect(requestRows[0]?.requestedModel).toBe("unknown");
  });

  it("keeps provider terminal state owned by terminal event projection", async () => {
    const fixture = await persistenceFixture("org_terminal_owner");
    await fixture.persistence.requestStates.begin("idem_terminal", "request_terminal", routeContext());
    const eventService = new EventService(
      undefined,
      undefined,
      fixture.persistence.eventSink,
      "org_terminal_owner"
    );
    await eventService.append({
      scopeType: "request",
      scopeId: "request_terminal",
      correlationId: "request_terminal",
      idempotencyKey: "idem_terminal",
      producer: "test",
      eventType: "provider.request_started",
      payload: {
        surface: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        providerAttemptId: "attempt_terminal"
      }
    });
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
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_api_key"),
      organizationId: "org_api_key",
      slug: "default",
      name: "Default"
    }).onConflictDoNothing();
    await fixture.db.insert(apiKeys).values({
      id: "api_key_1",
      organizationId: "org_api_key",
      workspaceId: defaultWorkspaceId("org_api_key"),
      keyHash: hashApiKey("secret-token"),
      name: "Local Proxy Key"
    });

    const identity = await fixture.persistence.apiKeys.resolve("secret-token", new Date("2026-06-08T00:00:00.000Z"));
    await fixture.persistence.apiKeys.resolve("secret-token", new Date("2026-06-08T00:00:04.000Z"));
    const rowsBeforeFlush = await fixture.db.select().from(apiKeys).where(eq(apiKeys.id, "api_key_1"));
    await fixture.persistence.apiKeys.flushLastUsed();
    const rows = await fixture.db.select().from(apiKeys).where(eq(apiKeys.id, "api_key_1"));

    expect(identity).toEqual({
      apiKeyId: "api_key_1",
      organizationId: "org_api_key",
      workspaceId: defaultWorkspaceId("org_api_key"),
      userId: undefined,
      accessProfileId: null,
      accessProfileLimits: {}
    });
    expect(rowsBeforeFlush[0]?.lastUsedAt).toBeNull();
    expect(rows[0]?.lastUsedAt?.toISOString()).toBe("2026-06-08T00:00:04.000Z");
    await expect(fixture.persistence.apiKeys.resolve("wrong-token")).resolves.toBeUndefined();
  });

  it("serves api key identity from cache only until ttl expiry", async () => {
    const fixture = await persistenceFixture("org_api_key_cache");
    await fixture.db.insert(organizations).values({
      id: "org_api_key_cache",
      slug: "org_api_key_cache",
      name: "org_api_key_cache"
    }).onConflictDoNothing();
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_api_key_cache"),
      organizationId: "org_api_key_cache",
      slug: "default",
      name: "Default"
    }).onConflictDoNothing();
    await fixture.db.insert(apiKeys).values({
      id: "api_key_cache",
      organizationId: "org_api_key_cache",
      workspaceId: defaultWorkspaceId("org_api_key_cache"),
      keyHash: hashApiKey("cached-token"),
      name: "Cached key",
      scopes: ["proxy"]
    });
    const store = new ApiKeyIdentityStore(fixture.db, {
      cacheTtlMs: 1_000,
      lastUsedFlushDelayMs: 60_000
    });

    const beforeRevoke = await store.resolve("cached-token", new Date("2026-06-08T00:00:00.000Z"));
    await fixture.db
      .update(apiKeys)
      .set({ revokedAt: new Date("2026-06-08T00:00:00.250Z") })
      .where(eq(apiKeys.id, "api_key_cache"));
    const cachedAfterRevoke = await store.resolve("cached-token", new Date("2026-06-08T00:00:00.500Z"));
    const expiredAfterRevoke = await store.resolve("cached-token", new Date("2026-06-08T00:00:01.500Z"));
    await store.flushLastUsed();

    expect(beforeRevoke?.apiKeyId).toBe("api_key_cache");
    expect(cachedAfterRevoke?.apiKeyId).toBe("api_key_cache");
    expect(expiredAfterRevoke).toBeUndefined();
  });

  it("resolves the seeded local proxy token through the API-key identity store", async () => {
    const fixture = await persistenceFixture("org_seed_identity");
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_seed_identity",
      SEED_USER_ID: "seed_identity_user",
      PROXY_TOKEN: "seeded-secret-token"
    }));

    const identity = await fixture.persistence.apiKeys.resolve("seeded-secret-token");

    expect(identity).toEqual(expect.objectContaining({
      apiKeyId: "org_seed_identity:api-key:default",
      organizationId: "org_seed_identity",
      userId: "seed_identity_user",
      accessProfileId: "org_seed_identity:workspace:default:access-profile:opendoor-engineer"
    }));
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

  it("scopes direct request idempotency by workspace", async () => {
    const fixture = await persistenceFixture("org_workspace_idem");
    const secondWorkspaceId = "org_workspace_idem:workspace:second";
    const first = await fixture.persistence.requestStates.begin("idem_shared", "request_default", {
      ...routeContext(),
      organizationId: "org_workspace_idem"
    });
    await fixture.db.insert(workspaces).values({
      id: secondWorkspaceId,
      organizationId: "org_workspace_idem",
      slug: "second",
      name: "Second"
    });
    const second = await fixture.persistence.requestStates.begin("idem_shared", "request_second", {
      ...routeContext(),
      organizationId: "org_workspace_idem",
      workspaceId: secondWorkspaceId
    });
    await fixture.persistence.requestStates.markProviderPending("idem_shared", "attempt_second", "request_second");
    await fixture.persistence.requestStates.finish("idem_shared", "failed", {
      requestId: "request_second",
      error: "failed second"
    });

    const requestRows = await fixture.db.select().from(requests);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(requestRows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      idempotencyKey: row.idempotencyKey,
      status: row.status
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      {
        id: "request_default",
        workspaceId: defaultWorkspaceId("org_workspace_idem"),
        idempotencyKey: "idem_shared",
        status: "classifying"
      },
      {
        id: "request_second",
        workspaceId: secondWorkspaceId,
        idempotencyKey: "idem_shared",
        status: "failed"
      }
    ]);
  });

  it("projects request-received events with workspace-scoped idempotency", async () => {
    const fixture = await persistenceFixture("org_event_workspace_idem");
    const eventService = new EventService(undefined, undefined, fixture.persistence.eventSink, "org_event_workspace_idem");
    const secondWorkspaceId = "org_event_workspace_idem:workspace:second";

    for (const [scopeId, workspaceId] of [
      ["request_event_default", defaultWorkspaceId("org_event_workspace_idem")],
      ["request_event_second", secondWorkspaceId]
    ] as const) {
      if (workspaceId === secondWorkspaceId) {
        await fixture.db.insert(workspaces).values({
          id: secondWorkspaceId,
          organizationId: "org_event_workspace_idem",
          slug: "second",
          name: "Second"
        });
      }
      await eventService.append({
        workspaceId,
        scopeType: "request",
        scopeId,
        correlationId: scopeId,
        idempotencyKey: "idem_event_shared",
        producer: "test",
        eventType: "proxy.request_received",
        payload: {
          surface: "openai-responses",
          requestedModel: "coding-auto",
          inputHash: `sha256:${scopeId}`,
          inputChars: 12
        }
      });
    }

    const requestRows = await fixture.db.select().from(requests);

    expect(requestRows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      idempotencyKey: row.idempotencyKey
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      {
        id: "request_event_default",
        workspaceId: defaultWorkspaceId("org_event_workspace_idem"),
        idempotencyKey: "idem_event_shared"
      },
      {
        id: "request_event_second",
        workspaceId: secondWorkspaceId,
        idempotencyKey: "idem_event_shared"
      }
    ]);
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
        id: "org_sessions:workspace:default:openai-responses:codex-session",
        externalSessionId: "codex-session",
        metadata: { sessionIdentity: "harness" }
      },
      {
        id: "org_sessions:workspace:default:anthropic-messages:claude-session",
        externalSessionId: "claude-session",
        metadata: { sessionIdentity: "harness" }
      }
    ]));
    expect(requestRows.find((row) => row.id === "request_codex")?.sessionId)
      .toBe("org_sessions:workspace:default:openai-responses:codex-session");
    expect(requestRows.find((row) => row.id === "request_claude")?.sessionId)
      .toBe("org_sessions:workspace:default:anthropic-messages:claude-session");
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
    expect(rows[0]?.id).toBe("org_fallback_session:workspace:default:openai-responses:request:request_fallback");
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
        requestedModel: "coding-auto",
        inputHash: "sha256:event-fallback",
        inputChars: 12
      }
    });

    const rows = await fixture.db.select().from(agentSessions);
    const requestRows = await fixture.db.select().from(requests).where(eq(requests.id, "request_event_fallback"));

    expect(rows[0]?.id).toBe("org_event_fallback:workspace:default:anthropic-messages:request:request_event_fallback");
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
      "org_a:workspace:default:anthropic-messages:shared-session",
      "org_a:workspace:default:openai-responses:shared-session",
      "org_b:workspace:default:openai-responses:shared-session"
    ]);
  });

  it("admin overview counts beyond the request page size", async () => {
    const fixture = await persistenceFixture("org_admin_overview");
    await fixture.db.insert(organizations).values({
      id: "org_admin_overview",
      slug: "org_admin_overview",
      name: "org_admin_overview"
    }).onConflictDoNothing();
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_admin_overview"),
      organizationId: "org_admin_overview",
      slug: "default",
      name: "Default"
    }).onConflictDoNothing();

    const ids = Array.from({ length: 201 }, (_, index) => `request_page_${index}`);
    await fixture.db.insert(requests).values(ids.map((id, index) => ({
      id,
      organizationId: "org_admin_overview",
      workspaceId: defaultWorkspaceId("org_admin_overview"),
      surface: "openai-responses" as const,
      idempotencyKey: `idem_page_${index}`,
      requestedModel: "coding-auto",
      inputHash: `sha256:page:${index}`,
      inputChars: 10,
      status: "completed" as const
    })));
    await fixture.db.insert(routeDecisions).values(ids.map((id, index) => ({
      id: `decision_page_${index}`,
      requestId: id,
      organizationId: "org_admin_overview",
      workspaceId: defaultWorkspaceId("org_admin_overview"),
      requestedModel: "coding-auto",
      selectedProvider: "openai" as const,
      selectedModel: "gpt-5.4",
      policyVersion: "test"
    })));
    await fixture.db.insert(providerAttempts).values(ids.map((id, index) => ({
      id: `attempt_page_${index}`,
      requestId: id,
      organizationId: "org_admin_overview",
      workspaceId: defaultWorkspaceId("org_admin_overview"),
      surface: "openai-responses" as const,
      provider: "openai" as const,
      model: "gpt-5.4",
      terminalStatus: "completed" as const,
      startedAt: new Date(2026, 0, 1, 0, 0, index),
      completedAt: new Date(2026, 0, 1, 0, 0, index, 1)
    })));
    await fixture.db.insert(usageLedger).values(ids.map((id, index) => ({
      id: `usage_page_${index}`,
      organizationId: "org_admin_overview",
      workspaceId: defaultWorkspaceId("org_admin_overview"),
      requestId: id,
      providerAttemptId: `attempt_page_${index}`,
      provider: "openai" as const,
      model: "gpt-5.4",
      inputTokens: 1,
      totalTokens: 1,
      inputCostMicros: 2,
      totalCostMicros: 2
    })));

    const overview = await fixture.persistence.adminQueries.forScope("org_admin_overview", defaultWorkspaceId("org_admin_overview")).overview();
    const requestPage = await fixture.persistence.adminQueries.forScope("org_admin_overview", defaultWorkspaceId("org_admin_overview")).requests();

    expect(overview.requestCount).toBe(201);
    expect(overview.totals.totalTokens).toBe(201);
    expect(requestPage.data).toHaveLength(200);
  });

  it("admin request summaries use one latest attempt per request", async () => {
    const fixture = await persistenceFixture("org_admin_retry");
    const gateway = await seedHealthGateway(fixture, "org_admin_retry");
    const workspaceId = defaultWorkspaceId("org_admin_retry");
    const resolutionEvidence = {
      ingressWireId: "openai-responses" as const,
      operationId: "text.generate" as const,
      requestedLogicalModel: "coding-auto",
      resolvedLogicalModelId: `${workspaceId}:logical-model:coding-auto`,
      accessProfileId: `${workspaceId}:access-profile:opendoor-engineer`,
      routerKind: "classifier" as const,
      deploymentId: gateway.deploymentId,
      providerConnectionId: gateway.providerConnectionId,
      egressWireId: "anthropic-messages" as const,
      wireAdapterVersion: "1"
    };
    await fixture.db.insert(requests).values({
      id: "request_retry",
      organizationId: "org_admin_retry",
      workspaceId,
      surface: "openai-responses",
      idempotencyKey: "idem_retry",
      requestedModel: "coding-auto",
      inputHash: "sha256:retry",
      inputChars: 10,
      ...resolutionEvidence,
      status: "completed"
    });
    await fixture.db.insert(routeDecisions).values({
      id: "decision_retry",
      requestId: "request_retry",
      organizationId: "org_admin_retry",
      workspaceId,
      requestedModel: "coding-auto",
      selectedProvider: "anthropic",
      selectedModel: "claude-sonnet-4-5",
      ...resolutionEvidence,
      routerDecisionId: "router_decision_retry",
      routerDecision: { confidence: 0.88, reason: "coding_workload" },
      translated: true,
      translatorId: "openai-responses_to_anthropic-messages",
      policyVersion: "test"
    });
    await fixture.db.insert(providerAttempts).values([
      {
        id: "attempt_retry_old",
        requestId: "request_retry",
        organizationId: "org_admin_retry",
        workspaceId,
        surface: "openai-responses",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        ...gateway.attemptEvidence,
        terminalStatus: "failed",
        startedAt: new Date(2026, 0, 1),
        completedAt: new Date(2026, 0, 1, 0, 0, 1)
      },
      {
        id: "attempt_retry_new",
        requestId: "request_retry",
        organizationId: "org_admin_retry",
        workspaceId,
        surface: "openai-responses",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        ...gateway.attemptEvidence,
        terminalStatus: "completed",
        startedAt: new Date(2026, 0, 2),
        completedAt: new Date(2026, 0, 2, 0, 0, 1)
      }
    ]);
    await fixture.db.insert(usageLedger).values([
      {
        id: "usage_retry_old",
        organizationId: "org_admin_retry",
        workspaceId,
        requestId: "request_retry",
        providerAttemptId: "attempt_retry_old",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 1,
        totalTokens: 1
      },
      {
        id: "usage_retry_new",
        organizationId: "org_admin_retry",
        workspaceId,
        requestId: "request_retry",
        providerAttemptId: "attempt_retry_new",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 9,
        totalTokens: 9
      }
    ]);

    const requestsPage = await fixture.persistence.adminQueries.forScope("org_admin_retry", workspaceId).requests();
    const detail = await fixture.persistence.adminQueries.forScope("org_admin_retry", workspaceId).requestDetail("request_retry");

    expect(requestsPage.data).toHaveLength(1);
    expect(requestsPage.data[0]?.terminalStatus).toBe("completed");
    expect(requestsPage.data[0]?.usage.totalTokens).toBe(9);
    expect(requestsPage.data[0]?.translated).toBe(true);
    expect(requestsPage.data[0]).toMatchObject({
      requestedLogicalModel: "coding-auto",
      resolvedLogicalModelId: `${workspaceId}:logical-model:coding-auto`,
      deploymentId: gateway.deploymentId,
      providerConnectionId: gateway.providerConnectionId,
      routerDecisionId: "router_decision_retry"
    });
    expect(detail.request?.terminalStatus).toBe("completed");
    expect(detail.routeDecisions).toEqual([
      expect.objectContaining({
        requestedLogicalModel: "coding-auto",
        deploymentId: gateway.deploymentId,
        providerConnectionId: gateway.providerConnectionId,
        routerDecisionId: "router_decision_retry",
        routerDecision: { confidence: 0.88, reason: "coding_workload" },
        translated: true,
        translatorId: "openai-responses_to_anthropic-messages"
      })
    ]);
    expect(detail.providerAttempts.map((attempt) => ({
      id: attempt.id,
      deploymentId: attempt.deploymentId,
      providerConnectionId: attempt.providerConnectionId,
      egressWireId: attempt.egressWireId,
      providerAdapterContractVersion: attempt.providerAdapterContractVersion
    }))).toEqual([
      {
        id: "attempt_retry_old",
        ...gateway.attemptEvidence
      },
      {
        id: "attempt_retry_new",
        ...gateway.attemptEvidence
      }
    ]);
  });

  async function persistenceFixture(organizationId: string) {
    client = new PGlite();
    const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
    const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrationFiles) {
      await client.exec(await readFile(join(migrationsDir, file), "utf8"));
    }
    const db = createPgliteDatabase(client);
    const config = loadConfig({
      ...process.env,
      DEFAULT_ORGANIZATION_ID: organizationId
    });
    const persistence = createDatabasePersistence(db, config, false);
    return { db, config, persistence };
  }

  async function appendHealthRequest(eventService: EventService, requestId: string, idempotencyKey: string) {
    await eventService.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "test",
      eventType: "proxy.request_received",
      payload: {
        surface: "anthropic-messages",
        requestedModel: "coding-auto",
        inputHash: `sha256:${requestId}`,
        inputChars: 10
      }
    });
  }

  async function appendHealthStarted(
    eventService: EventService,
    requestId: string,
    idempotencyKey: string,
    attemptEvidence: Record<string, unknown>
  ) {
    await eventService.append({
      scopeType: "request",
      scopeId: requestId,
      correlationId: requestId,
      idempotencyKey,
      producer: "test",
      eventType: "provider.request_started",
      payload: {
        surface: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        providerAttemptId: `attempt_${requestId}`,
        ...attemptEvidence
      }
    });
  }

  async function seedHealthGateway(
    fixture: Awaited<ReturnType<typeof persistenceFixture>>,
    organizationId: string
  ) {
    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: organizationId,
      SEED_USER_ID: `${organizationId}:user`,
      SEED_USER_NAME: "Persistence Test User",
      PROXY_TOKEN: `${organizationId}:token`
    }));
    const workspaceId = defaultWorkspaceId(organizationId);
    const deploymentId = `${workspaceId}:deployment:anthropic:claude-sonnet-4-5`;
    const providerConnectionId = `${workspaceId}:connection:anthropic`;
    return {
      deploymentId,
      providerConnectionId,
      attemptEvidence: {
        deploymentId,
        providerConnectionId,
        egressWireId: "anthropic-messages" as const,
        providerAdapterContractVersion: "1" as const
      }
    };
  }
});

function routeContext(): RouteContext {
  return {
    surface: "openai-responses",
    requestedModel: "coding-auto",
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
