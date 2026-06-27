export const BEDROCK_CROSS_REGION_PROFILE_GEOGRAPHIES = ["global", "us", "eu", "jp", "apac", "au"] as const;

export type BedrockCrossRegionProfileGeography = typeof BEDROCK_CROSS_REGION_PROFILE_GEOGRAPHIES[number];

export function hasBedrockCrossRegionProfilePrefix(modelId: string | undefined) {
  return bedrockCrossRegionProfileGeography(modelId) !== null;
}

export function bedrockCrossRegionProfileGeography(modelId: string | undefined): BedrockCrossRegionProfileGeography | null {
  const normalized = bedrockModelIdentifier(modelId);
  if (!normalized.includes(".")) return null;
  const prefix = normalized.split(".")[0];
  return isBedrockCrossRegionProfileGeography(prefix) ? prefix : null;
}

export function bedrockBaseModelId(modelId: string | undefined) {
  const normalized = bedrockModelIdentifier(modelId);
  if (!normalized) return undefined;
  const geography = bedrockCrossRegionProfileGeography(normalized);
  if (!geography) return normalized;
  return normalized.slice(geography.length + 1);
}

export function isBedrockInferenceProfileArn(modelId: string | undefined) {
  const normalized = modelId?.trim() ?? "";
  return /^arn:aws(?:-[a-z]+)?:bedrock:[^:]*:[^:]*:inference-profile\/.+$/i.test(normalized);
}

export function bedrockModelIdentifier(modelId: string | undefined) {
  const normalized = modelId?.trim() ?? "";
  if (!normalized) return "";
  if (!isBedrockInferenceProfileArn(normalized)) return normalized;
  return normalized.split("/").at(-1) ?? normalized;
}

export function resolveBedrockConverseModelId(input: {
  modelId: string;
  inferenceProfile?: string;
  inferenceProfileGeography?: string;
}) {
  const modelId = input.modelId.trim();
  const profile = input.inferenceProfile?.trim();
  if (profile) {
    if (isBedrockInferenceProfileArn(profile) || hasBedrockCrossRegionProfilePrefix(profile)) return profile;
    if (isBedrockCrossRegionProfileGeography(profile)) return prefixBedrockModelId(modelId, profile);
    return profile;
  }
  const geography = input.inferenceProfileGeography?.trim();
  if (isBedrockCrossRegionProfileGeography(geography)) return prefixBedrockModelId(modelId, geography);
  return modelId;
}

export function bedrockInferenceProfileSource(modelId: string | undefined) {
  if (isBedrockInferenceProfileArn(modelId)) return "profile_arn";
  return hasBedrockCrossRegionProfilePrefix(modelId) ? "system_cross_region" : null;
}

function prefixBedrockModelId(modelId: string, geography: BedrockCrossRegionProfileGeography) {
  if (isBedrockInferenceProfileArn(modelId) || hasBedrockCrossRegionProfilePrefix(modelId)) return modelId;
  return `${geography}.${modelId}`;
}

function isBedrockCrossRegionProfileGeography(value: string | undefined): value is BedrockCrossRegionProfileGeography {
  return (BEDROCK_CROSS_REGION_PROFILE_GEOGRAPHIES as readonly string[]).includes(value ?? "");
}
