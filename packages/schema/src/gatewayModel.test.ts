import { describe, expect, it } from "vitest";

import {
  GATEWAY_ACCESS_PROFILE_LIMIT_IDS,
  GATEWAY_OPERATION_IDS,
  GATEWAY_PARAMETER_CAP_IDS,
  GATEWAY_RESOURCE_STATUSES,
  LOGICAL_MODEL_RESOLUTION_KINDS,
  LOGICAL_MODEL_ROUTER_KINDS,
  PROVIDER_ADAPTER_CONTRACT_VERSIONS,
  gatewayModelCapabilitiesSchema,
  gatewayOperationIdSchema,
  gatewayAccessProfileLimitsSchema,
  gatewayParameterCapsSchema
} from "./index.js";

describe("gateway model contracts", () => {
  it("defines only the initial operations", () => {
    expect(GATEWAY_OPERATION_IDS).toEqual(["text.generate", "text.count_tokens", "model.list"]);
    expect(PROVIDER_ADAPTER_CONTRACT_VERSIONS).toEqual(["1"]);
    expect(gatewayOperationIdSchema.parse("text.generate")).toBe("text.generate");
    expect(gatewayOperationIdSchema.safeParse("embeddings.create").success).toBe(false);
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
});
