import { readFileSync } from "node:fs";

export type BedrockModelMetadataEntry = {
  id: string;
  modelIds?: string[];
  modelIdPrefixes?: string[];
  capabilities: Record<string, unknown>;
  pricing: Record<string, unknown>;
};

let cachedMetadata: BedrockModelMetadataEntry[] | undefined;

export function bedrockModelMetadataEntries() {
  cachedMetadata ??= parseMetadata();
  return cachedMetadata;
}

export function bedrockModelMetadataForModel(...modelIds: (string | undefined)[]) {
  const candidates = normalizedCandidates(modelIds);
  if (candidates.length === 0) return undefined;
  const entries = bedrockModelMetadataEntries();
  const exact = entries.find((entry) =>
    (entry.modelIds ?? []).some((modelId) => candidates.includes(normalizeBedrockModelId(modelId)))
  );
  if (exact) return exact;
  return entries.find((entry) =>
    (entry.modelIdPrefixes ?? []).some((prefix) => candidates.some((modelId) => modelId.startsWith(normalizeBedrockModelId(prefix))))
  );
}

function parseMetadata() {
  const raw = readFileSync(new URL("../data/bedrock-model-metadata.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("bedrock_model_metadata_invalid");
  return parsed.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.capabilities) || !isRecord(entry.pricing)) {
      throw new Error("bedrock_model_metadata_invalid");
    }
    return {
      id: entry.id,
      modelIds: stringArray(entry.modelIds),
      modelIdPrefixes: stringArray(entry.modelIdPrefixes),
      capabilities: entry.capabilities,
      pricing: entry.pricing
    };
  });
}

function normalizedCandidates(modelIds: (string | undefined)[]) {
  const candidates = new Set<string>();
  for (const modelId of modelIds) {
    const normalized = normalizeBedrockModelId(modelId);
    if (normalized) candidates.add(normalized);
  }
  return [...candidates];
}

function normalizeBedrockModelId(value: string | undefined) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(".");
  if (parts.length > 1 && ["global", "us", "eu", "jp", "apac", "au"].includes(parts[0] ?? "")) {
    return parts.slice(1).join(".");
  }
  return trimmed;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
