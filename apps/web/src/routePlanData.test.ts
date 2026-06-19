import { describe, expect, it } from "vitest";

import { attemptsForCandidate, formatSkipReason, routePlanFromDecision } from "./routePlanData";
import type { RouteDecisionEvidence, ProviderAttemptEvidence } from "./routePlanData";

describe("routePlanData", () => {
  it("treats empty legacy route plans as absent", () => {
    expect(routePlanFromDecision({ routeExecutionPlan: {} } as RouteDecisionEvidence)).toBeNull();
  });

  it("parses selected route candidates without prompt text", () => {
    const plan = routePlanFromDecision({
      routeExecutionPlan: {
        schemaVersion: 1,
        classifier: { route: "hard", confidence: 0.91 },
        routingConfig: { version: 2, hash: "sha256:abc" },
        candidates: [
          {
            id: "candidate_0",
            order: 0,
            providerId: "openai",
            model: "gpt-5.4",
            endpointDialect: "openai-responses",
            translated: false,
            compatible: true,
            eligible: true,
            skipReasons: [],
            factors: { budgetAllowed: true }
          }
        ],
        selected: { candidateId: "candidate_0", providerId: "openai" },
        policyResults: []
      }
    } as RouteDecisionEvidence);

    expect(plan?.selected?.candidateId).toBe("candidate_0");
    expect(plan?.candidates[0]?.factors).toEqual({ budgetAllowed: true });
  });

  it("matches provider attempts by candidate id", () => {
    const attempts = [
      { id: "attempt_0", routeCandidateId: "candidate_0" },
      { id: "attempt_1", routeCandidateId: "candidate_1" }
    ] as ProviderAttemptEvidence[];

    expect(attemptsForCandidate(attempts, "candidate_0").map((attempt) => attempt.id)).toEqual(["attempt_0"]);
  });

  it("formats typed skip reasons for compact display", () => {
    expect(formatSkipReason("target_skipped_missing_credential")).toBe("missing credential");
    expect(formatSkipReason("target_unavailable_previous_response_id")).toBe("previous response id");
  });
});
