import type { ApiKeySummary } from "../routing/data";
import { apiKeyScopeOptions } from "./scopeOptions";

export function apiKeyStatus(apiKey: ApiKeySummary) {
  if (apiKey.revokedAt) return "revoked";
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() < Date.now()) return "expired";
  return "active";
}

export function routingConfigFilterValue(apiKey: ApiKeySummary) {
  return apiKey.routingConfigId ?? "default";
}

export function routingConfigLabel(apiKey: ApiKeySummary) {
  return apiKey.routingConfig?.name ?? "Organization default";
}

export function providerBindingValue(apiKey: ApiKeySummary) {
  if (apiKey.providerCredentials.length === 0) return "company default";
  return apiKey.providerCredentials
    .map((binding) => `${binding.provider} ${binding.name ?? ""}`.trim())
    .join(" ");
}

export function apiKeySearchValue(apiKey: ApiKeySummary) {
  return [
    apiKey.id,
    apiKey.name,
    apiKey.userId,
    apiKey.routingConfig?.name,
    apiKey.routingConfig?.status,
    apiKey.scopes.join(" "),
    providerBindingValue(apiKey)
  ].filter((value): value is string => Boolean(value));
}

export function scopeTitle(scope: string) {
  const description = apiKeyScopeOptions.find((option) => option.value === scope)?.description;
  return description ? `${scope} — ${description}` : scope;
}
