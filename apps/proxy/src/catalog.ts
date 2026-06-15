import type { ReasoningEffort, RouteName } from "./types.js";

export const routeOrder: RouteName[] = ["fast", "balanced", "hard", "deep"];
export const reasoningEffortOrder: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"];
const knownReasoningEfforts = new Set<ReasoningEffort>(reasoningEffortOrder);

export const routeAliases = new Map<string, RouteName>([
  ["router-fast", "fast"],
  ["router-balanced", "balanced"],
  ["router-hard", "hard"],
  ["router-deep", "deep"],
  ["claude-router-fast", "fast"],
  ["claude-router-balanced", "balanced"],
  ["claude-router-hard", "hard"],
  ["claude-router-deep", "deep"],
  ["anthropic-router-fast", "fast"],
  ["anthropic-router-balanced", "balanced"],
  ["anthropic-router-hard", "hard"],
  ["anthropic-router-deep", "deep"]
]);

export function modelAliasIds() {
  const prefixes = ["router", "claude-router", "anthropic-router"];
  return prefixes.flatMap((prefix) => [
    `${prefix}-auto`,
    ...routeOrder.map((route) => `${prefix}-${route}`)
  ]);
}

export function explicitAlias(_surface: unknown, model: string): RouteName | undefined {
  return routeAliases.get(model);
}

export function nearestReasoningEffort(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[]
) {
  if (supported.includes(requested)) return requested;
  const requestedIndex = reasoningEffortOrder.indexOf(requested);

  return [...supported].sort((left, right) => {
    return Math.abs(reasoningEffortOrder.indexOf(left) - requestedIndex) - Math.abs(reasoningEffortOrder.indexOf(right) - requestedIndex);
  })[0];
}

export function reasoningEffortsFromCapabilities(capabilities: Record<string, unknown> | undefined) {
  if (!capabilities) return undefined;
  if (!("efforts" in capabilities)) return [];
  const efforts = capabilities.efforts;
  if (!Array.isArray(efforts)) return [];
  const values = efforts.filter((effort): effort is ReasoningEffort =>
    typeof effort === "string" && knownReasoningEfforts.has(effort as ReasoningEffort)
  );
  return [...new Set(values)];
}
