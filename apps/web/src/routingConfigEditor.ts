// The editor manipulates the raw config document as loose JSON; the server's
// zod schema (@prompt-proxy/schema routingConfigSchema) is the validator of
// record when a draft is saved.
export type RoutingConfigProviderSettings = {
  model?: string;
  reasoning?: { effort?: string };
  text?: { verbosity?: string };
  thinking?: { type?: string; display?: string };
  output_config?: { effort?: string };
  maxOutputTokens?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
};

export type RoutingConfigDocument = {
  schemaVersion: number;
  displayName: string;
  description?: string;
  systemPrompt?: string;
  classifier: {
    provider: string;
    model: string;
    rules?: string;
    timeoutMs: number;
    maxAttempts: number;
    allowRedactedExcerpt: boolean;
    structuredOutput?: Record<string, unknown>;
  };
  routes: Record<string, {
    description?: string;
    openai?: RoutingConfigProviderSettings;
    anthropic?: RoutingConfigProviderSettings;
  }>;
  limits: Record<string, unknown>;
  session: Record<string, unknown>;
};

export const editorRouteOrder = ["fast", "balanced", "hard", "deep"] as const;

export type EditorRouteName = typeof editorRouteOrder[number];

export const OPENAI_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type RouteTierDraft = {
  openaiModel: string;
  openaiEffort: string;
  anthropicModel: string;
  anthropicEffort: string;
};

export type ConfigEditorDraft = {
  systemPrompt: string;
  classifierRules: string;
  routes: Record<EditorRouteName, RouteTierDraft>;
};

export function draftFromConfig(config: RoutingConfigDocument): ConfigEditorDraft {
  const routes = {} as ConfigEditorDraft["routes"];
  for (const route of editorRouteOrder) {
    const tier = config.routes[route];
    routes[route] = {
      openaiModel: tier?.openai?.model ?? "",
      openaiEffort: tier?.openai?.reasoning?.effort ?? "",
      anthropicModel: tier?.anthropic?.model ?? "",
      anthropicEffort: tier?.anthropic?.output_config?.effort ?? ""
    };
  }
  return {
    systemPrompt: config.systemPrompt ?? "",
    classifierRules: config.classifier.rules ?? "",
    routes
  };
}

export function applyDraft(base: RoutingConfigDocument, draft: ConfigEditorDraft): RoutingConfigDocument {
  const routes: RoutingConfigDocument["routes"] = { ...base.routes };
  for (const route of editorRouteOrder) {
    const baseRoute = base.routes[route] ?? {};
    const nextRoute = { ...baseRoute };
    const tier = draft.routes[route];
    const openai = providerBlock(baseRoute.openai, tier.openaiModel, "reasoning", tier.openaiEffort);
    const anthropic = providerBlock(baseRoute.anthropic, tier.anthropicModel, "output_config", tier.anthropicEffort);
    if (openai) nextRoute.openai = openai;
    else delete nextRoute.openai;
    if (anthropic) nextRoute.anthropic = anthropic;
    else delete nextRoute.anthropic;
    routes[route] = nextRoute;
  }
  const next = {
    ...base,
    routes,
    classifier: { ...base.classifier }
  };
  const rules = draft.classifierRules.trim();
  if (rules) next.classifier.rules = rules;
  else delete next.classifier.rules;
  const systemPrompt = draft.systemPrompt.trim();
  if (systemPrompt) next.systemPrompt = systemPrompt;
  else delete next.systemPrompt;
  return next;
}

export function draftError(draft: ConfigEditorDraft): string | undefined {
  const missing = editorRouteOrder.filter((route) =>
    !draft.routes[route].openaiModel.trim() && !draft.routes[route].anthropicModel.trim()
  );
  if (missing.length === 0) return undefined;
  return `Each tier needs at least one model. Missing: ${missing.join(", ")}.`;
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

function providerBlock(
  base: RoutingConfigProviderSettings | undefined,
  model: string,
  effortKey: "reasoning" | "output_config",
  effort: string
) {
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const block: RoutingConfigProviderSettings = { ...base, model: trimmed };
  const container: { effort?: string } = { ...base?.[effortKey] };
  if (effort) container.effort = effort;
  else delete container.effort;
  if (Object.keys(container).length > 0) block[effortKey] = container;
  else delete block[effortKey];
  return block;
}
