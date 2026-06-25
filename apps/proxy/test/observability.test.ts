import { describe, expect, it } from "vitest";

import { BoundedEventWriter } from "../src/events.js";
import { AsyncObservabilityEventAppender } from "../src/observability.js";
import type { AppendEventInput, EventAppender } from "../src/events.js";

const baseEvent: AppendEventInput = {
  tenantId: "org_test",
  workspaceId: "workspace_test",
    scopeType: "request",
    scopeId: "request_test",
    producer: "test",
    eventType: "routing.classification_recorded",
  redactionState: "not_applicable",
  payload: {}
};

describe("AsyncObservabilityEventAppender", () => {
  it("swallows async observability append failures", async () => {
    const appended: string[] = [];
    const drops: string[] = [];
    const failures: string[] = [];
    const events: EventAppender = {
      async append(input) {
        appended.push(input.eventType);
        throw new Error("append_failed");
      }
    };
    const writer = new BoundedEventWriter(events, {
      maxEntries: 10,
      maxBytes: 10_000,
      maxAttempts: 0,
      retryDelayMs: 1,
      onDrop: (input, reason) => drops.push(`${input.eventType}:${reason}`),
      onFlushFailure: (_error, input, attempt) => failures.push(`${input.eventType}:${attempt}`)
    });
    const appender = new AsyncObservabilityEventAppender(events, writer);

    await expect(appender.append(baseEvent)).resolves.toBeUndefined();
    await writer.drain(100);

    expect(appended).toEqual(["routing.classification_recorded"]);
    expect(failures).toEqual(["routing.classification_recorded:1"]);
    expect(drops).toEqual(["routing.classification_recorded:retries_exhausted"]);
  });

  it("preserves synchronous failures for correctness events", async () => {
    const drops: string[] = [];
    const events: EventAppender = {
      async append() {
        throw new Error("append_failed");
      }
    };
    const writer = new BoundedEventWriter(events, {
      maxEntries: 10,
      maxBytes: 10_000,
      onDrop: (input, reason) => drops.push(`${input.eventType}:${reason}`)
    });
    const appender = new AsyncObservabilityEventAppender(events, writer);

    await expect(appender.append({
      ...baseEvent,
      eventType: "routing.decision_recorded"
    })).rejects.toThrow("append_failed");
    expect(drops).toEqual([]);
  });
});
