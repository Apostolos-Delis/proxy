import { and, desc, eq, inArray } from "drizzle-orm";

import {
  providerAttempts,
  requests,
  usageLedger,
  type PromptProxyDbSession,
  type PromptProxyTransaction,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";

import { jsonPayload, type RequestState, type RequestStateGate, type RequestStateStoreLike } from "../events.js";
import type { RouteContext } from "../types.js";
import { createId } from "../util.js";
import { ensureOrganization, ensureSession, ensureUser } from "./identity.js";
import { numberValue, routingConfigSnapshotValue, stringValue, surfaceValue } from "./values.js";

export class PersistentRequestStateStore implements RequestStateStoreLike {
  constructor(
    private readonly db: PromptProxyTransactionalDatabase,
    private readonly readDb: PromptProxyDbSession,
    private readonly organizationId: string
  ) {}

  async begin(
    idempotencyKey: string,
    requestId = createId("request"),
    context?: unknown
  ): Promise<RequestStateGate> {
    const routeContext = isRouteContext(context) ? context : undefined;
    const organizationId = routeContext?.organizationId ?? this.organizationId;
    const existing = await this.findRequest(idempotencyKey, organizationId);
    if (existing) {
      const status = requestStateStatus(existing.status);
      if (status === "classifying" || status === "provider_pending") {
        return {
          state: await this.stateForRequest(existing),
          duplicate: true
        };
      }
      const claimed = await this.readDb
        .update(requests)
        .set({ status: "classifying", completedAt: null })
        .where(and(
          eq(requests.organizationId, existing.organizationId),
          eq(requests.idempotencyKey, idempotencyKey),
          inArray(requests.status, ["failed", "cancelled", "completed"])
        ))
        .returning();
      if (claimed.length === 0) {
        const current = await this.findRequest(idempotencyKey, organizationId);
        return {
          state: await this.stateForRequest(current ?? existing),
          duplicate: true
        };
      }
      return {
        state: { idempotencyKey, requestId: existing.id, status: "classifying" },
        duplicate: false
      };
    }

    await this.db.transaction(async (tx) => {
      await ensureOrganization(tx, organizationId);
      const sessionId = await ensureSession(tx, {
        organizationId,
        surface: routeContext?.surface,
        sessionId: routeContext?.sessionId,
        requestId,
        userId: routeContext?.userId
      });
      await ensureUser(tx, routeContext?.userId);
      await tx
        .insert(requests)
        .values({
          id: requestId,
          organizationId,
          userId: routeContext?.userId,
          sessionId,
          apiKeyId: routeContext?.apiKeyId,
          surface: routeContext?.surface ?? "openai-responses",
          idempotencyKey,
          requestedModel: routeContext?.requestedModel ?? "unknown",
          inputHash: routeContext?.inputHash ?? "unknown",
          inputChars: routeContext?.inputChars ?? 0,
          estimatedInputTokens: routeContext?.estimatedInputTokens,
          routingInputHash: routeContext?.routingInputHash,
          routingInputChars: routeContext?.routingInputChars,
          routingEstimatedInputTokens: routeContext?.routingEstimatedInputTokens,
          status: "classifying"
        })
        .onConflictDoNothing();
    });

    const stored = await this.findRequest(idempotencyKey, organizationId);
    if (!stored) {
      return {
        state: { idempotencyKey, requestId, status: "classifying" },
        duplicate: false
      };
    }

    return {
      state: await this.stateForRequest(stored),
      duplicate: stored.id !== requestId
    };
  }

  async markProviderPending(idempotencyKey: string, providerAttemptId: string) {
    const request = await this.findRequest(idempotencyKey);
    if (!request) return undefined;
    await this.readDb
      .update(requests)
      .set({ status: "provider_pending" })
      .where(and(eq(requests.organizationId, request.organizationId), eq(requests.idempotencyKey, idempotencyKey)));
    return {
      idempotencyKey,
      requestId: request.id,
      status: "provider_pending" as const,
      providerAttemptId
    };
  }

  async finish(idempotencyKey: string, status: RequestState["status"], patch: Partial<RequestState> = {}) {
    const terminal = status !== "classifying" && status !== "provider_pending";
    const request = await this.findRequest(idempotencyKey);
    if (!request) return undefined;
    if (terminal && patch.providerAttemptId) {
      return this.stateForRequest(request);
    }

    await this.readDb
      .update(requests)
      .set(terminal ? { status, completedAt: new Date() } : { status })
      .where(and(eq(requests.organizationId, request.organizationId), eq(requests.idempotencyKey, idempotencyKey)));
    return {
      ...patch,
      idempotencyKey,
      requestId: request.id,
      status
    };
  }

  private async findRequest(idempotencyKey: string, organizationId?: string) {
    const query = this.readDb
      .select()
      .from(requests)
      .where(organizationId
        ? and(eq(requests.organizationId, organizationId), eq(requests.idempotencyKey, idempotencyKey))
        : eq(requests.idempotencyKey, idempotencyKey))
      .limit(1);
    const [request] = await query;
    return request;
  }

  private async stateForRequest(request: typeof requests.$inferSelect): Promise<RequestState> {
    const [attempt] = await this.readDb
      .select()
      .from(providerAttempts)
      .where(and(eq(providerAttempts.organizationId, request.organizationId), eq(providerAttempts.requestId, request.id)))
      .orderBy(desc(providerAttempts.startedAt))
      .limit(1);
    const [usage] = attempt
      ? await this.readDb
          .select()
          .from(usageLedger)
          .where(eq(usageLedger.providerAttemptId, attempt.id))
          .limit(1)
      : [];

    return {
      idempotencyKey: request.idempotencyKey,
      requestId: request.id,
      status: requestStateStatus(request.status),
      providerAttemptId: attempt?.id,
      usage: usage?.usage ? jsonPayload(usage.usage) : undefined,
      upstreamRequestId: attempt?.upstreamRequestId ?? undefined,
      error: attempt?.error ?? undefined
    };
  }
}

export async function persistRequestReceived(tx: PromptProxyTransaction, event: {
  tenantId: string;
  scopeId: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
  payloadHash: string;
}) {
  const payload = event.payload;
  const userId = stringValue(payload.userId);
  const surface = surfaceValue(payload.surface);
  const sessionId = stringValue(payload.sessionId);
  const apiKeyId = stringValue(payload.apiKeyId);
  await ensureUser(tx, userId);
  const dbSessionId = await ensureSession(tx, {
    organizationId: event.tenantId,
    surface,
    sessionId,
    requestId: event.scopeId,
    userId
  });

  await tx
    .insert(requests)
    .values({
      id: event.scopeId,
      organizationId: event.tenantId,
      userId,
      sessionId: dbSessionId,
      apiKeyId,
      surface: surface ?? "openai-responses",
      idempotencyKey: event.idempotencyKey ?? event.scopeId,
      requestedModel: stringValue(payload.requestedModel) ?? "unknown",
      inputHash: stringValue(payload.inputHash) ?? event.payloadHash,
      inputChars: numberValue(payload.inputChars) ?? 0,
      status: "received",
      metadata: payload
    })
    .onConflictDoUpdate({
      target: [requests.organizationId, requests.idempotencyKey],
      set: {
        userId,
        sessionId: dbSessionId,
        apiKeyId,
        requestedModel: stringValue(payload.requestedModel) ?? "unknown",
        inputHash: stringValue(payload.inputHash) ?? event.payloadHash,
        inputChars: numberValue(payload.inputChars) ?? 0,
        metadata: payload
      }
    });
}

export async function persistRoutingContext(tx: PromptProxyTransaction, event: {
  scopeId: string;
  payload: Record<string, unknown>;
}) {
  const payload = event.payload;
  const routingConfig = routingConfigSnapshotValue(payload.routingConfig);
  await tx
    .update(requests)
    .set({
      estimatedInputTokens: numberValue(payload.estimatedInputTokens),
      routingInputHash: stringValue(payload.routingInputHash),
      routingInputChars: numberValue(payload.routingInputChars),
      routingEstimatedInputTokens: numberValue(payload.routingEstimatedInputTokens),
      routingConfigId: routingConfig?.configId,
      routingConfigVersionId: routingConfig?.versionId,
      routingConfigVersion: routingConfig?.version,
      routingConfigHash: routingConfig?.configHash,
      status: "classifying",
      metadata: payload
    })
    .where(eq(requests.id, event.scopeId));
}

function requestStateStatus(status: string): RequestState["status"] {
  if (status === "provider_pending") return "provider_pending";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "classifying";
}

function isRouteContext(value: unknown): value is RouteContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return surfaceValue(record.surface) !== undefined;
}
