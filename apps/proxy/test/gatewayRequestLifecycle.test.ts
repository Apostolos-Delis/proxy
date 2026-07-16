import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  defaultWorkspaceId,
  deploymentWireBindings,
  eventOutbox,
  events as eventRows,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  providerAttempts,
  requests
} from "@proxy/db";
import { providerCapabilitiesWithDefaults } from "@proxy/schema";

import type { RequestIdentity } from "../src/auth.js";
import {
  ProviderAttemptStore,
  RequestStateStore,
  type EventAppender,
  type RequestStateStoreLike
} from "../src/events.js";
import { gatewayRouteDecision, type GatewayExecutionTarget } from "../src/gatewayRuntime.js";
import { GatewayRequestLifecycle, type PreparedGatewayRequest } from "../src/gatewayRequestLifecycle.js";
import { NoopMetricsCollector } from "../src/metrics.js";
import type { RouteContext } from "../src/types.js";

import { captureFixture } from "./promptTestFixture.js";

describe("gateway request lifecycle", () => {
  it("terminalizes a failed attempt startup so the same idempotency key can retry", async () => {
    const attempts = new ProviderAttemptStore();
    const requestStates = new RequestStateStore();
    let failStartedEvent = true;
    const events: EventAppender = {
      async append(input) {
        if (input.eventType === "provider.request_started" && failStartedEvent) {
          failStartedEvent = false;
          throw new Error("event_store_unavailable");
        }
      }
    };
    const lifecycle = new GatewayRequestLifecycle(
      undefined,
      events,
      attempts,
      requestStates,
      new NoopMetricsCollector()
    );
    const input = providerAttemptInput();
    requestStates.begin(input.idempotencyKey, input.requestId);

    await expect(lifecycle.startProviderAttempt(input)).rejects.toThrow("event_store_unavailable");
    expect(attempts.list()).toEqual([
      expect.objectContaining({ terminalStatus: "failed", error: "event_store_unavailable" })
    ]);
    expect(requestStates.get(input.idempotencyKey)).toEqual(expect.objectContaining({
      status: "failed",
      error: "event_store_unavailable"
    }));

    expect(requestStates.begin(input.idempotencyKey, input.requestId).duplicate).toBe(false);
    const retry = await lifecycle.startProviderAttempt(input);

    expect(retry.terminalStatus).toBe("pending");
    expect(attempts.list()).toEqual([
      expect.objectContaining({ terminalStatus: "failed" }),
      expect.objectContaining({ id: retry.id, terminalStatus: "pending" })
    ]);
    expect(requestStates.get(input.idempotencyKey)).toEqual(expect.objectContaining({
      status: "provider_pending",
      providerAttemptId: retry.id
    }));
  });

  it("persists a compensating event and outbox row when attempt start cannot be stored", async () => {
    const organizationId = "org_lifecycle_compensation";
    const { fixture, input } = await persistentProviderAttemptInput(organizationId);
    try {
      let failStart = true;
      const events: EventAppender = {
        append(event) {
          if (event.eventType === "provider.request_started" && failStart) {
            failStart = false;
            throw new Error("start_event_store_unavailable");
          }
          return fixture.persistence.eventService.append(event);
        }
      };
      const lifecycle = new GatewayRequestLifecycle(
        undefined,
        events,
        new ProviderAttemptStore(),
        fixture.persistence.requestStates,
        new NoopMetricsCollector()
      );

      await expect(lifecycle.startProviderAttempt(input)).rejects.toThrow("start_event_store_unavailable");
      const [request] = await fixture.db
        .select({ status: requests.status, completedAt: requests.completedAt })
        .from(requests)
        .where(eq(requests.id, input.requestId));
      const attempts = await fixture.db
        .select()
        .from(providerAttempts)
        .where(eq(providerAttempts.requestId, input.requestId));
      const [compensation] = await fixture.db
        .select({ id: eventRows.id })
        .from(eventRows)
        .where(eq(eventRows.eventType, "provider.request_start_failed"));
      const outbox = compensation
        ? await fixture.db
            .select({ eventId: eventOutbox.eventId, status: eventOutbox.status })
            .from(eventOutbox)
            .where(eq(eventOutbox.eventId, compensation.id))
        : [];
      expect(request).toMatchObject({ status: "failed", completedAt: expect.any(Date) });
      expect(attempts).toEqual([]);
      expect(compensation).toBeDefined();
      expect(outbox).toEqual([{ eventId: compensation!.id, status: "queued" }]);
    } finally {
      await fixture.close();
    }
  });

  it("continues with the event-projected start when the pending mirror fails", async () => {
    const { fixture, input } = await persistentProviderAttemptInput("org_lifecycle_pending_mirror");
    try {
      const persistent = fixture.persistence.requestStates;
      const requestStates: RequestStateStoreLike = {
        begin: (idempotencyKey, requestId, context) => persistent.begin(idempotencyKey, requestId, context),
        async markProviderPending() {
          throw new Error("pending_mirror_unavailable");
        },
        finish: (idempotencyKey, status, patch) => persistent.finish(idempotencyKey, status, patch)
      };
      const lifecycle = new GatewayRequestLifecycle(
        undefined,
        fixture.persistence.eventService,
        new ProviderAttemptStore(),
        requestStates,
        new NoopMetricsCollector()
      );

      const attempt = await lifecycle.startProviderAttempt(input);
      const [request] = await fixture.db
        .select({ status: requests.status })
        .from(requests)
        .where(eq(requests.id, input.requestId));
      const [storedAttempt] = await fixture.db
        .select({ status: providerAttempts.terminalStatus })
        .from(providerAttempts)
        .where(eq(providerAttempts.id, attempt.id));
      const compensation = await fixture.db
        .select()
        .from(eventRows)
        .where(eq(eventRows.eventType, "provider.request_start_failed"));
      expect(request?.status).toBe("provider_pending");
      expect(storedAttempt?.status).toBe("pending");
      expect(compensation).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

async function persistentProviderAttemptInput(organizationId: string) {
  const workspaceId = defaultWorkspaceId(organizationId);
  const fixture = await captureFixture(organizationId, "hash_only");
  const [row] = await fixture.db
    .select({
      logicalModelId: logicalModels.id,
      deploymentId: modelDeployments.id,
      providerConnectionId: modelDeployments.providerConnectionId,
      upstreamModelId: modelDeployments.upstreamModelId,
      bindingId: deploymentWireBindings.id
    })
    .from(logicalModels)
    .innerJoin(logicalModelTargets, eq(logicalModelTargets.logicalModelId, logicalModels.id))
    .innerJoin(modelDeployments, eq(modelDeployments.id, logicalModelTargets.deploymentId))
    .innerJoin(deploymentWireBindings, and(
      eq(deploymentWireBindings.deploymentId, modelDeployments.id),
      eq(deploymentWireBindings.apiWireId, "anthropic-messages")
    ))
    .where(and(
      eq(logicalModels.organizationId, organizationId),
      eq(logicalModels.workspaceId, workspaceId),
      eq(logicalModels.slug, "fable")
    ))
    .limit(1);
  if (!row) throw new Error("Missing persistent lifecycle target fixture.");

  const input = providerAttemptInput();
  input.identity.organizationId = organizationId;
  input.identity.workspaceId = workspaceId;
  input.identity.userId = "local-user";
  input.identity.apiKeyId = `${organizationId}:api-key:default`;
  input.identity.accessProfileId = `${workspaceId}:access-profile:opendoor-engineer`;
  input.requestId = `request_${organizationId}`;
  input.idempotencyKey = `idempotency_${organizationId}`;
  input.prepared.target = executionTarget({
    organizationId,
    workspaceId,
    accessProfileId: input.identity.accessProfileId,
    logicalModelId: row.logicalModelId,
    deploymentId: row.deploymentId,
    providerConnectionId: row.providerConnectionId,
    upstreamModelId: row.upstreamModelId,
    bindingId: row.bindingId
  });
  input.prepared.decision = gatewayRouteDecision(input.surface, input.prepared.target);
  await fixture.persistence.requestStates.begin(input.idempotencyKey, input.requestId, {
    ...input.context,
    organizationId,
    workspaceId,
    userId: input.identity.userId,
    apiKeyId: input.identity.apiKeyId
  });
  return { fixture, input };
}

function providerAttemptInput() {
  const identity: RequestIdentity = {
    organizationId: "org_lifecycle",
    workspaceId: "workspace_lifecycle",
    apiKeyId: "key_lifecycle",
    accessProfileId: "profile_lifecycle",
    accessProfileLimits: {},
    source: "api_key"
  };
  const context: RouteContext = {
    surface: "openai-responses",
    requestedModel: "fable",
    inputChars: 4,
    inputHash: "sha256:input",
    estimatedInputTokens: 1,
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
  const target = executionTarget();
  const prepared: PreparedGatewayRequest = {
    outcome: "resolved",
    target,
    body: { model: "gpt-test", input: "test" },
    decision: gatewayRouteDecision("openai-responses", target),
    promptCachePlan: {
      mode: "implicit",
      provider: "openai",
      dialect: "openai-responses",
      appliedControls: ["implicit_prefix_caching"],
      skippedControls: []
    },
    compressionTelemetry: {}
  };
  return {
    identity,
    context,
    requestId: "request_lifecycle",
    idempotencyKey: "idempotency_lifecycle",
    surface: "openai-responses" as const,
    prepared
  };
}

function executionTarget(input?: {
  organizationId: string;
  workspaceId: string;
  accessProfileId: string;
  logicalModelId: string;
  deploymentId: string;
  providerConnectionId: string;
  upstreamModelId: string;
  bindingId: string;
}): GatewayExecutionTarget {
  const organizationId = input?.organizationId ?? "org_lifecycle";
  const workspaceId = input?.workspaceId ?? "workspace_lifecycle";
  const accessProfileId = input?.accessProfileId ?? "profile_lifecycle";
  const logicalModelId = input?.logicalModelId ?? "logical_model_lifecycle";
  const deploymentId = input?.deploymentId ?? "deployment_lifecycle";
  const providerConnectionId = input?.providerConnectionId ?? "connection_lifecycle";
  const upstreamModelId = input?.upstreamModelId ?? "gpt-test";
  const bindingId = input?.bindingId ?? "binding_lifecycle";
  const endpoint = input
    ? { dialect: "anthropic-messages" as const, path: "/messages" }
    : { dialect: "openai-responses" as const, path: "/responses" };
  return {
    resolution: {
      outcome: "resolved",
      accessProfileId,
      logicalModelId,
      logicalModelSlug: "fable",
      routerKind: null,
      deploymentId,
      upstreamModelId,
      providerConnectionId,
      bindingId,
      egressWireId: endpoint.dialect,
      endpointPath: endpoint.path,
      providerAdapterKind: "generic-http-json",
      providerAdapterContractVersion: "1",
      wireAdapterId: null,
      wireAdapterVersion: null,
      routerDecisionId: null,
      routerDecision: null,
      parameterCaps: {}
    },
    provider: input ? "anthropic" : "openai",
    upstreamModelId,
    deploymentId,
    providerConnectionId,
    requestConfig: {},
    deploymentConfig: {},
    capabilities: {},
    providerEntry: {
      id: providerConnectionId,
      organizationId,
      workspaceId,
      provider: input ? "anthropic" : "openai",
      slug: input ? "anthropic" : "openai",
      baseUrl: input ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1",
      adapterKind: "generic-http-json",
      adapterConfig: {},
      authStyle: "none",
      endpoints: [endpoint],
      defaultHeaders: {},
      capabilities: providerCapabilitiesWithDefaults(input ? "anthropic" : "openai"),
      forwardHarnessHeaders: false,
      enabled: true,
      builtin: false
    },
    endpoint
  };
}
