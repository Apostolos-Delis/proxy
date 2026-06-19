import type { ProviderAccountSummary } from "./data";

export type ProviderHealthTone = "success" | "warn" | "danger" | "default";
export type ProviderAccountHealth = NonNullable<ProviderAccountSummary["health"]>;
export type ProviderModelHealth = ProviderAccountHealth["modelHealth"][number];
type ProviderHealthStatusLike = { status?: string | null } | null;

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
    ...health.modelHealth.flatMap((model) => [
      model.model,
      model.status,
      model.lastErrorType ?? "",
      model.lockoutUntil ?? ""
    ])
  ];
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
