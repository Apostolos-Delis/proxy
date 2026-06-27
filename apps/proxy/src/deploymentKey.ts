import type { Provider, RouteContext, RouteName } from "./types.js";
import { sha256, stableJson } from "./util.js";

type DeploymentKeySource = {
  provider: Provider;
  model: string;
  baseUrl?: string;
  providerAccountId?: string;
  order: number;
  weight: number;
  timeoutMs: number;
};

export function deploymentKey(input: {
  routingConfigVersionId: string;
  route: RouteName | undefined;
  surface: RouteContext["surface"];
  deployment: DeploymentKeySource;
  index: number;
}) {
  return sha256(stableJson([
    input.routingConfigVersionId,
    input.route,
    input.surface,
    input.index,
    input.deployment.provider,
    input.deployment.model,
    input.deployment.baseUrl ?? null,
    input.deployment.providerAccountId ?? null,
    input.deployment.order,
    input.deployment.weight,
    input.deployment.timeoutMs
  ]));
}
