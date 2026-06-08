import type { AppConfig } from "./config.js";
import type {
  ModelCatalogEntry,
  Provider,
  ReasoningEffort,
  RouteConfig,
  RouteName,
  Surface
} from "./types.js";

export type ModelCatalog = Readonly<Record<string, ModelCatalogEntry>>;

export const routeOrder: RouteName[] = ["fast", "balanced", "hard", "deep"];

export const routes: Record<RouteName, RouteConfig> = {
  fast: {
    name: "fast",
    openaiModel: "openai-fast",
    anthropicModel: "anthropic-fast",
    reasoningEffort: "low",
    verbosity: "low"
  },
  balanced: {
    name: "balanced",
    openaiModel: "openai-balanced",
    anthropicModel: "anthropic-balanced",
    reasoningEffort: "medium",
    verbosity: "low"
  },
  hard: {
    name: "hard",
    openaiModel: "openai-hard",
    anthropicModel: "anthropic-hard",
    reasoningEffort: "high",
    verbosity: "medium"
  },
  deep: {
    name: "deep",
    openaiModel: "openai-deep",
    anthropicModel: "anthropic-deep",
    reasoningEffort: "xhigh",
    verbosity: "medium"
  }
};

export function buildModelCatalog(config: AppConfig): ModelCatalog {
  const catalog: Record<string, ModelCatalogEntry> = {
    "openai-fast": openaiModel(config, "openai-fast", config.openaiFastModel, ["low", "medium"]),
    "openai-balanced": openaiModel(config, "openai-balanced", config.openaiBalancedModel, [
      "low",
      "medium",
      "high"
    ]),
    "openai-hard": openaiModel(config, "openai-hard", config.openaiHardModel, [
      "medium",
      "high",
      "xhigh"
    ]),
    "openai-deep": openaiModel(config, "openai-deep", config.openaiDeepModel, ["high", "xhigh"]),
    "anthropic-fast": anthropicModel(config, "anthropic-fast", config.anthropicFastModel, [
      "low",
      "medium"
    ]),
    "anthropic-balanced": anthropicModel(
      config,
      "anthropic-balanced",
      config.anthropicBalancedModel,
      ["low", "medium", "high"]
    ),
    "anthropic-hard": anthropicModel(config, "anthropic-hard", config.anthropicHardModel, [
      "medium",
      "high",
      "xhigh"
    ]),
    "anthropic-deep": anthropicModel(config, "anthropic-deep", config.anthropicDeepModel, [
      "high",
      "xhigh"
    ])
  };
  return Object.freeze(catalog);
}

export const openaiAliases = new Map<string, RouteName>([
  ["router-fast", "fast"],
  ["router-balanced", "balanced"],
  ["router-hard", "hard"],
  ["router-deep", "deep"]
]);

export const anthropicAliases = new Map<string, RouteName>([
  ["claude-router-fast", "fast"],
  ["claude-router-balanced", "balanced"],
  ["claude-router-hard", "hard"],
  ["claude-router-deep", "deep"],
  ["anthropic-router-fast", "fast"],
  ["anthropic-router-balanced", "balanced"],
  ["anthropic-router-hard", "hard"],
  ["anthropic-router-deep", "deep"]
]);

export function isAutoAlias(surface: Surface, model: string) {
  if (surface === "openai-responses") return model === "router-auto";
  return model === "claude-router-auto" || model === "anthropic-router-auto";
}

export function explicitAlias(surface: Surface, model: string): RouteName | undefined {
  if (surface === "openai-responses") return openaiAliases.get(model);
  return anthropicAliases.get(model);
}

export function routeModel(route: RouteName, surface: Surface) {
  const config = routes[route];
  return surface === "openai-responses" ? config.openaiModel : config.anthropicModel;
}

export function modelForRoute(catalog: ModelCatalog, route: RouteName, surface: Surface) {
  return catalog[routeModel(route, surface)];
}

export function supportsSurface(model: ModelCatalogEntry, surface: Surface) {
  return surface === "openai-responses"
    ? model.supportsResponses
    : model.supportsMessages;
}

export function nearestReasoningEffort(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[]
) {
  if (supported.includes(requested)) return requested;
  const order: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
  const requestedIndex = order.indexOf(requested);

  return [...supported].sort((left, right) => {
    return Math.abs(order.indexOf(left) - requestedIndex) - Math.abs(order.indexOf(right) - requestedIndex);
  })[0];
}

function openaiModel(
  config: AppConfig,
  id: string,
  upstreamModel: string,
  efforts: ReasoningEffort[]
): ModelCatalogEntry {
  return model(config, id, "openai", upstreamModel, true, false, efforts);
}

function anthropicModel(
  config: AppConfig,
  id: string,
  upstreamModel: string,
  efforts: ReasoningEffort[]
): ModelCatalogEntry {
  return model(config, id, "anthropic", upstreamModel, false, true, efforts);
}

function model(
  config: AppConfig,
  id: string,
  provider: Provider,
  upstreamModel: string,
  supportsResponses: boolean,
  supportsMessages: boolean,
  efforts: ReasoningEffort[]
): ModelCatalogEntry {
  const cost = config.modelCosts[upstreamModel] ?? {
    inputCostPerMtok: 0,
    outputCostPerMtok: 0
  };
  return Object.freeze({
    id,
    provider,
    upstreamModel,
    supportsResponses,
    supportsMessages,
    supportsTools: true,
    supportsStreaming: true,
    supportsReasoning: true,
    supportedReasoningEfforts: Object.freeze([...efforts]),
    supportsVerbosity: provider === "openai",
    contextWindow: 400000,
    inputCostPerMtok: cost.inputCostPerMtok,
    outputCostPerMtok: cost.outputCostPerMtok
  });
}
