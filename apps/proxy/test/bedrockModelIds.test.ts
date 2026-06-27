import { describe, expect, it } from "vitest";

import {
  bedrockBaseModelId,
  bedrockCrossRegionProfileGeography,
  bedrockInferenceProfileSource,
  hasBedrockCrossRegionProfilePrefix,
  isBedrockInferenceProfileArn,
  resolveBedrockConverseModelId
} from "../src/providerAdapters/bedrockModelIds.js";

describe("Bedrock model IDs", () => {
  it.each([
    ["global.anthropic.claude-sonnet-4-6", "global"],
    ["us.anthropic.claude-sonnet-4-6", "us"],
    ["eu.anthropic.claude-sonnet-4-6", "eu"],
    ["jp.anthropic.claude-sonnet-4-20250514-v1:0", "jp"],
    ["apac.anthropic.claude-sonnet-4-20250514-v1:0", "apac"],
    ["au.anthropic.claude-sonnet-4-5-20250929-v1:0", "au"]
  ])("detects %s as a %s cross-region profile", (modelId, geography) => {
    expect(hasBedrockCrossRegionProfilePrefix(modelId)).toBe(true);
    expect(bedrockCrossRegionProfileGeography(modelId)).toBe(geography);
    expect(bedrockInferenceProfileSource(modelId)).toBe("system_cross_region");
  });

  it.each([
    "anthropic.claude-sonnet-4-6",
    "amazon.nova-pro-v1:0",
    "cohere.command-r-plus-v1:0"
  ])("does not treat %s as a cross-region profile", (modelId) => {
    expect(hasBedrockCrossRegionProfilePrefix(modelId)).toBe(false);
    expect(bedrockCrossRegionProfileGeography(modelId)).toBeNull();
    expect(bedrockInferenceProfileSource(modelId)).toBeNull();
  });

  it("prefixes an unprefixed model when a geography is requested", () => {
    expect(resolveBedrockConverseModelId({
      modelId: "anthropic.claude-sonnet-4-6",
      inferenceProfile: "us"
    })).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("does not double-prefix an already-prefixed profile", () => {
    expect(resolveBedrockConverseModelId({
      modelId: "us.anthropic.claude-sonnet-4-6",
      inferenceProfile: "us"
    })).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("preserves explicit profile IDs and ARNs", () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/app-profile";

    expect(resolveBedrockConverseModelId({
      modelId: "anthropic.claude-sonnet-4-6",
      inferenceProfile: "global.anthropic.claude-sonnet-4-6"
    })).toBe("global.anthropic.claude-sonnet-4-6");
    expect(resolveBedrockConverseModelId({
      modelId: "anthropic.claude-sonnet-4-6",
      inferenceProfile: arn
    })).toBe(arn);
    expect(isBedrockInferenceProfileArn(arn)).toBe(true);
    expect(bedrockInferenceProfileSource(arn)).toBe("profile_arn");
    expect(bedrockBaseModelId("us.anthropic.claude-sonnet-4-6")).toBe("anthropic.claude-sonnet-4-6");
  });
});
