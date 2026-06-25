import { describe, expect, it } from "vitest";

import { RequestTiming, requestBodySizeBytes } from "../src/requestTiming.js";

describe("request timing instrumentation", () => {
  it("emits rounded safe timing payloads without raw prompt text", async () => {
    let now = 1_000;
    const rawPrompt = "debug this secret prompt";
    const logs: Array<{ payload: any; message: string }> = [];
    const timing = new RequestTiming(
      {
        info: (payload, message) => logs.push({ payload, message })
      },
      {
        surface: "openai-responses",
        requestBodyBytes: requestBodySizeBytes(undefined, { input: rawPrompt })
      },
      { nowMs: () => now }
    );

    await timing.measure("auth", async () => {
      now += 2.456;
    });
    timing.measureSync("compression", () => {
      now += 1.111;
    });
    timing.addMetadata({
      requestId: "request_timing",
      organizationId: "org_timing",
      workspaceId: "workspace_timing"
    });
    timing.recordEventLoopLag(3.333);
    timing.markProviderFetchStart();
    now += 4.444;
    timing.markFirstByte();
    now += 5.555;
    timing.markStreamCompletion();
    timing.log("completed", { note: "safe metadata only" });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe("request path latency");
    expect(logs[0]?.payload.requestPathLatency).toEqual(expect.objectContaining({
      requestId: "request_timing",
      organizationId: "org_timing",
      workspaceId: "workspace_timing",
      surface: "openai-responses",
      requestBodyBytes: Buffer.byteLength(JSON.stringify({ input: rawPrompt })),
      eventLoopLagMs: 3.33,
      status: "completed",
      note: "safe metadata only",
      phases: {
        auth: 2.46,
        compression: 1.11
      },
      milestones: {
        providerFetchStartMs: 3.57,
        firstByteMs: 8.01,
        streamCompletionMs: 13.57
      }
    }));
    expect(JSON.stringify(logs[0]?.payload)).not.toContain(rawPrompt);
  });

  it("derives request body size from content-length or JSON size", () => {
    expect(requestBodySizeBytes("42", { ignored: true })).toBe(42);
    expect(requestBodySizeBytes(undefined, undefined)).toBe(0);
    expect(requestBodySizeBytes(undefined, { input: "hello" }))
      .toBe(Buffer.byteLength(JSON.stringify({ input: "hello" })));
  });

  it("reports event-loop lag even when logging before the scheduled sample fires", () => {
    let now = 10;
    const logs: Array<{ payload: any; message: string }> = [];
    const timing = new RequestTiming(
      {
        info: (payload, message) => logs.push({ payload, message })
      },
      { surface: "anthropic-messages" },
      {
        nowMs: () => now,
        scheduleImmediate: () => {}
      }
    );

    timing.sampleEventLoopLag();
    now = 14.444;
    timing.log("failed");

    expect(logs[0]?.payload.requestPathLatency.eventLoopLagMs).toBe(4.44);
  });
});
