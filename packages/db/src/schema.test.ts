import { describe, expect, it } from "vitest";

import { PROMPT_CAPTURE_MODES } from "@proxy/schema";

import {
  accessProfileModelGrants,
  accessProfiles,
  apiKeys,
  canonicalModels,
  deploymentHealth,
  deploymentWireBindings,
  events,
  logicalModels,
  logicalModelTargets,
  modelDeployments,
  promptAccessAudit,
  promptArtifacts,
  providerAttempts,
  providerConnectionHealth,
  providerConnections,
  requests,
  routeDecisions,
  usageLedger,
  userSessions
} from "./schema.js";

describe("proxy database schema", () => {
  it("exposes the durable AI gateway resources", () => {
    expect(accessProfileModelGrants).toBeTruthy();
    expect(accessProfiles).toBeTruthy();
    expect(apiKeys.accessProfileId).toBeTruthy();
    expect(canonicalModels).toBeTruthy();
    expect(deploymentHealth.deploymentId).toBeTruthy();
    expect(deploymentWireBindings).toBeTruthy();
    expect(events).toBeTruthy();
    expect(logicalModels).toBeTruthy();
    expect(logicalModelTargets).toBeTruthy();
    expect(modelDeployments.pricing).toBeTruthy();
    expect(promptArtifacts).toBeTruthy();
    expect(providerAttempts.deploymentId).toBeTruthy();
    expect(providerAttempts.providerConnectionId).toBeTruthy();
    expect(providerConnectionHealth.providerConnectionId).toBeTruthy();
    expect(providerConnections.secretRef).toBeTruthy();
    expect(promptAccessAudit).toBeTruthy();
    expect(requests.requestedLogicalModel).toBeTruthy();
    expect(routeDecisions.routerDecision).toBeTruthy();
    expect(usageLedger).toBeTruthy();
    expect(userSessions).toBeTruthy();
  });

  it("includes raw prompt artifact storage mode", () => {
    expect(PROMPT_CAPTURE_MODES.RAW_TEXT).toBe("raw_text");
  });
});
