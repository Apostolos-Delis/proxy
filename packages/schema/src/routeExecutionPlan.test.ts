import { describe, expect, it } from "vitest";

import {
  routeExecutionPlanSchema,
  routeSkipReasonForCompatibilityReason,
  type RouteExecutionPlan
} from "./index.js";

const basePlan = {
  schemaVersion: 1,
  requestId: "request_1",
  organizationId: "org_1",
  workspaceId: "workspace_1",
  apiKeyId: "api_key_1",
  surface: "openai-responses",
  dialect: "openai-responses",
  classifier: {
    provider: "openai",
    model: "gpt-5-nano-2025-08-07",
    route: "balanced",
    confidence: 0.82,
    attempts: 1,
    dataMode: "metadata"
  },
  routingConfig: {
    id: "routing_config_1",
    versionId: "routing_config_version_1",
    version: 1,
    hash: "sha256:abc123"
  },
  candidates: [
    {
      id: "candidate_1",
      order: 0,
      providerId: "openai",
      providerAccountIds: ["provider_account_1"],
      model: "gpt-5.4",
      endpointDialect: "openai-responses",
      translated: false,
      translatorId: null,
      compatible: true,
      eligible: true,
      skipReasons: [],
      factors: {
        nativeDialect: true,
        capabilityMatch: true,
        contextWindowOk: null,
        providerHealthy: null,
        accountAvailable: true,
        budgetAllowed: null,
        rateLimitAllowed: null,
        sessionAffinityMatch: null
      }
    }
  ],
  selected: {
    candidateId: "candidate_1",
    providerId: "openai",
    providerAccountId: "provider_account_1",
    model: "gpt-5.4",
    dialect: "openai-responses",
    translated: false
  },
  policyResults: []
} satisfies RouteExecutionPlan;

describe("routeExecutionPlanSchema", () => {
  it("accepts a native single-candidate plan", () => {
    expect(routeExecutionPlanSchema.parse(basePlan)).toEqual(basePlan);
  });

  it("accepts serialized policy and candidate factor evidence", () => {
    const policyPlan = {
      ...basePlan,
      candidates: [
        {
          ...basePlan.candidates[0],
          factors: {
            ...basePlan.candidates[0].factors,
            budgetAllowed: true
          }
        }
      ],
      policyResults: [
        {
          id: "budget_0",
          policy: "budget_route_route_limit",
          status: "allowed",
          skipReason: null,
          current: "balanced",
          limit: "deep"
        }
      ]
    };

    expect(routeExecutionPlanSchema.parse(policyPlan)).toEqual(policyPlan);
  });

  it("accepts translated candidate evidence", () => {
    const translatedPlan = {
      ...basePlan,
      surface: "openai-responses",
      dialect: "openai-responses",
      candidates: [
        {
          ...basePlan.candidates[0],
          endpointDialect: "anthropic-messages",
          translated: true,
          translatorId: "openai-responses_to_anthropic-messages",
          factors: {
            ...basePlan.candidates[0].factors,
            nativeDialect: false
          }
        }
      ],
      selected: {
        ...basePlan.selected,
        dialect: "anthropic-messages",
        translated: true
      }
    };

    expect(routeExecutionPlanSchema.parse(translatedPlan)).toEqual(translatedPlan);
  });

  it("rejects unknown skip reasons", () => {
    const result = routeExecutionPlanSchema.safeParse({
      ...basePlan,
      candidates: [
        {
          ...basePlan.candidates[0],
          skipReasons: ["target_skipped_prompt_contains_secret"]
        }
      ]
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["candidates", 0, "skipReasons", 0]);
  });

  it("rejects unknown schema versions", () => {
    const result = routeExecutionPlanSchema.safeParse({
      ...basePlan,
      schemaVersion: 2
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["schemaVersion"]);
  });

  it("rejects prompt text fields", () => {
    const result = routeExecutionPlanSchema.safeParse({
      ...basePlan,
      rawPrompt: "summarize this private payload"
    });

    expect(result.success).toBe(false);
  });

  it("requires selected targets to reference planned candidates", () => {
    const result = routeExecutionPlanSchema.safeParse({
      ...basePlan,
      selected: {
        ...basePlan.selected,
        candidateId: "candidate_missing"
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["selected", "candidateId"]);
  });

  it("requires selected target details to match the planned candidate", () => {
    const result = routeExecutionPlanSchema.safeParse({
      ...basePlan,
      selected: {
        ...basePlan.selected,
        model: "gpt-5.5"
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["selected", "model"]);
  });

  it("requires selected provider accounts to come from the planned candidate", () => {
    const result = routeExecutionPlanSchema.safeParse({
      ...basePlan,
      selected: {
        ...basePlan.selected,
        providerAccountId: "provider_account_missing"
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["selected", "providerAccountId"]);
  });
});

describe("routeSkipReasonForCompatibilityReason", () => {
  it("normalizes translation compatibility reasons to route skip reasons", () => {
    expect(routeSkipReasonForCompatibilityReason("translator_unavailable")).toBe("target_unavailable_translator_missing");
    expect(routeSkipReasonForCompatibilityReason("previous_response_translation_unavailable")).toBe("target_unavailable_previous_response_id");
    expect(routeSkipReasonForCompatibilityReason("websocket_native_only")).toBe("target_unavailable_stateful_websocket");
    expect(routeSkipReasonForCompatibilityReason("stateful_translation_unavailable")).toBe("target_unavailable_stateful_translation");
  });

  it("returns undefined for missing or unknown reasons", () => {
    expect(routeSkipReasonForCompatibilityReason(undefined)).toBeUndefined();
    expect(routeSkipReasonForCompatibilityReason("unknown_runtime_reason")).toBeUndefined();
  });
});
