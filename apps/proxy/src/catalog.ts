import type { ReasoningEffort, RouteName } from "./types.js";

export const routeOrder: RouteName[] = ["fast", "balanced", "hard", "deep"];

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
  const order: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const requestedIndex = order.indexOf(requested);

  return [...supported].sort((left, right) => {
    return Math.abs(order.indexOf(left) - requestedIndex) - Math.abs(order.indexOf(right) - requestedIndex);
  })[0];
}
