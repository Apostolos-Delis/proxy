import { describe, expect, it } from "vitest";

import { PROMPT_CAPTURE_MODES } from "@prompt-proxy/schema";

import {
  consoleAgentConversations,
  consoleAgentMessages,
  consoleAgentProposals,
  consoleAgentRunEvents,
  consoleAgentRuns,
  events,
  promptAccessAudit,
  promptArtifacts,
  requests,
  routingConfigs,
  routingConfigVersions,
  usageLedger,
  userSessions
} from "./schema.js";

describe("prompt proxy database schema", () => {
  it("exposes the core durable tables", () => {
    expect(events).toBeTruthy();
    expect(promptArtifacts).toBeTruthy();
    expect(promptAccessAudit).toBeTruthy();
    expect(requests).toBeTruthy();
    expect(routingConfigs).toBeTruthy();
    expect(routingConfigVersions).toBeTruthy();
    expect(usageLedger).toBeTruthy();
    expect(userSessions).toBeTruthy();
  });

  it("exposes the console agent tables", () => {
    expect(consoleAgentConversations).toBeTruthy();
    expect(consoleAgentRuns).toBeTruthy();
    expect(consoleAgentMessages).toBeTruthy();
    expect(consoleAgentRunEvents).toBeTruthy();
    expect(consoleAgentProposals).toBeTruthy();
  });

  it("includes raw prompt artifact storage mode", () => {
    expect(PROMPT_CAPTURE_MODES.RAW_TEXT).toBe("raw_text");
  });
});
