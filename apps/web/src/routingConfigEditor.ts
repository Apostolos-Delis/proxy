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

export type RoutingConfigRoute = {
  description?: string;
  targets: RoutingConfigRouteTarget[];
};

export type RoutingConfigDocument = {
  schemaVersion: 2;
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
  routes: Record<EditorRouteName, RouteTierDraft>;
};

export function draftFromConfig(config: RoutingConfigDocument): ConfigEditorDraft {
  const routes = {} as ConfigEditorDraft["routes"];
  for (const route of editorRouteOrder) {
    const tier = config.routes[route];
    routes[route] = {
      targets: (tier?.targets ?? []).map((target) => ({
        providerId: target.providerId ?? "",
        model: target.model ?? "",
        effort: target.effort ?? "",
        thinking: target.thinking,
        maxOutputTokens: target.maxOutputTokens,
        verbosity: target.verbosity,
        metadata: target.metadata
      }))
    };
  }
  return {
    classifierRules: config.classifier.rules ?? "",
    routes
  };
}

export function applyDraft(base: RoutingConfigDocument, draft: ConfigEditorDraft): RoutingConfigDocument {
  const routes: RoutingConfigDocument["routes"] = { ...base.routes };
  for (const route of editorRouteOrder) {
    const baseRoute = base.routes[route] ?? { targets: [] };
    routes[route] = {
      ...baseRoute,
      targets: draft.routes[route].targets
        .map(routeTargetFromDraft)
        .filter((target): target is RoutingConfigRouteTarget => Boolean(target))
    };
  }
  const next = {
    ...base,
    routes,
    classifier: { ...base.classifier }
  };
  const rules = draft.classifierRules.trim();
  if (rules) next.classifier.rules = rules;
  else delete next.classifier.rules;
  return next;
}

export function draftError(draft: ConfigEditorDraft): string | undefined {
  const emptyRoutes = editorRouteOrder.filter((route) => draft.routes[route].targets.length === 0);
  if (emptyRoutes.length > 0) {
    return `Each tier needs at least one target. Missing: ${emptyRoutes.join(", ")}.`;
  }

  for (const route of editorRouteOrder) {
    const incompleteIndex = draft.routes[route].targets.findIndex((target) =>
      !target.providerId.trim() || !target.model.trim()
    );
    if (incompleteIndex >= 0) {
      return `${route} target ${incompleteIndex + 1} needs both a provider and model.`;
    }
  }
  return undefined;
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
  target: Pick<RouteTargetDraft, "providerId" | "effort">,
  supportedEfforts?: readonly string[]
) {
  const effort = target.effort.trim();
  if (!effort) return "";
  if (supportedEfforts !== undefined) {
    if (supportedEfforts.length === 0) return "";
    return nearestEffort(effort, supportedEfforts) ?? effort;
  }
  if (target.providerId.trim() !== "anthropic") return effort;
  return nearestEffort(effort, ["low", "medium", "high", "xhigh", "max", "ultracode"]) ?? effort;
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

function effortValues(capabilities: unknown) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  const record = capabilities as Record<string, unknown>;
  if (!("efforts" in record)) return undefined;
  const efforts = record.efforts;
  if (!Array.isArray(efforts)) return undefined;
  return efforts.filter((effort): effort is string =>
    typeof effort === "string" && EFFORT_SCALE.includes(effort as typeof EFFORT_SCALE[number])
  );
}
