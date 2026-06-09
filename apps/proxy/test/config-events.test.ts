import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { EventService } from "../src/events.js";

describe("config and events", () => {
  it("ignores legacy route policy JSON and validates direct route-budget keys", () => {
    const config = loadConfig({
      ROUTE_POLICY_SOURCE: "repo",
      ROUTE_POLICY_JSON: JSON.stringify({ budgetMaxRoute: "deep" }),
      TRUSTED_REPO_POLICY_HASH: "sha256:legacy",
      BUDGET_MAX_ROUTE: "balanced"
    });

    expect(config.budgetMaxRoute).toBe("balanced");
    expect("routePolicyTrust" in config).toBe(false);
    expect(() =>
      loadConfig({
        BUDGET_ROUTE_ESTIMATED_INPUT_LIMITS: JSON.stringify({ hrad: 1 })
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
