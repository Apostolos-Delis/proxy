import { describe, expect, it } from "vitest";

import {
  GATEWAY_OPERATION_IDS,
  PROVIDER_ADAPTER_CONTRACT_VERSIONS,
  gatewayModelCapabilitiesSchema,
  gatewayOperationIdSchema
} from "./index.js";

describe("gateway model contracts", () => {
  it("defines only the initial operations", () => {
    expect(GATEWAY_OPERATION_IDS).toEqual(["text.generate", "text.count_tokens", "model.list"]);
    expect(PROVIDER_ADAPTER_CONTRACT_VERSIONS).toEqual(["1"]);
    expect(gatewayOperationIdSchema.parse("text.generate")).toBe("text.generate");
    expect(gatewayOperationIdSchema.safeParse("embeddings.create").success).toBe(false);
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
});
