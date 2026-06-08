import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { EventService } from "../src/events.js";
import { sha256 } from "../src/util.js";

describe("config and events", () => {
  it("trust-gates local route policy and validates route-budget keys", () => {
    const rawPolicy = JSON.stringify({ budgetMaxRoute: "deep" });
    const untrusted = loadConfig({
      ROUTE_POLICY_SOURCE: "repo",
      ROUTE_POLICY_JSON: rawPolicy,
      BUDGET_MAX_ROUTE: "balanced"
    });
    const trusted = loadConfig({
      ROUTE_POLICY_SOURCE: "repo",
      ROUTE_POLICY_JSON: rawPolicy,
      TRUSTED_REPO_POLICY_HASH: sha256(rawPolicy),
      BUDGET_MAX_ROUTE: "balanced"
    });

    expect(untrusted.budgetMaxRoute).toBe("balanced");
    expect(untrusted.routePolicyTrust.trusted).toBe(false);
    expect(trusted.budgetMaxRoute).toBe("deep");
    expect(trusted.routePolicyTrust.trusted).toBe(true);
    expect(() =>
      loadConfig({
        BUDGET_ROUTE_ESTIMATED_INPUT_LIMITS: JSON.stringify({ hrad: 1 })
      })
    ).toThrow();
    expect(() =>
      loadConfig({
        ROUTE_POLICY_SOURCE: "repo",
        ROUTE_POLICY_JSON: JSON.stringify({ budgetMaxRout: "deep" }),
        TRUSTED_REPO_POLICY_HASH: sha256(JSON.stringify({ budgetMaxRout: "deep" }))
      })
    ).toThrow();
  });

  it("tracks outbox processing states only after real handlers run", async () => {
    const events = new EventService();
    const successEvents = new EventService(undefined, async () => {});
    const missingEventOutbox = new EventService();

    await events.append({
      scopeType: "request",
      scopeId: "request-1",
      producer: "test",
      eventType: "test.event"
    });
    await successEvents.append({
      scopeType: "request",
      scopeId: "request-2",
      producer: "test",
      eventType: "test.event"
    });
    await missingEventOutbox.append({
      scopeType: "request",
      scopeId: "request-3",
      producer: "test",
      eventType: "test.event"
    });
    (missingEventOutbox as unknown as { events: unknown[] }).events.length = 0;
    await events.processOutbox(async () => {
      throw new Error("fanout failed");
    });
    await missingEventOutbox.processOutbox(async () => {});

    expect(events.listOutbox()[0].status).toBe("failed");
    expect(successEvents.listOutbox()[0].status).toBe("succeeded");
    expect(missingEventOutbox.listOutbox()[0].status).toBe("failed");
  });
});
