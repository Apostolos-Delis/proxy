import {
  actorForIdentity,
  type RequestIdentity
} from "./auth.js";
import { jsonPayload, type EventService } from "./events.js";
import type {
  BudgetReservationEntry,
  BudgetReservationRejection,
  BudgetSignal
} from "./persistence/budgetWindows.js";
import { BudgetSignalAlreadyEmittedError } from "./persistence/budgetWindows.js";
import type { JsonObject } from "./types.js";

export type LimitRejected = {
  reason: "parallel_request_limit" | "request_rate_limit" | "token_rate_limit";
  scope: "workspace" | "api_key";
  current: number;
  limit: number;
  resetAt: string;
};

const LIMIT_REJECTION_EVENT_TYPES: Record<LimitRejected["reason"], string> = {
  parallel_request_limit: "limit.parallel_rejected",
  request_rate_limit: "limit.request_rate_rejected",
  token_rate_limit: "limit.token_rate_rejected"
};

const LIMIT_REJECTION_TYPES: Record<LimitRejected["reason"], string> = {
  parallel_request_limit: "parallel_requests",
  request_rate_limit: "requests_per_minute",
  token_rate_limit: "tokens_per_minute"
};

export function appendLimitRejectedEvent(input: {
  events: EventService;
  identity: RequestIdentity;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  rejection: LimitRejected;
}) {
  return input.events.append({
    tenantId: input.identity.organizationId,
    workspaceId: input.identity.workspaceId,
    scopeType: "request",
    scopeId: input.requestId,
    sessionId: input.sessionId,
    correlationId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    actor: actorForIdentity(input.identity),
    producer: "prompt-proxy.limits",
    eventType: LIMIT_REJECTION_EVENT_TYPES[input.rejection.reason],
    payload: {
      reason: input.rejection.reason,
      limitType: LIMIT_REJECTION_TYPES[input.rejection.reason],
      scope: input.rejection.scope,
      current: input.rejection.current,
      limit: input.rejection.limit,
      resetAt: input.rejection.resetAt
    }
  });
}

export function appendBudgetReservedEvent(input: {
  events: EventService;
  identity: RequestIdentity;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  entries: BudgetReservationEntry[];
  estimatedCostMicros: number;
}) {
  return input.events.append({
    tenantId: input.identity.organizationId,
    workspaceId: input.identity.workspaceId,
    scopeType: "request",
    scopeId: input.requestId,
    sessionId: input.sessionId,
    correlationId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    actor: actorForIdentity(input.identity),
    producer: "prompt-proxy.budgets",
    eventType: "budget.reserved",
    payload: {
      estimatedCostMicros: input.estimatedCostMicros,
      estimatedCostUsd: (input.estimatedCostMicros / 1_000_000).toFixed(6),
      entries: input.entries
    }
  });
}

export function appendBudgetRejectedEvent(input: {
  events: EventService;
  identity: RequestIdentity;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  rejection: BudgetReservationRejection;
  estimatedCostMicros: number;
}) {
  return input.events.append({
    tenantId: input.identity.organizationId,
    workspaceId: input.identity.workspaceId,
    scopeType: "request",
    scopeId: input.requestId,
    sessionId: input.sessionId,
    correlationId: input.requestId,
    idempotencyKey: input.idempotencyKey,
      actor: actorForIdentity(input.identity),
      producer: "prompt-proxy.budgets",
      eventType: "budget.rejected",
    payload: {
      reason: input.rejection.reason,
      scopeType: input.rejection.scopeType,
      scopeId: input.rejection.scopeId,
      windowType: input.rejection.windowType,
      currentUsd: input.rejection.currentUsd,
      reservedUsd: input.rejection.reservedUsd,
      limitUsd: input.rejection.limitUsd,
      resetAt: input.rejection.resetAt,
      estimatedCostMicros: input.estimatedCostMicros,
      estimatedCostUsd: (input.estimatedCostMicros / 1_000_000).toFixed(6)
    }
  });
}

export async function appendBudgetSignalEvents(input: {
  events: EventService;
  organizationId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  signals: BudgetSignal[];
}) {
  for (const signal of input.signals) {
    try {
      await input.events.append({
        tenantId: input.organizationId,
        workspaceId: signal.workspaceId,
        scopeType: "request",
        scopeId: input.requestId,
        sessionId: input.sessionId,
        correlationId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        producer: "prompt-proxy.budgets",
        eventType: signal.eventType,
        payload: jsonPayload(signal.payload) as JsonObject
      });
    } catch (error) {
      if (!(error instanceof BudgetSignalAlreadyEmittedError)) throw error;
    }
  }
}
