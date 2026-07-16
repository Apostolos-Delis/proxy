import type { ApiKeySummary } from "./data";

export function apiKeyStatus(apiKey: ApiKeySummary) {
  if (apiKey.revokedAt) return "revoked";
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() < Date.now()) return "expired";
  return "active";
}

export function accessProfileFilterValue(apiKey: ApiKeySummary) {
  return apiKey.accessProfileId ?? "unassigned";
}

export function accessProfileLabel(apiKey: ApiKeySummary) {
  return apiKey.accessProfile?.name ?? "Unassigned";
}

export function apiKeySearchValue(apiKey: ApiKeySummary) {
  return [
    apiKey.id,
    apiKey.name,
    apiKey.userId,
    apiKey.accessProfile?.name,
    apiKey.accessProfile?.status
  ].filter((value): value is string => Boolean(value));
}
