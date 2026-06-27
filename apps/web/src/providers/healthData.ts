import type { ProviderAccountSummary } from "./data";

export type ProviderHealthTone = "success" | "warn" | "danger" | "default";
export type ProviderAccountHealth = NonNullable<ProviderAccountSummary["health"]>;
export type ProviderModelHealth = ProviderAccountHealth["modelHealth"][number];
type ProviderHealthStatusLike = { status?: string | null } | null;
type HealthMetadata = Record<string, unknown>;

export const BEDROCK_HEALTH_CATEGORY_OPTIONS = [
  { value: "model_access_denied", label: "Model access denied" },
  { value: "stream_permission_denied", label: "Stream permission denied" },
  { value: "region_unavailable", label: "Region unavailable" },
  { value: "quota_exceeded", label: "Quota exceeded" },
  { value: "rate_limited", label: "Throttling" }
];

export function providerHealthLabel(health: ProviderHealthStatusLike) {
  if (!health) return "No data";
  if (health.status === "healthy") return "Healthy";
  if (health.status === "cooldown") return "Cooldown";
  if (health.status === "locked_out") return "Locked out";
  if (health.status === "terminal") return "Terminal";
  return "Unknown";
}

export function providerHealthTone(health: ProviderHealthStatusLike): ProviderHealthTone {
  if (!health) return "default";
  if (health.status === "healthy") return "success";
  if (health.status === "cooldown" || health.status === "unknown") return "warn";
  if (health.status === "locked_out" || health.status === "terminal") return "danger";
  return "default";
}

export function providerHealthSearchTokens(account: ProviderAccountSummary) {
  const health = account.health;
  if (!health) return ["no health data", "health unknown"];
  return [
    providerHealthLabel(health),
    health.status ?? "",
    health.lastErrorType ?? "",
    health.cooldownUntil ?? "",
    health.lastSuccessAt ?? "",
    ...healthMetadataTokens(health.metadata),
    ...providerBedrockHealthCategories(account),
    ...health.modelHealth.flatMap((model) => [
      model.model,
      model.status,
      model.lastErrorType ?? "",
      model.lockoutUntil ?? "",
      ...healthMetadataTokens(model.metadata)
    ])
  ];
}

export function providerBedrockHealthCategories(account: ProviderAccountSummary) {
  const health = account.health;
  if (!health) return [];
  return unique([
    ...bedrockHealthCategories(health.metadata, health.lastErrorType),
    ...health.modelHealth.flatMap((model) => bedrockHealthCategories(model.metadata, model.lastErrorType))
  ]);
}

export function bedrockHealthCategoryLabel(value: string | null | undefined) {
  if (!value) return null;
  return BEDROCK_HEALTH_CATEGORY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function bedrockHealthMetadataSummary(metadata: unknown) {
  const record = metadataRecord(metadata);
  const parts = [
    bedrockHealthCategoryLabel(stringValue(record.bedrockErrorKind)),
    stringValue(record.bedrockOperation),
    stringValue(record.region),
    stringValue(record.inferenceProfile),
    stringValue(record.bedrockInferenceProfileId)
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

export function modelHealthRows(health: ProviderAccountSummary["health"]): ProviderModelHealth[] {
  return [...(health?.modelHealth ?? [])].sort((left, right) => {
    const severity = modelSeverity(right) - modelSeverity(left);
    if (severity) return severity;
    return left.model.localeCompare(right.model);
  });
}

function modelSeverity(model: ProviderModelHealth) {
  if (model.status === "locked_out" || model.lockoutUntil) return 2;
  if (model.lastErrorType) return 1;
  return 0;
}

function bedrockHealthCategories(metadata: unknown, errorType: string | null | undefined) {
  const record = metadataRecord(metadata);
  const kind = stringValue(record.bedrockErrorKind);
  if (kind && BEDROCK_HEALTH_CATEGORY_OPTIONS.some((option) => option.value === kind)) return [kind];
  if (errorType === "model_access_denied") return ["model_access_denied"];
  if (errorType === "quota_exhausted") return ["quota_exceeded"];
  if (errorType === "rate_limited") return ["rate_limited"];
  if (errorType === "provider_unavailable" && stringValue(record.region)) return ["region_unavailable"];
  return [];
}

function healthMetadataTokens(metadata: unknown) {
  const record = metadataRecord(metadata);
  return Object.values(record)
    .filter((value): value is string | number | boolean => (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ))
    .map(String);
}

function metadataRecord(metadata: unknown): HealthMetadata {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as HealthMetadata
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique(values: string[]) {
  return [...new Set(values)];
}
