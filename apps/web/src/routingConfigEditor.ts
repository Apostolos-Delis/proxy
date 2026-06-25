import { anthropicEffortForModel, type Effort } from "@proxy/schema";

export type RoutingConfigThinking = {
  type?: string;
  display?: string;
};

export type RoutingConfigRouteTarget = {
  providerId: string;
  model: string;
  effort?: string;
  thinking?: RoutingConfigThinking;
  maxOutputTokens?: number;
  verbosity?: string;
  metadata?: Record<string, unknown>;
};

export type RoutingConfigDeploymentSettings = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  providerAccountId?: string;
  order?: number;
  weight?: number;
  timeoutMs?: number;
  reasoning?: { effort?: string };
  text?: { verbosity?: string };
  thinking?: RoutingConfigThinking;
  output_config?: { effort?: string };
  maxOutputTokens?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
};

export type RoutingConfigProviderSettings = {
  deployments?: RoutingConfigDeploymentSettings[];
};

export type RoutingConfigRoute = {
  description?: string;
  retry?: {
    maxAttempts?: number;
    retryableStatusCodes?: number[];
  };
  openai?: RoutingConfigProviderSettings;
  anthropic?: RoutingConfigProviderSettings;
};

export type RoutingConfigDocument = {
  schemaVersion: number;
  displayName: string;
  description?: string;
  classifier: {
    providerId: string;
    model: string;
    effort?: string;
    rules?: string;
    timeoutMs: number;
    maxAttempts: number;
    allowRedactedExcerpt: boolean;
    structuredOutput?: Record<string, unknown>;
  };
  routes: Record<string, RoutingConfigRoute>;
  limits: Record<string, unknown>;
  session: Record<string, unknown>;
};

export type RoutingCatalogProvider = {
  slug: string;
  displayName: string;
  authStyle: string;
  enabled: boolean;
  builtin: boolean;
  endpoints: { dialect: string; path: string }[];
  capabilities: unknown;
};

export type RoutingCatalogModel = {
  provider?: string | null;
  model: string;
  source: string;
  seenInTraffic: boolean;
};

export type RoutingEditorCatalog = {
  providers: RoutingCatalogProvider[];
  models: RoutingCatalogModel[];
};

export const editorRouteOrder = ["fast", "balanced", "hard", "deep"] as const;

export type EditorRouteName = typeof editorRouteOrder[number];

export const EFFORT_SCALE = ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"] as const;

export type RouteTargetDraft = {
  providerId: string;
  model: string;
  effort: string;
  thinking?: RoutingConfigThinking;
  maxOutputTokens?: number;
  verbosity?: string;
  metadata?: Record<string, unknown>;
};

export type RouteTierDraft = {
  targets: RouteTargetDraft[];
};

export type ConfigEditorDraft = {
  classifierRules: string;
  maxEstimatedInputTokensEnabled: boolean;
  maxEstimatedInputTokens: string;
  routes: Record<EditorRouteName, RouteTierDraft>;
};

export function draftFromConfig(config: RoutingConfigDocument): ConfigEditorDraft {
  const routes = {} as ConfigEditorDraft["routes"];
  for (const route of editorRouteOrder) {
    const tier = config.routes[route];
    routes[route] = {
      targets: routeTargetsFromConfig(tier)
    };
  }
  const maxEstimatedInputTokens = numberLimit(config.limits.maxEstimatedInputTokens);
  return {
    classifierRules: config.classifier.rules ?? "",
    maxEstimatedInputTokensEnabled: maxEstimatedInputTokens !== undefined,
    maxEstimatedInputTokens: maxEstimatedInputTokens?.toString() ?? "",
    routes
  };
}

export function applyDraft(base: RoutingConfigDocument, draft: ConfigEditorDraft): RoutingConfigDocument {
  const routes: RoutingConfigDocument["routes"] = { ...base.routes };
  for (const route of editorRouteOrder) {
    routes[route] = routeFromDraft(base.routes[route] ?? {}, draft.routes[route].targets);
  }
  const next = {
    ...base,
    schemaVersion: 3,
    limits: { ...base.limits },
    routes,
    classifier: { ...base.classifier }
  };
  const rules = draft.classifierRules.trim();
  if (rules) next.classifier.rules = rules;
  else delete next.classifier.rules;
  if (draft.maxEstimatedInputTokensEnabled) {
    next.limits.maxEstimatedInputTokens = Number(draft.maxEstimatedInputTokens);
  } else {
    delete next.limits.maxEstimatedInputTokens;
  }
  return next;
}

export function draftError(draft: ConfigEditorDraft): string | undefined {
  const emptyRoutes = editorRouteOrder.filter((route) => draft.routes[route].targets.length === 0);
  if (emptyRoutes.length > 0) {
    return `Each tier needs at least one target. Missing: ${emptyRoutes.join(", ")}.`;
  }

  if (draft.maxEstimatedInputTokensEnabled && !isPositiveInteger(draft.maxEstimatedInputTokens)) {
    return "Request input cap must be a positive whole number.";
  }

  for (const route of editorRouteOrder) {
    const incompleteIndex = draft.routes[route].targets.findIndex((target) =>
      !target.providerId.trim() || !target.model.trim()
    );
    if (incompleteIndex >= 0) {
      return `${route} target ${incompleteIndex + 1} needs both a provider and model.`;
    }
    const unsupportedIndex = draft.routes[route].targets.findIndex((target) =>
      target.providerId.trim() !== "openai" && target.providerId.trim() !== "anthropic"
    );
    if (unsupportedIndex >= 0) {
      return `${route} target ${unsupportedIndex + 1} must use openai or anthropic.`;
    }
  }
  return undefined;
}

function numberLimit(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isPositiveInteger(value: string) {
  return /^[1-9]\d*$/.test(value.trim());
}

export function draftsEqual(left: ConfigEditorDraft, right: ConfigEditorDraft) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseConfigJson(text: string): { config?: RoutingConfigDocument; error?: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "Config JSON must be an object." };
    }
    return { config: value as RoutingConfigDocument };
  } catch (error) {
    return { error: error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON." };
  }
}

export function emptyRouteTarget(providerId = "", model = ""): RouteTargetDraft {
  return {
    providerId,
    model,
    effort: ""
  };
}

export function effectiveEffortForTarget(
  target: Pick<RouteTargetDraft, "providerId" | "model" | "effort" | "thinking">,
  supportedEfforts?: readonly string[],
  targetDialects?: readonly string[]
) {
  const effort = target.effort.trim();
  if (!effort) return "";
  if (target.providerId.trim() === "anthropic" || targetDialects?.includes("anthropic-messages")) {
    if (target.thinking?.type !== "adaptive") return "";
    const knownEffort = effortAsKnownEffort(effort);
    if (!knownEffort) return "";
    return anthropicEffortForModel(target.model.trim(), knownEffort) ?? "";
  }
  if (supportedEfforts !== undefined) {
    if (supportedEfforts.length === 0) return "";
    return nearestEffort(effort, supportedEfforts) ?? effort;
  }
  return effort;
}

export function effortScaleForProvider(provider?: Pick<RoutingCatalogProvider, "capabilities">) {
  const efforts = effortValues(provider?.capabilities);
  return efforts ?? [...EFFORT_SCALE];
}

export function effortOptionsForProvider(
  provider: Pick<RoutingCatalogProvider, "capabilities"> | undefined,
  currentEffort: string
) {
  const values = effortScaleForProvider(provider);
  const current = currentEffort.trim();
  if (current && !values.includes(current)) return [current, ...values];
  return values;
}

function routeTargetFromDraft(target: RouteTargetDraft) {
  const providerId = target.providerId.trim();
  const model = target.model.trim();
  if (!providerId && !model) return undefined;
  const next: RoutingConfigRouteTarget = { providerId, model };
  const effort = target.effort.trim();
  if (effort) next.effort = effort;
  if (target.thinking) next.thinking = target.thinking;
  if (target.maxOutputTokens) next.maxOutputTokens = target.maxOutputTokens;
  if (target.verbosity) next.verbosity = target.verbosity;
  if (target.metadata) next.metadata = target.metadata;
  return next;
}

function routeTargetsFromConfig(route: RoutingConfigRoute | undefined): RouteTargetDraft[] {
  return [
    ...deploymentsFromConfig("openai", route?.openai),
    ...deploymentsFromConfig("anthropic", route?.anthropic)
  ]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...target }) => target);
}

function deploymentsFromConfig(
  providerId: "openai" | "anthropic",
  settings: RoutingConfigProviderSettings | undefined
): Array<RouteTargetDraft & { order: number }> {
  return sortedDeployments(settings).map((deployment, index) => ({
    providerId,
    model: deployment.model ?? "",
    effort: providerId === "openai"
      ? deployment.reasoning?.effort ?? ""
      : deployment.output_config?.effort ?? "",
    thinking: providerId === "anthropic" ? deployment.thinking : undefined,
    maxOutputTokens: providerId === "openai" ? deployment.maxOutputTokens : deployment.maxTokens,
    verbosity: providerId === "openai" ? deployment.text?.verbosity : undefined,
    metadata: deployment.metadata,
    order: deployment.order ?? index
  }));
}

function routeFromDraft(baseRoute: RoutingConfigRoute, targets: RouteTargetDraft[]): RoutingConfigRoute {
  const normalizedTargets = targets
    .map((target, order) => {
      const next = routeTargetFromDraft(target);
      return next ? { ...next, order } : undefined;
    })
    .filter((target): target is RoutingConfigRouteTarget & { order: number } => Boolean(target));
  const nextRoute: RoutingConfigRoute = {};
  if (baseRoute.description !== undefined) nextRoute.description = baseRoute.description;
  if (baseRoute.retry !== undefined) nextRoute.retry = baseRoute.retry;
  const openai = providerBlock(
    baseRoute.openai,
    "openai",
    normalizedTargets.filter((target) => target.providerId === "openai")
  );
  const anthropic = providerBlock(
    baseRoute.anthropic,
    "anthropic",
    normalizedTargets.filter((target) => target.providerId === "anthropic")
  );
  if (openai) nextRoute.openai = openai;
  if (anthropic) nextRoute.anthropic = anthropic;
  return nextRoute;
}

function providerBlock(
  base: RoutingConfigProviderSettings | undefined,
  provider: "openai" | "anthropic",
  targets: Array<RoutingConfigRouteTarget & { order: number }>
): RoutingConfigProviderSettings | undefined {
  if (targets.length === 0) return undefined;
  const baseDeployments = sortedDeployments(base);
  return {
    ...base,
    deployments: targets.map((target, index) =>
      deploymentFromTarget(target, provider, baseDeployments[index])
    )
  };
}

function deploymentFromTarget(
  target: RoutingConfigRouteTarget & { order: number },
  provider: "openai" | "anthropic",
  base: RoutingConfigDeploymentSettings | undefined
): RoutingConfigDeploymentSettings {
  const deployment: RoutingConfigDeploymentSettings = {
    ...base,
    provider,
    model: target.model,
    order: target.order,
    weight: base?.weight ?? 1,
    timeoutMs: base?.timeoutMs ?? 60000
  };
  const effort = target.effort?.trim();
  if (provider === "openai") {
    if (effort) deployment.reasoning = { ...deployment.reasoning, effort };
    else delete deployment.reasoning;
    if (target.verbosity) deployment.text = { ...deployment.text, verbosity: target.verbosity };
    else delete deployment.text;
    if (target.maxOutputTokens) deployment.maxOutputTokens = target.maxOutputTokens;
  } else {
    if (effort) deployment.output_config = { ...deployment.output_config, effort };
    else delete deployment.output_config;
    if (target.thinking) deployment.thinking = target.thinking;
    else delete deployment.thinking;
    if (target.maxOutputTokens) deployment.maxTokens = target.maxOutputTokens;
  }
  if (target.metadata) deployment.metadata = target.metadata;
  return deployment;
}

function sortedDeployments(settings: RoutingConfigProviderSettings | undefined) {
  return [...(settings?.deployments ?? [])].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
}

function nearestEffort(value: string, supported: readonly string[]) {
  if (supported.includes(value)) return value;
  const requestedIndex = EFFORT_SCALE.indexOf(value as typeof EFFORT_SCALE[number]);
  if (requestedIndex < 0) return undefined;
  let closest: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const effort of supported) {
    const distance = Math.abs(EFFORT_SCALE.indexOf(effort as typeof EFFORT_SCALE[number]) - requestedIndex);
    if (distance < bestDistance) {
      closest = effort;
      bestDistance = distance;
    }
  }
  return closest;
}

function effortAsKnownEffort(value: string): Effort | undefined {
  if (EFFORT_SCALE.includes(value as typeof EFFORT_SCALE[number])) return value as Effort;
  return undefined;
}

function effortValues(capabilities: unknown) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  const record = capabilities as Record<string, unknown>;
  if (!("efforts" in record)) return [];
  const efforts = record.efforts;
  if (!Array.isArray(efforts)) return [];
  return efforts.filter((effort): effort is string =>
    typeof effort === "string" && EFFORT_SCALE.includes(effort as typeof EFFORT_SCALE[number])
  );
}
