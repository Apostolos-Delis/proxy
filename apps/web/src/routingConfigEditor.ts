import type { RoutingConfigDocument, RoutingConfigProviderSettings } from "./api";

export const editorRouteOrder = ["fast", "balanced", "hard", "deep"] as const;

export type EditorRouteName = typeof editorRouteOrder[number];

export type ConfigEditorDraft = {
  systemPrompt: string;
  classifierInstructions: string;
  routes: Record<EditorRouteName, { openaiModel: string; anthropicModel: string }>;
};

export function draftFromConfig(config: RoutingConfigDocument): ConfigEditorDraft {
  const routes = {} as ConfigEditorDraft["routes"];
  for (const route of editorRouteOrder) {
    routes[route] = {
      openaiModel: config.routes[route]?.openai?.model ?? "",
      anthropicModel: config.routes[route]?.anthropic?.model ?? ""
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
    const openai = providerBlock(baseRoute.openai, draft.routes[route].openaiModel);
    const anthropic = providerBlock(baseRoute.anthropic, draft.routes[route].anthropicModel);
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

export function effortHint(settings?: RoutingConfigProviderSettings) {
  const effort = settings?.reasoning?.effort ?? settings?.output_config?.effort;
  if (effort) return `effort ${effort}`;
  return settings?.thinking?.type ? `thinking ${settings.thinking.type}` : undefined;
}

function providerBlock(base: RoutingConfigProviderSettings | undefined, model: string) {
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return { ...base, model: trimmed };
}
