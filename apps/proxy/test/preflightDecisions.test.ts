import { describe, expect, it } from "vitest";

import { preflightDecisionsForEvents } from "../src/preflightDecisions.js";

describe("preflight decisions", () => {
  it("normalizes limit rejection and budget reservation events", () => {
    const decisions = preflightDecisionsForEvents([
      {
        eventId: "event_limit",
        eventType: "limit.token_rate_rejected",
        createdAt: "2026-06-19T12:00:00.000Z",
        payload: {
          reason: "token_rate_limit",
          limitType: "tokens_per_minute",
          scope: "workspace",
          current: 1201,
          limit: 1200,
          resetAt: "2026-06-19T12:01:00.000Z"
        }
      },
      {
        eventId: "event_budget",
        eventType: "budget.reserved",
        createdAt: "2026-06-19T12:00:01.000Z",
        payload: {
          estimatedCostMicros: 2500,
          estimatedCostUsd: "0.002500",
          entries: [{
            reservationId: "reservation_1",
            scopeType: "api_key",
            scopeId: "key_1",
            windowType: "daily",
            periodStartAt: "2026-06-19T00:00:00.000Z",
            periodEndAt: "2026-06-20T00:00:00.000Z",
            limitUsd: "5.00",
            reservedUsd: "0.002500"
          }]
        }
      }
    ]);

    expect(decisions).toEqual([
      expect.objectContaining({
        id: "event_limit",
        kind: "tokens_per_minute",
        status: "rejected",
        scopeType: "workspace",
        current: 1201,
        limit: 1200,
        resetAt: "2026-06-19T12:01:00.000Z"
      }),
      expect.objectContaining({
        id: "event_budget:0",
        kind: "budget",
        status: "reserved",
        scopeType: "api_key",
        scopeId: "key_1",
        windowType: "daily",
        reserved: 0.0025,
        limit: 5,
        estimatedCost: 0.0025,
        resetAt: "2026-06-20T00:00:00.000Z"
      })
    ]);
  });

  it("normalizes budget rejection events", () => {
    expect(preflightDecisionsForEvents([{
      eventId: "event_rejected",
      eventType: "budget.rejected",
      createdAt: "2026-06-19T12:00:00.000Z",
      payload: {
        reason: "budget_limit",
        scopeType: "workspace",
        scopeId: "workspace_1",
        windowType: "monthly",
        currentUsd: "9.50",
        reservedUsd: "0.25",
        limitUsd: "10.00",
        resetAt: "2026-07-01T00:00:00.000Z",
        estimatedCostUsd: "0.50"
      }
    }])).toEqual([
      expect.objectContaining({
        kind: "budget",
        status: "rejected",
        scopeType: "workspace",
        scopeId: "workspace_1",
        windowType: "monthly",
        current: 9.5,
        reserved: 0.25,
        limit: 10,
        estimatedCost: 0.5
      })
    ]);
  });
});
