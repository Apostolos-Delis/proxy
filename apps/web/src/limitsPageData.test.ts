import { describe, expect, it } from "vitest";

import { peakBudgetWindow, policyLimits, rejectionSummary, type BudgetWindow, type RejectionEvent } from "./limitsPageData";

function budgetWindow(id: string, actualUsd: number, reservedUsd: number): BudgetWindow {
  return {
    id,
    scopeType: "workspace",
    scopeId: "workspace_1",
    windowType: "daily",
    periodEndAt: "2026-06-20T00:00:00.000Z",
    limitUsd: 10,
    actualUsd,
    reservedUsd
  };
}

describe("limits page data", () => {
  it("selects the peak budget window instead of summing overlapping windows", () => {
    expect(peakBudgetWindow([
      budgetWindow("daily", 2, 1),
      budgetWindow("weekly", 8, 0.5),
      budgetWindow("monthly", 4, 2)
    ])?.id).toBe("weekly");
  });

  it("summarizes policy caps", () => {
    expect(policyLimits({
      requestsPerMinute: 120,
      tokensPerMinute: 200000,
      parallelRequests: 5,
      budget: { dailyUsd: 25 }
    })).toEqual(["120 rpm", "200K tpm", "5 parallel", "daily $25.00"]);
  });

  it("includes rejected estimated spend in budget rejection summaries", () => {
    const summary = rejectionSummary({
      eventId: "event_1",
      eventType: "budget.rejected",
      scopeId: "request_1",
      createdAt: "2026-06-19T12:00:00.000Z",
      payload: {
        windowType: "daily",
        currentUsd: "9",
        reservedUsd: "0.25",
        estimatedCostUsd: "0.5",
        limitUsd: "10"
      }
    } as RejectionEvent);

    expect(summary).toContain("$9.75");
    expect(summary).toContain("$10.00");
  });
});
