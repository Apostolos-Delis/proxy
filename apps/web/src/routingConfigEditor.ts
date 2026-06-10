import type { RoutingConfigDocument, RoutingConfigProviderSettings } from "./api";

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
  classifierInstructions: string;
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
    classifierInstructions: config.classifier.instructions ?? "",
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
    classifier: { ...base.classifier, instructions: draft.classifierInstructions.trim() }
  };
  const systemPrompt = draft.systemPrompt.trim();
  if (systemPrompt) next.systemPrompt = systemPrompt;
  else delete next.systemPrompt;
  return next;
}

export function draftError(draft: ConfigEditorDraft): string | undefined {
  if (!draft.classifierInstructions.trim()) {
    return "Routing rules are required so the classifier knows how to pick a tier.";
  }
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
