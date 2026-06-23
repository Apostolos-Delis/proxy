export type PreflightDecision = {
  id: string;
  eventId: string;
  eventType: string;
  kind: string;
  status: string;
  scopeType?: string;
  scopeId?: string;
  limitType?: string;
  windowType?: string;
  current?: number;
  reserved?: number;
  limit?: number;
  estimatedCost?: number;
  resetAt?: string;
  createdAt: string;
  payload: unknown;
};

type EventLike = {
  eventId: string;
  eventType: string;
  createdAt: string;
  payload: unknown;
};

const LIMIT_EVENT_TYPES = new Set([
  "limit.request_rate_rejected",
  "limit.token_rate_rejected",
  "limit.parallel_rejected"
]);

export function preflightDecisionsForEvents(events: EventLike[]) {
  return events.flatMap((event) => {
    if (LIMIT_EVENT_TYPES.has(event.eventType)) return limitDecision(event);
    if (event.eventType === "budget.reserved") return budgetReservedDecisions(event);
    if (event.eventType === "budget.rejected") return budgetRejectedDecision(event);
    return [];
  });
}

function limitDecision(event: EventLike): PreflightDecision[] {
  const payload = objectPayload(event.payload);
  if (!payload) return [];
  return [{
    id: event.eventId,
    eventId: event.eventId,
    eventType: event.eventType,
    kind: stringValue(payload.limitType) ?? stringValue(payload.reason) ?? "limit",
    status: "rejected",
    scopeType: stringValue(payload.scope),
    limitType: stringValue(payload.limitType),
    current: numberValue(payload.current),
    limit: numberValue(payload.limit),
    resetAt: stringValue(payload.resetAt),
    createdAt: event.createdAt,
    payload: event.payload
  }];
}

function budgetReservedDecisions(event: EventLike): PreflightDecision[] {
  const payload = objectPayload(event.payload);
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return entries.flatMap((entry, index) => {
    const record = objectPayload(entry);
    if (!record) return [];
    return [{
      id: `${event.eventId}:${index}`,
      eventId: event.eventId,
      eventType: event.eventType,
      kind: "budget",
      status: "reserved",
      scopeType: stringValue(record.scopeType),
      scopeId: stringValue(record.scopeId),
      windowType: stringValue(record.windowType),
      reserved: numberValue(record.reservedUsd),
      limit: numberValue(record.limitUsd),
      estimatedCost: numberValue(payload?.estimatedCostUsd),
      resetAt: stringValue(record.periodEndAt),
      createdAt: event.createdAt,
      payload: {
        estimatedCostMicros: payload?.estimatedCostMicros,
        estimatedCostUsd: payload?.estimatedCostUsd,
        entry: record
      }
    }];
  });
}

function budgetRejectedDecision(event: EventLike): PreflightDecision[] {
  const payload = objectPayload(event.payload);
  if (!payload) return [];
  return [{
    id: event.eventId,
    eventId: event.eventId,
    eventType: event.eventType,
    kind: "budget",
    status: "rejected",
    scopeType: stringValue(payload.scopeType),
    scopeId: stringValue(payload.scopeId),
    windowType: stringValue(payload.windowType),
    current: numberValue(payload.currentUsd),
    reserved: numberValue(payload.reservedUsd),
    limit: numberValue(payload.limitUsd),
    estimatedCost: numberValue(payload.estimatedCostUsd),
    resetAt: stringValue(payload.resetAt),
    createdAt: event.createdAt,
    payload: event.payload
  }];
}

function objectPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
