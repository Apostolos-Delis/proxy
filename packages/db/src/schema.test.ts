import { describe, expect, it } from "vitest";

import { PROMPT_CAPTURE_MODES } from "@proxy/schema";

import {
  events,
  providerAccountHealth,
  providerModelHealth,
  promptAccessAudit,
  promptArtifacts,
  providerAttempts,
  providers,
  requests,
  routeDecisions,
  routingConfigs,
  routingConfigVersions,
  usageLedger,
  userSessions
} from "./schema.js";

describe("proxy database schema", () => {
  it("exposes the core durable tables", () => {
    expect(events).toBeTruthy();
    expect(providerAccountHealth).toBeTruthy();
    expect(providerModelHealth).toBeTruthy();
    expect(promptArtifacts).toBeTruthy();
    expect(providers).toBeTruthy();
    expect(providerAttempts.routeCandidateId).toBeTruthy();
    expect(promptAccessAudit).toBeTruthy();
    expect(requests).toBeTruthy();
    expect(routeDecisions.routeExecutionPlan).toBeTruthy();
    expect(routingConfigs).toBeTruthy();
    expect(routingConfigVersions).toBeTruthy();
    expect(usageLedger).toBeTruthy();
    expect(userSessions).toBeTruthy();
  });

  it("includes raw prompt artifact storage mode", () => {
    expect(PROMPT_CAPTURE_MODES.RAW_TEXT).toBe("raw_text");
  });
});
