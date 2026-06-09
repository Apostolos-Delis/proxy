import { describe, expect, it } from "vitest";

import { PROMPT_CAPTURE_MODES } from "@prompt-proxy/schema";

import { events, promptArtifacts, requests, usageLedger, userSessions } from "./schema.js";

describe("prompt proxy database schema", () => {
  it("exposes the core durable tables", () => {
    expect(events).toBeTruthy();
    expect(promptArtifacts).toBeTruthy();
    expect(requests).toBeTruthy();
    expect(usageLedger).toBeTruthy();
    expect(userSessions).toBeTruthy();
  });

  it("includes raw prompt artifact storage mode", () => {
    expect(PROMPT_CAPTURE_MODES.RAW_TEXT).toBe("raw_text");
  });
});
