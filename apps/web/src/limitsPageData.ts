import { formatCompact, formatMoney } from "./format";
import type { LimitsDashboardViewQuery } from "./gql/graphql";

export type LimitsDashboard = LimitsDashboardViewQuery["limitsDashboard"];
export type BudgetWindow = LimitsDashboard["budgetWindows"][number];
export type PolicyRow = { id: string; subject: string; subjectId: string; policy: unknown; updatedAt: string };
export type RejectionEvent = LimitsDashboard["rejectionEvents"][number];

export function peakBudgetWindow(windows: BudgetWindow[]) {
  return windows.reduce<BudgetWindow | undefined>((current, row) => {
    if (!current) return row;
    return windowCommitted(row) > windowCommitted(current) ? row : current;
  }, undefined);
}

export function windowCommitted(window: BudgetWindow) {
  return window.actualUsd + window.reservedUsd;
}

export function workspacePolicyRows(dashboard: LimitsDashboard): PolicyRow[] {
  return dashboard.workspacePolicies.map((policy) => ({
    id: policy.id,
    subject: "Workspace",
    subjectId: policy.workspaceId,
    policy: policy.policy,
    updatedAt: policy.updatedAt
  }));
}

export function apiKeyPolicyRows(dashboard: LimitsDashboard): PolicyRow[] {
  return dashboard.apiKeyPolicies.map((policy) => ({
    id: policy.id,
    subject: policy.apiKeyName,
    subjectId: policy.apiKeyId,
    policy: policy.policy,
    updatedAt: policy.updatedAt
  }));
}

export function policyLimits(value: unknown) {
  const policy = recordValue(value);
  if (!policy) return ["invalid"];
  const limits: string[] = [];
  addNumericLimit(limits, policy.requestsPerMinute, "rpm");
  addNumericLimit(limits, policy.tokensPerMinute, "tpm");
  addNumericLimit(limits, policy.parallelRequests, "parallel");
  const budget = recordValue(policy.budget);
  if (budget) {
    addMoneyLimit(limits, budget.dailyUsd, "daily");
    addMoneyLimit(limits, budget.weeklyUsd, "weekly");
    addMoneyLimit(limits, budget.monthlyUsd, "monthly");
  }
  return limits.length > 0 ? limits : ["empty"];
}

export function rejectionSummary(event: RejectionEvent) {
  const payload = recordValue(event.payload);
  if (!payload) return event.eventType;
  if (event.eventType === "budget.rejected") {
    const projected = numberValue(payload.currentUsd) + numberValue(payload.reservedUsd) + numberValue(payload.estimatedCostUsd);
    return `${stringValue(payload.windowType) ?? "budget"} ${formatMoney(projected)} / ${formatMoney(numberValue(payload.limitUsd))}`;
  }
  return `${stringValue(payload.limitType) ?? stringValue(payload.reason) ?? "limit"} ${formatCompact(numberValue(payload.current))} / ${formatCompact(numberValue(payload.limit))}`;
}

function addNumericLimit(labels: string[], value: unknown, suffix: string) {
  if (typeof value === "number") labels.push(`${formatCompact(value)} ${suffix}`);
}

function addMoneyLimit(labels: string[], value: unknown, prefix: string) {
  if (typeof value === "number") labels.push(`${prefix} ${formatMoney(value)}`);
}

function numberValue(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
