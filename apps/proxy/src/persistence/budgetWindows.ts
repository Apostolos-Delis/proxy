import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";

import {
  defaultWorkspaceId,
  budgetReservations,
  budgetWindows,
  requests,
  type PromptProxyDbSession,
  type PromptProxyTransaction
} from "@prompt-proxy/db";
import type { LimitBudgetPolicy } from "@prompt-proxy/schema";

import { createId } from "../util.js";
import { usageCostMicros } from "../pricing.js";
import { LimitPolicyResolver } from "./limitPolicies.js";
import { catalogPricingForModel } from "./modelPricing.js";

type BudgetWindowType = "daily" | "weekly" | "monthly";

export type BudgetReservationEntry = {
  reservationId: string;
  scopeType: string;
  scopeId: string;
  windowType: BudgetWindowType;
  periodStartAt: string;
  periodEndAt: string;
  limitUsd: string;
  reservedUsd: string;
};

export type BudgetReservationRejection = {
  reason: "budget_limit";
  scopeType: string;
  scopeId: string;
  windowType: BudgetWindowType;
  currentUsd: string;
  reservedUsd: string;
  limitUsd: string;
  resetAt: string;
};

export type BudgetSignal = {
  eventType: "budget.warning_emitted" | "budget.exceeded";
  workspaceId: string;
  payload: {
    reason: "budget_warning" | "budget_exceeded";
    scopeType: string;
    scopeId: string;
    windowType: BudgetWindowType;
    periodStartAt: string;
    periodEndAt: string;
    limitUsd: string;
    actualUsd: string;
    reservedUsd: string;
    committedUsd: string;
    warningThreshold?: number;
    thresholdUsd?: string;
    resetAt: string;
  };
};

export class BudgetReservationRejectedError extends Error {
  statusCode = 429;

  constructor(readonly rejection: BudgetReservationRejection) {
    super("budget_limit");
  }
}

export class BudgetSignalAlreadyEmittedError extends Error {
  constructor() {
    super("budget_signal_already_emitted");
  }
}

export class BudgetWindowService {
  constructor(private readonly db: PromptProxyDbSession) {}

  async planRequestReservation(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string | null;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    at: Date;
  }) {
    const pricing = await catalogPricingForModel(this.db, input.organizationId, input.provider, input.model);
    const costs = usageCostMicros(pricing, {
      inputTokens: input.inputTokens,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: input.outputTokens
    });
    const entries = await this.planReservation({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      apiKeyId: input.apiKeyId,
      estimatedCostMicros: costs.totalCostMicros,
      at: input.at
    });
    const rejection = await this.budgetRejection(input.organizationId, input.workspaceId, entries);
    return {
      estimatedCostMicros: costs.totalCostMicros,
      entries,
      rejection
    };
  }

  async planReservation(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string | null;
    estimatedCostMicros: number;
    at: Date;
  }) {
    if (input.estimatedCostMicros <= 0) return [];
    const policies = await new LimitPolicyResolver(this.db).resolve({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      apiKeyId: input.apiKeyId ?? undefined
    });
    const reservedUsd = usdFromMicros(input.estimatedCostMicros);
    const entries = [
      ...reservationEntries({
        scopeType: "workspace",
        scopeId: input.workspaceId,
        budget: policies.workspacePolicy?.budget,
        reservedUsd,
        at: input.at
      })
    ];
    if (input.apiKeyId) {
      entries.push(...reservationEntries({
        scopeType: "api_key",
        scopeId: input.apiKeyId,
        budget: policies.apiKeyPolicy?.budget,
        reservedUsd,
        at: input.at
      }));
    }
    return entries;
  }

  async projectReservation(input: {
    organizationId: string;
    workspaceId: string;
    requestId: string;
    entries: BudgetReservationEntry[];
    at: Date;
  }) {
    await this.db.execute(sql`lock table budget_windows in exclusive mode`);
    const rejection = await this.budgetRejection(input.organizationId, input.workspaceId, input.entries);
    if (rejection) throw new BudgetReservationRejectedError(rejection);
    for (const entry of input.entries) {
      const inserted = await this.db
        .insert(budgetReservations)
        .values({
          id: entry.reservationId,
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          scopeType: entry.scopeType,
          scopeId: entry.scopeId,
          windowType: entry.windowType,
          periodStartAt: new Date(entry.periodStartAt),
          periodEndAt: new Date(entry.periodEndAt),
          reservedUsd: entry.reservedUsd,
          createdAt: input.at
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) continue;
      await this.upsertBudgetWindow({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: entry.scopeType,
        scopeId: entry.scopeId,
        windowType: entry.windowType,
        periodStartAt: new Date(entry.periodStartAt),
        periodEndAt: new Date(entry.periodEndAt),
        limitUsd: entry.limitUsd,
        reservedUsdDelta: entry.reservedUsd,
        at: input.at
      });
    }
  }

  async releaseReservationsForRequest(input: {
    organizationId: string;
    requestId: string;
    at: Date;
  }) {
    const rows = await this.db
      .select()
      .from(budgetReservations)
      .where(and(
        eq(budgetReservations.organizationId, input.organizationId),
        eq(budgetReservations.requestId, input.requestId),
        isNull(budgetReservations.releasedAt)
      ));
    for (const row of rows) {
      const released = await this.db
        .update(budgetReservations)
        .set({ releasedAt: input.at })
        .where(and(
          eq(budgetReservations.id, row.id),
          isNull(budgetReservations.releasedAt)
        ))
        .returning();
      if (released.length === 0) continue;
      await this.db
        .update(budgetWindows)
        .set({
          reservedUsd: sql`greatest(0::numeric, ${budgetWindows.reservedUsd} - ${row.reservedUsd})`,
          updatedAt: input.at
        })
        .where(and(
          eq(budgetWindows.organizationId, row.organizationId),
          eq(budgetWindows.workspaceId, row.workspaceId),
          eq(budgetWindows.scopeType, row.scopeType),
          eq(budgetWindows.scopeId, row.scopeId),
          eq(budgetWindows.windowType, row.windowType),
          eq(budgetWindows.periodStartAt, row.periodStartAt)
        ));
    }
  }

  async recordActualSpend(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string | null;
    costMicros: number;
    at: Date;
  }) {
    if (input.costMicros <= 0) return;
    const policies = await new LimitPolicyResolver(this.db).resolve({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      apiKeyId: input.apiKeyId ?? undefined
    });
    const costUsd = usdFromMicros(input.costMicros);
    await this.recordPolicyWindows({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      scopeType: "workspace",
      scopeId: input.workspaceId,
      budget: policies.workspacePolicy?.budget,
      costUsd,
      at: input.at
    });
    if (!input.apiKeyId) return;
    await this.recordPolicyWindows({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      scopeType: "api_key",
      scopeId: input.apiKeyId,
      budget: policies.apiKeyPolicy?.budget,
      costUsd,
      at: input.at
    });
  }

  async pendingSignalsForRequest(input: {
    organizationId: string;
    requestId: string;
    at: Date;
  }): Promise<BudgetSignal[]> {
    const [request] = await this.db
      .select({
        workspaceId: requests.workspaceId,
        apiKeyId: requests.apiKeyId
      })
      .from(requests)
      .where(and(
        eq(requests.organizationId, input.organizationId),
        eq(requests.id, input.requestId)
      ))
      .limit(1);
    if (!request) return [];

    const policies = await new LimitPolicyResolver(this.db).resolve({
      organizationId: input.organizationId,
      workspaceId: request.workspaceId,
      apiKeyId: request.apiKeyId ?? undefined
    });
    const rows = await this.db
      .select()
      .from(budgetWindows)
      .where(and(
        eq(budgetWindows.organizationId, input.organizationId),
        eq(budgetWindows.workspaceId, request.workspaceId),
        lte(budgetWindows.periodStartAt, input.at),
        gt(budgetWindows.periodEndAt, input.at)
      ));
    const signals: BudgetSignal[] = [];

    for (const row of rows) {
      const budget = budgetForSignal(row.scopeType, row.scopeId, request.workspaceId, request.apiKeyId, {
        workspace: policies.workspacePolicy?.budget,
        apiKey: policies.apiKeyPolicy?.budget
      });
      if (!budget) continue;
      const committedUsd = Number(row.actualUsd) + Number(row.reservedUsd);
      const limitUsd = Number(row.limitUsd);
      if (budget.warningThreshold !== undefined && !row.warningEmittedAt) {
        const thresholdUsd = limitUsd * budget.warningThreshold;
        if (committedUsd >= thresholdUsd) {
          signals.push(budgetSignal(row, "budget.warning_emitted", "budget_warning", {
            warningThreshold: budget.warningThreshold,
            thresholdUsd: usdAmount(thresholdUsd),
            committedUsd
          }));
        }
      }
      if (!row.exceededEmittedAt && committedUsd >= limitUsd) {
        signals.push(budgetSignal(row, "budget.exceeded", "budget_exceeded", { committedUsd }));
      }
    }

    return signals;
  }

  private async recordPolicyWindows(input: {
    organizationId: string;
    workspaceId: string;
    scopeType: string;
    scopeId: string;
    budget: LimitBudgetPolicy | undefined;
    costUsd: string;
    at: Date;
  }) {
    if (!input.budget) return;
    await this.recordWindow({
      ...input,
      windowType: "daily",
      limitUsd: input.budget.dailyUsd,
      resetTimeUtc: input.budget.resetTimeUtc
    });
    await this.recordWindow({
      ...input,
      windowType: "weekly",
      limitUsd: input.budget.weeklyUsd,
      resetTimeUtc: input.budget.resetTimeUtc
    });
    await this.recordWindow({
      ...input,
      windowType: "monthly",
      limitUsd: input.budget.monthlyUsd,
      resetTimeUtc: input.budget.resetTimeUtc
    });
  }

  private async recordWindow(input: {
    organizationId: string;
    workspaceId: string;
    scopeType: string;
    scopeId: string;
    windowType: BudgetWindowType;
    limitUsd: number | undefined;
    resetTimeUtc?: string;
    costUsd: string;
    at: Date;
  }) {
    if (input.limitUsd === undefined) return;
    const period = budgetPeriod(input.windowType, input.at, input.resetTimeUtc);
    await this.upsertBudgetWindow({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      windowType: input.windowType,
      periodStartAt: period.start,
      periodEndAt: period.end,
      limitUsd: usdAmount(input.limitUsd),
      actualUsdDelta: input.costUsd,
      at: input.at
    });
  }

  private async upsertBudgetWindow(input: {
    organizationId: string;
    workspaceId: string;
    scopeType: string;
    scopeId: string;
    windowType: BudgetWindowType;
    periodStartAt: Date;
    periodEndAt: Date;
    limitUsd: string;
    reservedUsdDelta?: string;
    actualUsdDelta?: string;
    at: Date;
  }) {
    await this.db
      .insert(budgetWindows)
      .values({
        id: createId("budget_window"),
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        windowType: input.windowType,
        periodStartAt: input.periodStartAt,
        periodEndAt: input.periodEndAt,
        limitUsd: input.limitUsd,
        reservedUsd: input.reservedUsdDelta ?? "0",
        actualUsd: input.actualUsdDelta ?? "0",
        updatedAt: input.at
      })
      .onConflictDoUpdate({
        target: [
          budgetWindows.organizationId,
          budgetWindows.workspaceId,
          budgetWindows.scopeType,
          budgetWindows.scopeId,
          budgetWindows.windowType,
          budgetWindows.periodStartAt
        ],
        set: {
          limitUsd: input.limitUsd,
          reservedUsd: input.reservedUsdDelta
            ? sql`${budgetWindows.reservedUsd} + ${input.reservedUsdDelta}`
            : budgetWindows.reservedUsd,
          actualUsd: input.actualUsdDelta
            ? sql`${budgetWindows.actualUsd} + ${input.actualUsdDelta}`
            : budgetWindows.actualUsd,
          updatedAt: input.at
        }
      });
  }

  private async budgetRejection(
    organizationId: string,
    workspaceId: string,
    entries: BudgetReservationEntry[]
  ): Promise<BudgetReservationRejection | undefined> {
    for (const entry of entries) {
      const [row] = await this.db
        .select({
          reservedUsd: budgetWindows.reservedUsd,
          actualUsd: budgetWindows.actualUsd
        })
        .from(budgetWindows)
        .where(and(
          eq(budgetWindows.organizationId, organizationId),
          eq(budgetWindows.workspaceId, workspaceId),
          eq(budgetWindows.scopeType, entry.scopeType),
          eq(budgetWindows.scopeId, entry.scopeId),
          eq(budgetWindows.windowType, entry.windowType),
          eq(budgetWindows.periodStartAt, new Date(entry.periodStartAt))
        ))
        .limit(1);
      const currentUsd = Number(row?.actualUsd ?? 0) + Number(row?.reservedUsd ?? 0);
      const nextUsd = currentUsd + Number(entry.reservedUsd);
      const limitUsd = Number(entry.limitUsd);
      if (nextUsd > limitUsd) {
        return {
          reason: "budget_limit",
          scopeType: entry.scopeType,
          scopeId: entry.scopeId,
          windowType: entry.windowType,
          currentUsd: usdAmount(currentUsd),
          reservedUsd: entry.reservedUsd,
          limitUsd: entry.limitUsd,
          resetAt: entry.periodEndAt
        };
      }
    }
    return undefined;
  }
}

export async function persistBudgetSignal(tx: PromptProxyTransaction, event: {
  tenantId: string;
  workspaceId?: string;
  createdAt: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  const payload = budgetSignalPayload(event.payload);
  if (!payload) return;
  const markerAt = new Date(event.createdAt);
  const where = and(
    eq(budgetWindows.organizationId, event.tenantId),
    eq(budgetWindows.workspaceId, event.workspaceId ?? defaultWorkspaceId(event.tenantId)),
    eq(budgetWindows.scopeType, payload.scopeType),
    eq(budgetWindows.scopeId, payload.scopeId),
    eq(budgetWindows.windowType, payload.windowType),
    eq(budgetWindows.periodStartAt, payload.periodStartAt)
  );

  if (event.eventType === "budget.warning_emitted") {
    const updated = await tx
      .update(budgetWindows)
      .set({
        warningEmittedAt: markerAt,
        updatedAt: markerAt
      })
      .where(and(where, isNull(budgetWindows.warningEmittedAt)))
      .returning();
    if (updated.length === 0) throw new BudgetSignalAlreadyEmittedError();
    return;
  }

  if (event.eventType === "budget.exceeded") {
    const updated = await tx
      .update(budgetWindows)
      .set({
        exceededEmittedAt: markerAt,
        updatedAt: markerAt
      })
      .where(and(where, isNull(budgetWindows.exceededEmittedAt)))
      .returning();
    if (updated.length === 0) throw new BudgetSignalAlreadyEmittedError();
  }
}

export async function persistBudgetReserved(tx: PromptProxyTransaction, event: {
  tenantId: string;
  workspaceId?: string;
  scopeId: string;
  createdAt: string;
  payload: Record<string, unknown>;
}) {
  const entries = Array.isArray(event.payload.entries)
    ? event.payload.entries.map(reservationEntry).filter((entry): entry is BudgetReservationEntry => entry !== undefined)
    : [];
  if (entries.length === 0) return;
  await new BudgetWindowService(tx).projectReservation({
    organizationId: event.tenantId,
    workspaceId: event.workspaceId ?? defaultWorkspaceId(event.tenantId),
    requestId: event.scopeId,
    entries,
    at: new Date(event.createdAt)
  });
}

export function budgetPeriod(windowType: BudgetWindowType, at: Date, resetTimeUtc = "00:00") {
  if (windowType === "daily") return dailyPeriod(at, resetTimeUtc);
  if (windowType === "weekly") return weeklyPeriod(at, resetTimeUtc);
  return monthlyPeriod(at, resetTimeUtc);
}

function dailyPeriod(at: Date, resetTimeUtc: string) {
  const { hour, minute } = parseResetTime(resetTimeUtc);
  let start = new Date(Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    hour,
    minute
  ));
  if (at < start) start = addUtcDays(start, -1);
  return { start, end: addUtcDays(start, 1) };
}

function weeklyPeriod(at: Date, resetTimeUtc: string) {
  const { hour, minute } = parseResetTime(resetTimeUtc);
  const mondayOffset = (at.getUTCDay() + 6) % 7;
  let start = new Date(Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate() - mondayOffset,
    hour,
    minute
  ));
  if (at < start) start = addUtcDays(start, -7);
  return { start, end: addUtcDays(start, 7) };
}

function monthlyPeriod(at: Date, resetTimeUtc: string) {
  const { hour, minute } = parseResetTime(resetTimeUtc);
  let start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, hour, minute));
  if (at < start) start = addUtcMonths(start, -1);
  return { start, end: addUtcMonths(start, 1) };
}

function reservationEntries(input: {
  scopeType: string;
  scopeId: string;
  budget: LimitBudgetPolicy | undefined;
  reservedUsd: string;
  at: Date;
}) {
  const budget = input.budget;
  if (!budget) return [];
  const entries: BudgetReservationEntry[] = [];
  const withBudget = { ...input, budget };
  addReservationEntry(entries, withBudget, "daily", budget.dailyUsd);
  addReservationEntry(entries, withBudget, "weekly", budget.weeklyUsd);
  addReservationEntry(entries, withBudget, "monthly", budget.monthlyUsd);
  return entries;
}

function reservationEntry(value: unknown): BudgetReservationEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const windowType = record.windowType;
  if (windowType !== "daily" && windowType !== "weekly" && windowType !== "monthly") return undefined;
  const entry = {
    reservationId: stringValue(record.reservationId),
    scopeType: stringValue(record.scopeType),
    scopeId: stringValue(record.scopeId),
    windowType,
    periodStartAt: stringValue(record.periodStartAt),
    periodEndAt: stringValue(record.periodEndAt),
    limitUsd: stringValue(record.limitUsd),
    reservedUsd: stringValue(record.reservedUsd)
  };
  if (
    !entry.reservationId ||
    !entry.scopeType ||
    !entry.scopeId ||
    !entry.periodStartAt ||
    !entry.periodEndAt ||
    !entry.limitUsd ||
    !entry.reservedUsd
  ) {
    return undefined;
  }
  return entry as BudgetReservationEntry;
}

function budgetSignalPayload(value: Record<string, unknown>) {
  const windowType = value.windowType;
  if (windowType !== "daily" && windowType !== "weekly" && windowType !== "monthly") return undefined;
  const periodStartAtValue = stringValue(value.periodStartAt);
  const periodStartAt = periodStartAtValue ? new Date(periodStartAtValue) : undefined;
  const scopeType = stringValue(value.scopeType);
  const scopeId = stringValue(value.scopeId);
  if (!scopeType || !scopeId || !periodStartAt || Number.isNaN(periodStartAt.getTime())) return undefined;
  return {
    scopeType,
    scopeId,
    windowType,
    periodStartAt
  };
}

function budgetForSignal(
  scopeType: string,
  scopeId: string,
  workspaceId: string,
  apiKeyId: string | null,
  policies: {
    workspace?: LimitBudgetPolicy;
    apiKey?: LimitBudgetPolicy;
  }
) {
  if (scopeType === "workspace" && scopeId === workspaceId) return policies.workspace;
  if (scopeType === "api_key" && apiKeyId && scopeId === apiKeyId) return policies.apiKey;
  return undefined;
}

function budgetSignal(
  row: typeof budgetWindows.$inferSelect,
  eventType: BudgetSignal["eventType"],
  reason: BudgetSignal["payload"]["reason"],
  options: {
    committedUsd: number;
    warningThreshold?: number;
    thresholdUsd?: string;
  }
): BudgetSignal {
  return {
    eventType,
    workspaceId: row.workspaceId,
    payload: {
      reason,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      windowType: row.windowType as BudgetWindowType,
      periodStartAt: row.periodStartAt.toISOString(),
      periodEndAt: row.periodEndAt.toISOString(),
      limitUsd: row.limitUsd,
      actualUsd: row.actualUsd,
      reservedUsd: row.reservedUsd,
      committedUsd: usdAmount(options.committedUsd),
      ...(options.warningThreshold === undefined ? {} : { warningThreshold: options.warningThreshold }),
      ...(options.thresholdUsd === undefined ? {} : { thresholdUsd: options.thresholdUsd }),
      resetAt: row.periodEndAt.toISOString()
    }
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function addReservationEntry(
  entries: BudgetReservationEntry[],
  input: {
    scopeType: string;
    scopeId: string;
    budget: LimitBudgetPolicy;
    reservedUsd: string;
    at: Date;
  },
  windowType: BudgetWindowType,
  limitUsd: number | undefined
) {
  if (limitUsd === undefined) return;
  const period = budgetPeriod(windowType, input.at, input.budget.resetTimeUtc);
  entries.push({
    reservationId: createId("budget_reservation"),
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    windowType,
    periodStartAt: period.start.toISOString(),
    periodEndAt: period.end.toISOString(),
    limitUsd: usdAmount(limitUsd),
    reservedUsd: input.reservedUsd
  });
}

function parseResetTime(resetTimeUtc: string) {
  const [hour = "0", minute = "0"] = resetTimeUtc.split(":");
  return {
    hour: Number(hour),
    minute: Number(minute)
  };
}

function addUtcDays(date: Date, days: number) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + days,
    date.getUTCHours(),
    date.getUTCMinutes()
  ));
}

function addUtcMonths(date: Date, months: number) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    1,
    date.getUTCHours(),
    date.getUTCMinutes()
  ));
}

function usdFromMicros(costMicros: number) {
  return (costMicros / 1_000_000).toFixed(6);
}

function usdAmount(value: number) {
  return value.toFixed(6);
}
