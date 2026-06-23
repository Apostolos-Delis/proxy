import { and, eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeyLimitPolicies,
  budgetReservations,
  budgetWindows,
  defaultWorkspaceId,
  events,
  modelCatalog,
  providers,
  routingConfigVersions,
  workspaceLimitPolicies
} from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";

import { EventService } from "../src/events.js";
import { appendBudgetSignalEvents } from "../src/limitEvents.js";
import { BudgetWindowService, budgetPeriod } from "../src/persistence/budgetWindows.js";
import type { RouteContext } from "../src/types.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("budget windows", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("records measure-only workspace and API-key spend into active budget windows", async () => {
    const organizationId = "org_budget_windows";
    const workspaceId = defaultWorkspaceId(organizationId);
    const apiKeyId = `${organizationId}:api-key:default`;
    const at = new Date("2026-06-19T11:30:00.000Z");
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_budget_policy",
      organizationId,
      workspaceId,
      policy: {
        budget: {
          dailyUsd: 10,
          weeklyUsd: 50,
          monthlyUsd: 150,
          resetTimeUtc: "12:30"
        }
      }
    });
    await activeFixture.db.insert(apiKeyLimitPolicies).values({
      id: "api_key_budget_policy",
      organizationId,
      workspaceId,
      apiKeyId,
      policy: {
        budget: {
          dailyUsd: 5,
          resetTimeUtc: "12:30"
        }
      }
    });

    const service = new BudgetWindowService(activeFixture.db);
    await service.recordActualSpend({
      organizationId,
      workspaceId,
      apiKeyId,
      costMicros: 2_500_000,
      at
    });
    await service.recordActualSpend({
      organizationId,
      workspaceId,
      apiKeyId,
      costMicros: 500_000,
      at: new Date("2026-06-19T11:45:00.000Z")
    });

    const rows = await activeFixture.db
      .select()
      .from(budgetWindows)
      .where(and(
        eq(budgetWindows.organizationId, organizationId),
        eq(budgetWindows.workspaceId, workspaceId)
      ));
    const workspaceDaily = rows.find((row) =>
      row.scopeType === "workspace" && row.windowType === "daily"
    );
    const apiKeyDaily = rows.find((row) =>
      row.scopeType === "api_key" && row.windowType === "daily"
    );

    expect(rows).toHaveLength(4);
    expect(workspaceDaily).toMatchObject({
      scopeId: workspaceId,
      limitUsd: "10.000000",
      periodStartAt: new Date("2026-06-18T12:30:00.000Z"),
      periodEndAt: new Date("2026-06-19T12:30:00.000Z")
    });
    expect(Number(workspaceDaily?.actualUsd)).toBe(3);
    expect(apiKeyDaily).toMatchObject({
      scopeId: apiKeyId,
      limitUsd: "5.000000",
      periodStartAt: new Date("2026-06-18T12:30:00.000Z"),
      periodEndAt: new Date("2026-06-19T12:30:00.000Z")
    });
    expect(Number(apiKeyDaily?.actualUsd)).toBe(3);
  });

  it("computes UTC daily, weekly, and monthly periods from reset time", () => {
    const at = new Date("2026-06-01T11:00:00.000Z");

    expect(budgetPeriod("daily", at, "12:00")).toEqual({
      start: new Date("2026-05-31T12:00:00.000Z"),
      end: new Date("2026-06-01T12:00:00.000Z")
    });
    expect(budgetPeriod("weekly", at, "12:00")).toEqual({
      start: new Date("2026-05-25T12:00:00.000Z"),
      end: new Date("2026-06-01T12:00:00.000Z")
    });
    expect(budgetPeriod("monthly", at, "12:00")).toEqual({
      start: new Date("2026-05-01T12:00:00.000Z"),
      end: new Date("2026-06-01T12:00:00.000Z")
    });
  });

  it("projects and releases budget reservations for request true-up", async () => {
    const organizationId = "org_budget_reservations";
    const workspaceId = defaultWorkspaceId(organizationId);
    const at = new Date("2026-06-19T12:00:00.000Z");
    activeFixture = await captureFixture(organizationId);
    await activeFixture.persistence.requestStates.begin(
      "idem_budget_reservation",
      "request_budget_reservation",
      routeContext()
    );
    await activeFixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_budget_reservation_policy",
      organizationId,
      workspaceId,
      policy: {
        budget: {
          dailyUsd: 10
        }
      }
    });

    const service = new BudgetWindowService(activeFixture.db);
    const entries = await service.planReservation({
      organizationId,
      workspaceId,
      estimatedCostMicros: 1_250_000,
      at
    });
    const eventService = new EventService(undefined, undefined, activeFixture.persistence.eventSink, organizationId);
    await eventService.append({
      tenantId: organizationId,
      workspaceId,
      scopeType: "request",
      scopeId: "request_budget_reservation",
      idempotencyKey: "idem_budget_reservation",
      producer: "test",
      eventType: "budget.reserved",
      payload: {
        entries
      }
    });

    const [reservedWindow] = await activeFixture.db.select().from(budgetWindows);
    const [reservation] = await activeFixture.db.select().from(budgetReservations);
    expect(Number(reservedWindow?.reservedUsd)).toBe(1.25);
    expect(reservation).toMatchObject({
      requestId: "request_budget_reservation",
      releasedAt: null
    });

    await service.releaseReservationsForRequest({
      organizationId,
      requestId: "request_budget_reservation",
      at: new Date("2026-06-19T12:01:00.000Z")
    });

    const [releasedWindow] = await activeFixture.db.select().from(budgetWindows);
    const [releasedReservation] = await activeFixture.db.select().from(budgetReservations);
    expect(Number(releasedWindow?.reservedUsd)).toBe(0);
    expect(releasedReservation?.releasedAt).toEqual(new Date("2026-06-19T12:01:00.000Z"));
  });

  it("reserves and releases budget around a proxied provider request", async () => {
    const organizationId = "org_budget_runtime";
    const workspaceId = defaultWorkspaceId(organizationId);
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_budget_runtime_policy",
      organizationId,
      workspaceId,
      policy: {
        budget: {
          dailyUsd: 10,
          warningThreshold: 0
        }
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        input: "explain budget reservation true-up",
        max_output_tokens: 16
      })
    });

    expect(response.status).toBe(200);
    await response.text();
    const [window] = await activeFixture.db.select().from(budgetWindows);
    const [reservation] = await activeFixture.db.select().from(budgetReservations);
    const [reservedEvent] = await activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "budget.reserved"));
    const [warningEvent] = await activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "budget.warning_emitted"));

    expect(reservedEvent?.producer).toBe("prompt-proxy.budgets");
    expect(warningEvent?.producer).toBe("prompt-proxy.budgets");
    expect(Number(window?.reservedUsd)).toBe(0);
    expect(Number(window?.actualUsd)).toBeGreaterThan(0);
    expect(window?.warningEmittedAt).toBeTruthy();
    expect(reservation?.releasedAt).toBeTruthy();
  });

  it("rejects budget reservations using route target output settings", async () => {
    const organizationId = "org_budget_route_output_cap";
    const workspaceId = defaultWorkspaceId(organizationId);
    activeFixture = await captureFixture(organizationId);
    await setDefaultHardOutputCap(activeFixture, organizationId, 200);
    await insertHardRoutePricingOverrides(activeFixture, organizationId);
    await activeFixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_budget_route_output_cap_policy",
      organizationId,
      workspaceId,
      policy: {
        budget: {
          dailyUsd: 0.001
        }
      }
    });

    const providerRecordsBefore = activeFixture.openai.records.length + activeFixture.anthropic.records.length;
    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        input: "budget boundary request",
        max_output_tokens: 1
      })
    });
    const body = await response.json() as Record<string, unknown>;
    const rejectionEvents = await activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "budget.rejected"));

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "budget_limit",
      scopeType: "workspace",
      limitUsd: "0.001000"
    });
    expect(Number(body.estimatedCostMicros)).toBeGreaterThanOrEqual(2000);
    expect(activeFixture.openai.records.length + activeFixture.anthropic.records.length).toBe(providerRecordsBefore);
    expect(rejectionEvents).toHaveLength(1);
    expect(rejectionEvents[0]?.payload).toMatchObject({
      reason: "budget_limit",
      reservedUsd: "0.002000",
      limitUsd: "0.001000"
    });
  });

  it("emits budget warning and exceeded signals once for true-up windows", async () => {
    const organizationId = "org_budget_signals";
    const workspaceId = defaultWorkspaceId(organizationId);
    const requestId = "request_budget_signals";
    const idempotencyKey = "idem_budget_signals";
    const at = new Date("2026-06-19T12:00:00.000Z");
    activeFixture = await captureFixture(organizationId);
    await activeFixture.persistence.requestStates.begin(
      idempotencyKey,
      requestId,
      routeContext()
    );
    await activeFixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_budget_signal_policy",
      organizationId,
      workspaceId,
      policy: {
        budget: {
          dailyUsd: 10,
          warningThreshold: 0.5
        }
      }
    });

    const service = new BudgetWindowService(activeFixture.db);
    await service.recordActualSpend({
      organizationId,
      workspaceId,
      costMicros: 6_000_000,
      at
    });

    const eventService = new EventService(undefined, undefined, activeFixture.persistence.eventSink, organizationId);
    const warningSignals = await service.pendingSignalsForRequest({ organizationId, requestId, at });
    expect(warningSignals.map((signal) => signal.eventType)).toEqual(["budget.warning_emitted"]);
    await appendBudgetSignalEvents({
      events: eventService,
      organizationId,
      requestId,
      idempotencyKey,
      signals: warningSignals
    });
    await appendBudgetSignalEvents({
      events: eventService,
      organizationId,
      requestId,
      idempotencyKey,
      signals: warningSignals
    });

    const [warnedWindow] = await activeFixture.db.select().from(budgetWindows);
    const warningEventsAfterDuplicate = await activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "budget.warning_emitted"));
    expect(warnedWindow?.warningEmittedAt).toBeTruthy();
    expect(warnedWindow?.exceededEmittedAt).toBeNull();
    expect(warningEventsAfterDuplicate).toHaveLength(1);
    await expect(service.pendingSignalsForRequest({ organizationId, requestId, at })).resolves.toEqual([]);

    await service.recordActualSpend({
      organizationId,
      workspaceId,
      costMicros: 5_000_000,
      at: new Date("2026-06-19T12:01:00.000Z")
    });
    const exceededSignals = await service.pendingSignalsForRequest({
      organizationId,
      requestId,
      at: new Date("2026-06-19T12:01:00.000Z")
    });
    expect(exceededSignals.map((signal) => signal.eventType)).toEqual(["budget.exceeded"]);
    await appendBudgetSignalEvents({
      events: eventService,
      organizationId,
      requestId,
      idempotencyKey,
      signals: exceededSignals
    });

    const [exceededWindow] = await activeFixture.db.select().from(budgetWindows);
    const warningEvents = await activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "budget.warning_emitted"));
    const exceededEvents = await activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "budget.exceeded"));

    expect(Number(exceededWindow?.actualUsd)).toBe(11);
    expect(exceededWindow?.warningEmittedAt).toBeTruthy();
    expect(exceededWindow?.exceededEmittedAt).toBeTruthy();
    expect(warningEvents).toHaveLength(1);
    expect(exceededEvents).toHaveLength(1);
    await expect(service.pendingSignalsForRequest({
      organizationId,
      requestId,
      at: new Date("2026-06-19T12:01:00.000Z")
    })).resolves.toEqual([]);
  });

  it("rejects a proxied provider request when reservation would exceed budget", async () => {
    const organizationId = "org_budget_reject";
    const workspaceId = defaultWorkspaceId(organizationId);
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(workspaceLimitPolicies).values({
      id: "workspace_budget_reject_policy",
      organizationId,
      workspaceId,
      policy: {
        budget: {
          dailyUsd: 0.000001
        }
      }
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-hard",
        input: "explain budget rejection",
        max_output_tokens: 4096
      })
    });
    const body = await response.json() as Record<string, unknown>;
    const rejectedEvents = await activeFixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "budget.rejected"));

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      error: "budget_limit",
      scopeType: "workspace",
      scopeId: workspaceId,
      windowType: "daily",
      limitUsd: "0.000001"
    });
    expect(rejectedEvents).toHaveLength(1);
    expect(activeFixture.openai.records.filter((record) => record.body.type === "response.create")).toHaveLength(0);
    await expect(activeFixture.db.select().from(budgetReservations)).resolves.toEqual([]);
  });
});

async function setDefaultHardOutputCap(
  fixture: PromptTestFixture,
  organizationId: string,
  maxOutputTokens: number
) {
  const versionId = `${organizationId}:routing-config:default:v1`;
  const [version] = await fixture.db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, versionId))
    .limit(1);
  expect(version).toBeTruthy();
  const config = structuredClone(version!.config as RoutingConfig);
  config.routes.hard = {
    ...config.routes.hard,
    targets: config.routes.hard.targets.map((target) => ({ ...target, maxOutputTokens }))
  };
  await fixture.db
    .update(routingConfigVersions)
    .set({ config })
    .where(eq(routingConfigVersions.id, versionId));
}

async function insertHardRoutePricingOverrides(
  fixture: PromptTestFixture,
  organizationId: string
) {
  await fixture.db.insert(modelCatalog).values([
    {
      id: `${organizationId}:model-pricing:anthropic-hard`,
      organizationId,
      providerId: await builtinProviderId(fixture, "anthropic"),
      model: "claude-sonnet-4-5",
      capabilities: {},
      pricing: { inputCostPerMtok: 0, outputCostPerMtok: 10 }
    },
    {
      id: `${organizationId}:model-pricing:openai-hard`,
      organizationId,
      providerId: await builtinProviderId(fixture, "openai"),
      model: "gpt-5.5",
      capabilities: {},
      pricing: { inputCostPerMtok: 0, outputCostPerMtok: 10 }
    }
  ]);
}

async function builtinProviderId(fixture: PromptTestFixture, slug: string) {
  const [provider] = await fixture.db
    .select({ id: providers.id })
    .from(providers)
    .where(and(isNull(providers.organizationId), eq(providers.slug, slug)))
    .limit(1);
  expect(provider).toBeTruthy();
  return provider!.id;
}

function routeContext(): RouteContext {
  return {
    surface: "openai-responses",
    requestedModel: "router-auto",
    inputChars: 10,
    inputHash: "sha256:budget-reservation",
    estimatedInputTokens: 3,
    routingInputSource: "latest_user_message",
    routingInputText: "test",
    routingInputChars: 4,
    routingInputHash: "sha256:budget-reservation-routing",
    routingEstimatedInputTokens: 1,
    hasTools: false,
    toolCount: 0,
    hasPreviousResponseId: false,
    hasImages: false,
    extractedHints: [],
    routingExtractedHints: []
  };
}
