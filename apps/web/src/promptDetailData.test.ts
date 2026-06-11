import { describe, expect, it } from "vitest";

import { artifactToolNames, eventTone, exchangeMeta } from "./promptDetailData";

describe("eventTone", () => {
  it("maps producer prefixes to tones", () => {
    expect(eventTone("proxy.request_received")).toBe("event-proxy");
    expect(eventTone("prompt_artifacts.captured")).toBe("event-capture");
    expect(eventTone("routing.context_built")).toBe("event-routing");
    expect(eventTone("provider.response_completed")).toBe("event-provider");
  });

  it("flags failure events even when a prefix tone matches", () => {
    expect(eventTone("provider.request_failed")).toBe("event-danger");
    expect(eventTone("routing.classification_failed")).toBe("event-danger");
    expect(eventTone("upstream.rejected")).toBe("event-danger");
    expect(eventTone("proxy.timeout")).toBe("event-danger");
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
