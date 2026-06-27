import { describe, expect, it } from "vitest";

import { artifactToolNames, compressionEventSummary, eventTone, exchangeMeta, healthSkipsFromEvents, type ProxyEvent } from "./promptDetailData";

describe("eventTone", () => {
  it("maps producer prefixes to tones", () => {
    expect(eventTone("proxy.request_received")).toBe("event-proxy");
    expect(eventTone("prompt_artifacts.captured")).toBe("event-capture");
    expect(eventTone("routing.context_built")).toBe("event-routing");
    expect(eventTone("provider.response_completed")).toBe("event-provider");
    expect(eventTone("compression.retrieved")).toBe("event-compression");
  });

  it("flags failure events even when a prefix tone matches", () => {
    expect(eventTone("provider.request_failed")).toBe("event-danger");
    expect(eventTone("routing.classification_failed")).toBe("event-danger");
    expect(eventTone("upstream.rejected")).toBe("event-danger");
    expect(eventTone("proxy.timeout")).toBe("event-danger");
  });
});

describe("compressionEventSummary", () => {
  it("summarizes retrieval events from sanitized fields", () => {
    expect(compressionEventSummary(event("compression.retrieved", {
      retrievalId: "cmp_123456789abcdef",
      toolName: "mcp__linear__list_issues",
      status: "retrieved",
      rawText: "do not render"
    }))).toBe("retrieved · cmp_123456789abcdef · mcp__linear__list_issues()");
  });

  it("shows typed retrieval failure reasons", () => {
    expect(compressionEventSummary(event("compression.retrieval_failed", {
      retrievalId: "cmp_123456789abcdef",
      failureReason: "artifact_expired"
    }))).toBe("failed: artifact_expired · cmp_123456789abcdef");
  });

  it("ignores non-compression and malformed payloads", () => {
    expect(compressionEventSummary(event("routing.decision_recorded", {}))).toBeNull();
    expect(compressionEventSummary(event("compression.retrieved", "bad"))).toBeNull();
  });
});

describe("artifactToolNames", () => {
  it("reads a single toolName", () => {
    expect(artifactToolNames({ toolName: "bash" })).toEqual(["bash"]);
  });

  it("reads merged toolNames and dedupes", () => {
    expect(artifactToolNames({ toolNames: ["bash", "read", "bash"] })).toEqual(["bash", "read"]);
  });

  it("merges toolName with toolNames without duplicates", () => {
    expect(artifactToolNames({ toolName: "bash", toolNames: ["bash", "read"] })).toEqual(["bash", "read"]);
  });

  it("ignores missing or malformed metadata", () => {
    expect(artifactToolNames(null)).toEqual([]);
    expect(artifactToolNames(undefined)).toEqual([]);
    expect(artifactToolNames("bash")).toEqual([]);
    expect(artifactToolNames([{ toolName: "bash" }])).toEqual([]);
    expect(artifactToolNames({ toolName: 7, toolNames: [1, "grep"] })).toEqual(["grep"]);
  });
});

describe("exchangeMeta", () => {
  it("formats chars and token estimate", () => {
    expect(exchangeMeta(10_034, 2480)).toBe("10.0K chars · ~2.48K tok");
  });

  it("shows raw counts below one thousand chars", () => {
    expect(exchangeMeta(312, 223)).toBe("312 chars · ~223 tok");
    expect(exchangeMeta(0, 6)).toBe("0 chars · ~6 tok");
  });

  it("omits missing parts", () => {
    expect(exchangeMeta(null, 223)).toBe("~223 tok");
    expect(exchangeMeta(312, null)).toBe("312 chars");
    expect(exchangeMeta(null, null)).toBe("");
    expect(exchangeMeta(312, 0)).toBe("312 chars");
  });
});

describe("healthSkipsFromEvents", () => {
  it("extracts sanitized provider health skip evidence from route decision events", () => {
    const skips = healthSkipsFromEvents([
      event("routing.decision_recorded", {
        healthSkips: [
          {
            scope: "provider_account",
            provider: "openai",
            providerId: "provider_1",
            providerAccountId: "account_1",
            model: "gpt-locked",
            healthStatus: "cooldown",
            errorType: "rate_limited",
            expiresAt: "2026-06-18T12:05:00.000Z",
            metadata: {
              bedrockErrorKind: "stream_permission_denied",
              region: "us-east-1",
              nested: { raw: "do not render" }
            },
            rawError: "do not render"
          }
        ]
      })
    ]);

    expect(skips).toEqual([
      {
        scope: "provider_account",
        provider: "openai",
        providerId: "provider_1",
        providerAccountId: "account_1",
        model: "gpt-locked",
        healthStatus: "cooldown",
        errorType: "rate_limited",
        expiresAt: "2026-06-18T12:05:00.000Z",
        metadata: {
          bedrockErrorKind: "stream_permission_denied",
          region: "us-east-1"
        }
      }
    ]);
    expect(JSON.stringify(skips)).not.toContain("do not render");
  });

  it("ignores malformed and unrelated event payloads", () => {
    expect(healthSkipsFromEvents([
      event("provider.response_failed", { healthSkips: [{ scope: "provider_account" }] }),
      event("routing.decision_recorded", { healthSkips: ["bad"] }),
      event("routing.decision_recorded", { healthSkips: [{ provider: 7 }] })
    ])).toEqual([
      {
        scope: null,
        provider: null,
        providerId: null,
        providerAccountId: null,
        model: null,
        healthStatus: null,
        errorType: null,
        expiresAt: null,
        metadata: {}
      }
    ]);
  });
});

function event(eventType: string, payload: unknown): ProxyEvent {
  return {
    eventId: `event_${eventType}`,
    eventType,
    producer: "proxy.routing",
    payload,
    createdAt: "2026-06-18T12:00:00.000Z"
  } as ProxyEvent;
}
