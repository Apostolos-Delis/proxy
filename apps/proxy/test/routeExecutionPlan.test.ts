import { describe, expect, it } from "vitest";

import type { RoutingConfig } from "@proxy/schema";

import { buildRouteExecutionPlan } from "../src/routeExecutionPlan.js";
import type { ClassifierSettings } from "../src/classifier.js";
import { deploymentKey as routeDeploymentKey } from "../src/deploymentKey.js";
import type { RouteContext, RouteDecision } from "../src/types.js";

const retry = { maxAttempts: 1, retryableStatusCodes: [429] };
const model = "anthropic.claude-3-5-haiku-20241022-v1:0";

describe("buildRouteExecutionPlan", () => {
  it("selects the matching provider account when provider, model, and dialect are duplicated", async () => {
    const firstDeployment = deployment("bedrock_account_a", 0);
    const secondDeployment = deployment("bedrock_account_b", 1);
    const routingConfig = configWithDeployments(firstDeployment, secondDeployment);
    const decision = routeDecision(secondDeployment);

    const plan = await buildRouteExecutionPlan({
      requestId: "request_account_match",
      defaultOrganizationId: "org_route_plan",
      context: routeContext(),
      decision,
      classifierSettings,
      routingConfig,
      targetAvailability: async (target) => ({
        status: "available",
        dialect: "bedrock-converse",
        adapterKind: "aws-bedrock-converse",
        providerAccountId: target.providerAccountId,
        contextWindowOk: true
      })
    });

    expect(plan?.selected).toEqual(expect.objectContaining({
      candidateId: "candidate_1",
      providerAccountId: "bedrock_account_b"
    }));
    expect(plan?.candidates.map((candidate) => candidate.providerAccountIds)).toEqual([
      ["bedrock_account_a"],
      ["bedrock_account_b"]
    ]);
  });

  it("uses deployment key matching when provider accounts are resolved from credentials", async () => {
    const firstDeployment = deployment(undefined, 0);
    const secondDeployment = deployment(undefined, 1);
    const routingConfig = configWithDeployments(firstDeployment, secondDeployment);
    const decision = routeDecision(secondDeployment, selectedDeploymentKey(secondDeployment, 1));

    const plan = await buildRouteExecutionPlan({
      requestId: "request_accountless_match",
      defaultOrganizationId: "org_route_plan",
      context: routeContext(),
      decision,
      classifierSettings,
      routingConfig,
      targetAvailability: async () => ({
        status: "available",
        dialect: "bedrock-converse",
        adapterKind: "aws-bedrock-converse",
        providerAccountId: "resolved_default_account",
        contextWindowOk: true
      })
    });

    expect(plan?.selected).toEqual(expect.objectContaining({
      candidateId: "candidate_1",
      providerAccountId: "resolved_default_account"
    }));
  });

  it("does not overwrite a deployment-key match with later accountless fallback matches", async () => {
    const firstDeployment = deployment(undefined, 0);
    const secondDeployment = deployment(undefined, 1);
    const routingConfig = configWithDeployments(firstDeployment, secondDeployment);
    const decision = routeDecision(firstDeployment, selectedDeploymentKey(firstDeployment, 0));

    const plan = await buildRouteExecutionPlan({
      requestId: "request_accountless_key_precedence",
      defaultOrganizationId: "org_route_plan",
      context: routeContext(),
      decision,
      classifierSettings,
      routingConfig,
      targetAvailability: async () => ({
        status: "available",
        dialect: "bedrock-converse",
        adapterKind: "aws-bedrock-converse",
        contextWindowOk: true
      })
    });

    expect(plan?.selected).toEqual(expect.objectContaining({
      candidateId: "candidate_0",
      providerAccountId: null
    }));
  });
});

function deployment(providerAccountId: string | undefined, order: number) {
  return {
    provider: "amazon-bedrock",
    model,
    ...(providerAccountId ? { providerAccountId } : {}),
    order,
    weight: 1,
    timeoutMs: 60000
  } satisfies RoutingConfig["routes"]["hard"]["openai"]["deployments"][number];
}

function configWithDeployments(
  firstDeployment: ReturnType<typeof deployment>,
  secondDeployment: ReturnType<typeof deployment>
): RoutingConfig {
  const route = {
    retry,
    openai: {
      deployments: [firstDeployment, secondDeployment]
    }
  };
  return {
    schemaVersion: 3,
    displayName: "Route plan account match",
    classifier: classifierSettings,
    routes: {
      fast: route,
      balanced: route,
      hard: route,
      deep: route
    },
    limits: {
      maxRoute: "deep",
      fallbackRoute: "balanced"
    },
    session: {
      pinInitialRoute: true,
      allowUpgrade: true,
      allowDowngrade: false
    }
  };
}

function routeDecision(selectedDeployment: ReturnType<typeof deployment>, key = "deployment_b"): RouteDecision {
  return {
    outcome: "route",
    surface: "openai-chat",
    requestedModel: "router-hard",
    classifierRoute: "hard",
    finalRoute: "hard",
    selectedModel: selectedDeployment.model,
    provider: "amazon-bedrock",
    deployment: {
      key,
      ...selectedDeployment
    },
    providerSettings: {
      provider: "amazon-bedrock",
      model: selectedDeployment.model,
      dialect: "bedrock-converse",
      deployment: {
        key,
        ...selectedDeployment
      },
      openai: selectedDeployment
    },
    guardrailActions: [],
    reasonCodes: ["test"],
    routingConfig: {
      configId: "routing_config_account_match",
      configName: "Route plan account match",
      versionId: "routing_config_version_account_match",
      version: 1,
      configHash: "sha256:account-match"
    },
    policyVersion: "2026-06-08"
  };
}

function selectedDeploymentKey(selectedDeployment: ReturnType<typeof deployment>, index: number) {
  return routeDeploymentKey({
    routingConfigVersionId: "routing_config_version_account_match",
    route: "hard",
    surface: "openai-chat",
    deployment: selectedDeployment,
    index
  });
}

function routeContext(): RouteContext {
  return {
    organizationId: "org_route_plan",
    workspaceId: "workspace_route_plan",
    surface: "openai-chat",
    requestedModel: "router-hard",
    inputChars: 2,
    inputHash: "sha256:input",
    estimatedInputTokens: 1,
    routingInputSource: "latest_user_message",
    routingInputText: "hi",
    routingInputChars: 2,
    routingInputHash: "sha256:routing-input",
    routingEstimatedInputTokens: 1,
    hasTools: false,
    toolCount: 0,
    hasPreviousResponseId: false,
    hasImages: false,
    extractedHints: [],
    routingExtractedHints: [],
    apiKeyId: "api_key_route_plan"
  };
}

const classifierSettings: ClassifierSettings = {
  providerId: "openai",
  model: "gpt-5-nano-2025-08-07",
  timeoutMs: 30000,
  maxAttempts: 1,
  allowRedactedExcerpt: false,
  structuredOutput: {
    mode: "json_schema",
    schemaName: "route_classification"
  }
};
