import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPgliteDatabase,
  defaultWorkspaceId,
  eventOutbox,
  events,
  providerAttempts,
  requests,
  routeDecisions
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";

import { loadConfig } from "../src/config.js";
import { EventService } from "../src/events.js";
import { createDatabasePersistence } from "../src/persistence/index.js";

describe("gateway resolution evidence persistence", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("projects complete evidence and rolls back invalid evidence atomically", async () => {
    const fixture = await setup("org_gateway_evidence");
    client = fixture.client;
    const eventService = new EventService(
      undefined,
      undefined,
      fixture.persistence.eventSink,
      fixture.organizationId
    );
    const admissionEvidence = {
      ingressWireId: "openai-responses" as const,
      operationId: "text.generate" as const,
      requestedLogicalModel: "fable"
    };
    const resolutionEvidence = {
      ...admissionEvidence,
      resolvedLogicalModelId: `${fixture.workspaceId}:logical-model:fable`,
      accessProfileId: `${fixture.workspaceId}:access-profile:opendoor-engineer`,
      routerKind: null,
      deploymentId: `${fixture.workspaceId}:deployment:anthropic:claude-fable-5`,
      providerConnectionId: `${fixture.workspaceId}:connection:anthropic`,
      egressWireId: "anthropic-messages" as const,
      wireAdapterVersion: "1"
    };
    const attemptEvidence = {
      deploymentId: resolutionEvidence.deploymentId,
      providerConnectionId: resolutionEvidence.providerConnectionId,
      egressWireId: resolutionEvidence.egressWireId,
      providerAdapterContractVersion: "1"
    };

    await appendRequest(eventService, "request_evidence", "idem_evidence", admissionEvidence);
    await appendDecision(eventService, "request_evidence", "idem_evidence", resolutionEvidence);
    await appendProviderStart(eventService, "request_evidence", "idem_evidence", "attempt_evidence", attemptEvidence);
    await eventService.append({
      scopeType: "request",
      scopeId: "request_evidence",
      correlationId: "request_evidence",
      idempotencyKey: "idem_evidence",
      producer: "test",
      eventType: "provider.response_completed",
      payload: {
        providerAttemptId: "attempt_evidence",
        upstreamStatus: 200,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12
        }
      }
    });

    const [request] = await fixture.db.select().from(requests).where(eq(requests.id, "request_evidence"));
    const [decision] = await fixture.db
      .select()
      .from(routeDecisions)
      .where(eq(routeDecisions.requestId, "request_evidence"));
    const [attempt] = await fixture.db
      .select()
      .from(providerAttempts)
      .where(eq(providerAttempts.id, "attempt_evidence"));
    const eventRows = await fixture.db.select().from(events).where(eq(events.scopeId, "request_evidence"));
    const outboxRows = await fixture.db.select().from(eventOutbox);

    expect(request).toMatchObject({
      ...resolutionEvidence,
      status: "completed"
    });
    expect(decision).toMatchObject(resolutionEvidence);
    expect(attempt).toMatchObject(attemptEvidence);
    expect(eventRows.map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
    expect(outboxRows).toHaveLength(4);
    expect(eventRows.every((row) => !hasRawPromptField(row.payload))).toBe(true);

    await expect(appendRequest(eventService, "request_invalid", "idem_invalid", {
      ingressWireId: "openai-responses"
    })).rejects.toThrow("Invalid gateway resolution evidence payload.");
    expect(await fixture.db.select().from(requests).where(eq(requests.id, "request_invalid"))).toEqual([]);

    await appendRequest(eventService, "request_rollback", "idem_rollback", admissionEvidence);
    const mismatchedResolution = {
      ...resolutionEvidence,
      providerConnectionId: `${fixture.workspaceId}:connection:openai`
    };
    await expect(appendDecision(
      eventService,
      "request_rollback",
      "idem_rollback",
      mismatchedResolution
    )).rejects.toThrow();

    const [requestAfterDecisionRollback] = await fixture.db
      .select()
      .from(requests)
      .where(eq(requests.id, "request_rollback"));
    expect(requestAfterDecisionRollback).toMatchObject(admissionEvidence);
    expect(requestAfterDecisionRollback?.resolvedLogicalModelId).toBeNull();
    expect(await fixture.db
      .select()
      .from(routeDecisions)
      .where(eq(routeDecisions.requestId, "request_rollback"))).toEqual([]);

    await appendRequest(eventService, "request_denied", "idem_denied", admissionEvidence);
    await eventService.append({
      scopeType: "request",
      scopeId: "request_denied",
      correlationId: "request_denied",
      idempotencyKey: "idem_denied",
      producer: "test",
      eventType: "routing.decision_recorded",
      payload: {
        outcome: "reject",
        requestedModel: "fable",
        error: "model_unavailable",
        policyVersion: "gateway-v1",
        ...admissionEvidence
      }
    });
    const [deniedDecision] = await fixture.db
      .select()
      .from(routeDecisions)
      .where(eq(routeDecisions.requestId, "request_denied"));
    expect(deniedDecision).toMatchObject(admissionEvidence);
    expect(deniedDecision?.resolvedLogicalModelId).toBeNull();

    await appendDecision(eventService, "request_rollback", "idem_rollback", resolutionEvidence);
    await expect(appendProviderStart(
      eventService,
      "request_rollback",
      "idem_rollback",
      "attempt_rollback",
      {
        ...attemptEvidence,
        providerConnectionId: `${fixture.workspaceId}:connection:openai`
      }
    )).rejects.toThrow();

    const [requestAfterAttemptRollback] = await fixture.db
      .select()
      .from(requests)
      .where(eq(requests.id, "request_rollback"));
    const rollbackEvents = await fixture.db
      .select()
      .from(events)
      .where(eq(events.scopeId, "request_rollback"));
    expect(requestAfterAttemptRollback?.status).toBe("received");
    expect(await fixture.db
      .select()
      .from(providerAttempts)
      .where(eq(providerAttempts.id, "attempt_rollback"))).toEqual([]);
    expect(rollbackEvents.map((row) => row.sequence)).toEqual([1, 2]);

    await appendProviderStart(
      eventService,
      "request_rollback",
      "idem_rollback",
      "attempt_rollback",
      attemptEvidence
    );
    const retargetEvidence = {
      deploymentId: `${fixture.workspaceId}:deployment:openai:gpt-5.4-mini`,
      providerConnectionId: `${fixture.workspaceId}:connection:openai`,
      egressWireId: "openai-responses",
      providerAdapterContractVersion: "1"
    };
    await expect(appendProviderTerminal(
      eventService,
      "request_rollback",
      "idem_rollback",
      "attempt_rollback",
      retargetEvidence
    )).rejects.toThrow("Provider terminal evidence does not match the provider attempt target.");
    await expect(eventService.append({
      tenantId: "org_gateway_evidence_other",
      workspaceId: defaultWorkspaceId("org_gateway_evidence_other"),
      scopeType: "request",
      scopeId: "request_rollback",
      correlationId: "request_rollback",
      idempotencyKey: "idem_rollback",
      producer: "test",
      eventType: "provider.response_completed",
      payload: {
        providerAttemptId: "attempt_rollback",
        upstreamStatus: 200
      }
    })).rejects.toThrow("Provider terminal event does not match a scoped provider attempt.");

    const [attemptAfterTerminalRollbacks] = await fixture.db
      .select()
      .from(providerAttempts)
      .where(eq(providerAttempts.id, "attempt_rollback"));
    const [requestAfterTerminalRollbacks] = await fixture.db
      .select()
      .from(requests)
      .where(eq(requests.id, "request_rollback"));
    const finalRollbackEvents = await fixture.db
      .select()
      .from(events)
      .where(eq(events.scopeId, "request_rollback"));
    expect(attemptAfterTerminalRollbacks).toMatchObject({
      ...attemptEvidence,
      terminalStatus: "pending"
    });
    expect(requestAfterTerminalRollbacks?.status).toBe("provider_pending");
    expect(finalRollbackEvents.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(await fixture.db.select().from(eventOutbox)).toHaveLength(9);
  });
});

async function appendRequest(
  eventService: EventService,
  requestId: string,
  idempotencyKey: string,
  evidence: Record<string, unknown>
) {
  return eventService.append({
    scopeType: "request",
    scopeId: requestId,
    correlationId: requestId,
    idempotencyKey,
    producer: "test",
    eventType: "proxy.request_received",
    payload: {
      surface: "openai-responses",
      requestedModel: "fable",
      inputHash: `sha256:${requestId}`,
      inputChars: 10,
      ...evidence
    }
  });
}

async function appendDecision(
  eventService: EventService,
  requestId: string,
  idempotencyKey: string,
  evidence: Record<string, unknown>
) {
  return eventService.append({
    scopeType: "request",
    scopeId: requestId,
    correlationId: requestId,
    idempotencyKey,
    producer: "test",
    eventType: "routing.decision_recorded",
    payload: {
      outcome: "route",
      requestedModel: "fable",
      selectedModel: "claude-fable-5",
      provider: "anthropic",
      policyVersion: "gateway-v1",
      ...evidence
    }
  });
}

async function appendProviderStart(
  eventService: EventService,
  requestId: string,
  idempotencyKey: string,
  providerAttemptId: string,
  evidence: Record<string, unknown>
) {
  return eventService.append({
    scopeType: "request",
    scopeId: requestId,
    correlationId: requestId,
    idempotencyKey,
    producer: "test",
    eventType: "provider.request_started",
    payload: {
      surface: "openai-responses",
      provider: "anthropic",
      model: "claude-fable-5",
      providerAttemptId,
      ...evidence
    }
  });
}

async function appendProviderTerminal(
  eventService: EventService,
  requestId: string,
  idempotencyKey: string,
  providerAttemptId: string,
  evidence: Record<string, unknown>
) {
  return eventService.append({
    scopeType: "request",
    scopeId: requestId,
    correlationId: requestId,
    idempotencyKey,
    producer: "test",
    eventType: "provider.response_completed",
    payload: {
      providerAttemptId,
      upstreamStatus: 200,
      ...evidence
    }
  });
}

function hasRawPromptField(payload: Record<string, unknown>) {
  return Object.keys(payload).some((key) => ["prompt", "rawPrompt", "rawText", "routingInputText"].includes(key));
}

async function setup(organizationId: string) {
  const client = await migratedClient();
  const db = createPgliteDatabase(client);
  const env = {
    ...process.env,
    ALLOW_DEV_PROXY_TOKEN_FALLBACK: "false",
    DEFAULT_ORGANIZATION_ID: organizationId,
    PROXY_TOKEN: `token_${organizationId}`,
    SEED_EXTERNAL_ECONOMY_TOKEN: undefined,
    SEED_USER_ID: `user_${organizationId}`,
    SEED_USER_NAME: "Local User"
  };
  const config = loadConfig(env);
  await seedDatabase(db, seedOptionsFromEnv(env));
  return {
    client,
    db,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    persistence: createDatabasePersistence(db, config, false)
  };
}

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  return client;
}
