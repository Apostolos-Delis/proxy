import { describe, expect, it } from "vitest";

import {
  GATEWAY_ACCESS_PROFILE_LIMIT_IDS,
  GATEWAY_MODEL_ENDPOINTS,
  GATEWAY_OPERATION_IDS,
  GATEWAY_PARAMETER_CAP_IDS,
  GATEWAY_RESOURCE_STATUSES,
  LOGICAL_MODEL_CLASSIFIER_MAX_CANDIDATES,
  LOGICAL_MODEL_RESOLUTION_KINDS,
  LOGICAL_MODEL_ROUTER_KINDS,
  PROVIDER_ADAPTER_CONTRACT_VERSIONS,
  gatewayModelSupportsText,
  gatewayModelCapabilitiesSchema,
  gatewayOperationIdSchema,
  gatewayAccessProfileLimitsSchema,
  gatewayParameterCapsSchema,
  logicalModelClassificationContextSchema,
  logicalModelClassificationFeaturesSchema,
  logicalModelClassificationRequestSchema,
  mergeGatewayModelCapabilities,
  projectLogicalModelClassifierCapabilities,
  logicalModelClassifierConfigSchema
} from "./index.js";

describe("gateway model contracts", () => {
  it("defines only the initial operations", () => {
    expect(GATEWAY_OPERATION_IDS).toEqual(["text.generate", "text.count_tokens", "model.list"]);
    expect(PROVIDER_ADAPTER_CONTRACT_VERSIONS).toEqual(["1"]);
    expect(gatewayOperationIdSchema.parse("text.generate")).toBe("text.generate");
    expect(gatewayOperationIdSchema.safeParse("embeddings.create").success).toBe(false);
  });

  it("owns the model-facing API endpoint contract", () => {
    expect(Object.values(GATEWAY_MODEL_ENDPOINTS).map(({ method, path, operationId, wireId }) => ({
      method,
      path,
      operationId,
      wireId
    }))).toEqual([
      { method: "GET", path: "/v1/models", operationId: "model.list", wireId: null },
      { method: "POST", path: "/v1/responses", operationId: "text.generate", wireId: "openai-responses" },
      { method: "WS", path: "/v1/responses", operationId: "text.generate", wireId: "openai-responses" },
      { method: "POST", path: "/v1/chat/completions", operationId: "text.generate", wireId: "openai-chat" },
      { method: "POST", path: "/v1/messages", operationId: "text.generate", wireId: "anthropic-messages" },
      { method: "POST", path: "/v1/messages/count_tokens", operationId: "text.count_tokens", wireId: "anthropic-messages" }
    ]);
  });

  it("defines the initial logical model variants", () => {
    expect(GATEWAY_RESOURCE_STATUSES).toEqual(["active", "disabled"]);
    expect(LOGICAL_MODEL_RESOLUTION_KINDS).toEqual(["direct", "router"]);
    expect(LOGICAL_MODEL_ROUTER_KINDS).toEqual(["classifier"]);
  });

  it("validates the bounded capability value shapes", () => {
    expect(gatewayModelCapabilitiesSchema.parse({
      tools: true,
      images: true,
      contextWindow: 200_000,
      modalities: ["text", "image"]
    })).toEqual({
      tools: true,
      images: true,
      contextWindow: 200_000,
      modalities: ["text", "image"]
    });
    expect(gatewayModelCapabilitiesSchema.safeParse({ nested: { enabled: true } }).success).toBe(false);
  });

  it("shares effective text capability semantics across runtime and readiness", () => {
    expect(mergeGatewayModelCapabilities(
      { modalities: ["text", "image"], streaming: true },
      { modalities: ["image"] }
    )).toEqual({ modalities: ["image"], streaming: true });
    expect(gatewayModelSupportsText({ modalities: ["text"] })).toBe(true);
    expect(gatewayModelSupportsText({ modalities: ["image"] })).toBe(false);
    expect(gatewayModelSupportsText({})).toBe(true);
  });

  it("accepts only nonnegative numeric parameter caps", () => {
    expect(GATEWAY_PARAMETER_CAP_IDS).toEqual(["max_tokens", "max_output_tokens", "max_completion_tokens"]);
    expect(gatewayParameterCapsSchema.parse({ max_tokens: 8_192 })).toEqual({ max_tokens: 8_192 });
    expect(gatewayParameterCapsSchema.safeParse({ max_tokens: -1 }).success).toBe(false);
    expect(gatewayParameterCapsSchema.safeParse({ max_tokens: 1.5 }).success).toBe(false);
    expect(gatewayParameterCapsSchema.safeParse({ max_tokens: "8192" }).success).toBe(false);
    expect(gatewayParameterCapsSchema.safeParse({ misspelled_max_tokens: 8_192 }).success).toBe(false);
  });

  it("keeps profile rate limits separate from request parameter caps", () => {
    expect(GATEWAY_ACCESS_PROFILE_LIMIT_IDS).toEqual([
      "concurrent_requests",
      "requests_per_minute",
      "tokens_per_minute"
    ]);
    expect(gatewayAccessProfileLimitsSchema.parse({ requests_per_minute: 60 })).toEqual({
      requests_per_minute: 60
    });
    expect(gatewayAccessProfileLimitsSchema.safeParse({ max_tokens: 8_192 }).success).toBe(false);
    expect(gatewayAccessProfileLimitsSchema.safeParse({ requests_per_minute: 1.5 }).success).toBe(false);
  });

  it("bounds classifier router configuration", () => {
    const config = {
      classifierDeploymentId: "deployment_classifier",
      instructions: "Choose one eligible target.",
      timeoutMs: 10_000,
      maxAttempts: 2
    };
    expect(logicalModelClassifierConfigSchema.parse(config)).toEqual(config);
    expect(logicalModelClassifierConfigSchema.safeParse({ ...config, classifierDeploymentId: " " }).success).toBe(false);
    expect(logicalModelClassifierConfigSchema.safeParse({ ...config, classifierDeploymentId: "x".repeat(1_025) }).success).toBe(false);
    expect(logicalModelClassifierConfigSchema.safeParse({ ...config, instructions: " " }).success).toBe(false);
    expect(logicalModelClassifierConfigSchema.safeParse({ ...config, timeoutMs: 30_001 }).success).toBe(false);
    expect(logicalModelClassifierConfigSchema.safeParse({ ...config, maxAttempts: 6 }).success).toBe(false);
    expect(logicalModelClassifierConfigSchema.safeParse({ ...config, fallbackTargetId: "target_a" }).success).toBe(false);
  });

  it("caps classifier candidates at the configured router target limit", () => {
    const candidate = { targetId: "target", capabilities: {} };
    const context = { requestedModel: "chat-auto", operationId: "text.generate" as const };
    expect(logicalModelClassificationRequestSchema.safeParse({
      context,
      candidates: Array.from({ length: LOGICAL_MODEL_CLASSIFIER_MAX_CANDIDATES }, (_, index) => ({
        ...candidate,
        targetId: `target-${index}`
      }))
    }).success).toBe(true);
    expect(logicalModelClassificationRequestSchema.safeParse({
      context,
      candidates: Array.from({ length: LOGICAL_MODEL_CLASSIFIER_MAX_CANDIDATES + 1 }, (_, index) => ({
        ...candidate,
        targetId: `target-${index}`
      }))
    }).success).toBe(false);
  });

  it("bounds and redacts classifier request features", () => {
    const features = {
      estimatedInputTokens: 100,
      hasTools: true,
      extractedHints: ["security"],
      requestShapeHash: "a".repeat(64),
      redactedInputExcerpt: "redacted request"
    };
    expect(logicalModelClassificationFeaturesSchema.parse(features)).toEqual(features);
    expect(logicalModelClassificationContextSchema.parse({
      requestedModel: "coding-auto",
      operationId: "text.generate",
      ...features
    })).toEqual({
      requestedModel: "coding-auto",
      operationId: "text.generate",
      ...features
    });
    expect(logicalModelClassificationFeaturesSchema.safeParse({ rawPrompt: "secret" }).success).toBe(false);
    expect(logicalModelClassificationFeaturesSchema.safeParse({ redactedInputExcerpt: "x".repeat(2_001) }).success).toBe(false);
    expect(logicalModelClassificationFeaturesSchema.safeParse({ extractedHints: ["x".repeat(65)] }).success).toBe(false);
  });

  it("bounds the complete classifier projection and allowlists capabilities", () => {
    const candidate = {
      targetId: "target_a",
      capabilities: projectLogicalModelClassifierCapabilities({
        contextWindow: 200_000,
        tools: true,
        internalMetadata: ["must-not-leak"]
      })
    };
    expect(logicalModelClassificationRequestSchema.parse({
      context: { requestedModel: "coding-auto", operationId: "text.generate" },
      candidates: [candidate]
    })).toEqual({
      context: { requestedModel: "coding-auto", operationId: "text.generate" },
      candidates: [{ targetId: "target_a", capabilities: { contextWindow: 200_000, tools: true } }]
    });
    expect(logicalModelClassificationRequestSchema.safeParse({
      context: { requestedModel: "coding-auto", operationId: "text.generate" },
      candidates: Array.from({ length: 65 }, (_, index) => ({ targetId: `target_${index}`, capabilities: {} }))
    }).success).toBe(false);
    expect(logicalModelClassificationRequestSchema.safeParse({
      context: { requestedModel: "coding-auto", operationId: "text.generate" },
      candidates: [{ targetId: "x".repeat(1_025), capabilities: {} }]
    }).success).toBe(false);
    expect(logicalModelClassificationRequestSchema.safeParse({
      context: { requestedModel: "coding-auto", operationId: "text.generate" },
      candidates: [candidate, candidate]
    }).success).toBe(false);
    expect(logicalModelClassificationRequestSchema.safeParse({
      context: { requestedModel: "coding-auto", operationId: "text.generate" },
      candidates: [{ targetId: "target_a", capabilities: { efforts: ["x".repeat(65)] } }]
    }).success).toBe(false);
  });
});
