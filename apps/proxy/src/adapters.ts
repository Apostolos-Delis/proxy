import type { FastifyReply } from "fastify";
import type {
  HarnessCompatibilityProfileId,
  ProviderCachingCapabilities
} from "@proxy/schema";
import {
  anthropicEffortForModel,
  effortSchema,
  supportsAnthropicAdaptiveThinking
} from "@proxy/schema";

import { buildAnthropicContext, buildOpenAIChatContext, buildOpenAIContext } from "./features.js";
import { resolveBedrockConverseModelId } from "./providerAdapters/bedrockModelIds.js";
import type { RequestTiming } from "./requestTiming.js";
import {
  computePromptCachePlan,
  hasAnthropicCacheControl,
  isAnthropicCacheTtlUpgradeEligible,
  isAnthropicMultiTurnRequest,
  type PromptCachePlan,
  type PromptCachePlanSettings
} from "./promptCachePlan.js";
import { translators } from "./translators/index.js";
import type {
  Dialect,
  JsonObject,
  Provider,
  ProviderAdapterKind,
  ProviderEffort,
  RouteContext,
  RouteDecision,
  SelectedDeployment,
  Surface,
  SelectedRouteSettings,
  UpstreamCredential
} from "./types.js";
import { isRecord } from "./util.js";

export type SurfaceAdapter = {
  readonly surface: Surface;
  readonly dialect: Dialect;
  readonly createOperation: string;
  readonly countTokensOperation?: string;
  buildContext(body: unknown, headers: Record<string, string | undefined>, transport?: RouteContext["transport"]): RouteContext;
};

export type ProviderForwardInput = {
  requestId: string;
  idempotencyKey: string;
  organizationId: string;
  workspaceId: string;
  sessionId?: string;
  surface: Surface;
  provider: Provider;
  harnessProfileId?: HarnessCompatibilityProfileId;
  body: unknown;
  responseStream?: boolean;
  headers: Record<string, string | undefined>;
  decision: RouteDecision;
  reply: FastifyReply;
  path?: string;
  credential?: UpstreamCredential;
  acquireProviderLimit?: (attempt: ProviderForwardAttemptInput) => Promise<ProviderForwardLease | undefined>;
  onAssistantText?: (text: string, truncated: boolean) => Promise<void>;
  compressionTelemetry?: JsonObject;
  onTerminal?: (terminal: { status: "completed" | "failed" | "cancelled"; errorClass: string }) => void;
  timing?: RequestTiming;
};

export type ProviderForwardLease = {
  release: () => void;
};

export type ProviderForwardResult = "forwarded" | "rejected";

export type ProviderForwardAttemptInput = {
  selectedModel: string;
  provider: Provider;
  adapterKind?: ProviderAdapterKind;
  deployment?: SelectedDeployment;
  reasoningEffort?: ProviderEffort;
  body: unknown;
  credential?: UpstreamCredential;
  providerSettings?: SelectedRouteSettings;
  promptCachePlan?: PromptCachePlan;
};

export type ProviderAdapter = {
  forward(input: ProviderForwardInput): Promise<ProviderForwardResult>;
};

export const openAIResponsesSurface: SurfaceAdapter = {
  surface: "openai-responses",
  dialect: "openai-responses",
  createOperation: "openai-responses:create",
  buildContext: buildOpenAIContext
};

export const openAIChatSurface: SurfaceAdapter = {
  surface: "openai-chat",
  dialect: "openai-chat",
  createOperation: "openai-chat:create",
  buildContext: buildOpenAIChatContext
};

export const anthropicMessagesSurface: SurfaceAdapter = {
  surface: "anthropic-messages",
  dialect: "anthropic-messages",
  createOperation: "anthropic-messages:create",
  countTokensOperation: "anthropic-messages:count_tokens",
  buildContext: buildAnthropicContext
};

export type RewriteOptions = {
  promptCachePlan?: PromptCachePlan;
};

export type RewriteWithPromptCachePlanOptions = {
  context: Pick<RouteContext, "surface"> & Partial<Pick<RouteContext, "transport" | "harnessProfileId" | "estimatedInputTokens" | "sessionId">>;
  capabilities?: ProviderCachingCapabilities;
  settings?: PromptCachePlanSettings;
};

export type RewriteWithPromptCachePlanResult = {
  body: unknown;
  promptCachePlan: PromptCachePlan;
};

const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

export function rewriteSurfaceRequest(
  body: unknown,
  decision: RouteDecision,
  systemPrompt?: string,
  options: RewriteOptions = {}
) {
  const rewritten = rewriteSurfaceRequestBase(body, decision, systemPrompt);
  applyPromptCachePlan(rewritten, options.promptCachePlan, true);
  return rewritten;
}

export function rewriteSurfaceRequestWithPromptCachePlan(
  body: unknown,
  decision: RouteDecision,
  systemPrompt: string | undefined,
  options: RewriteWithPromptCachePlanOptions
): RewriteWithPromptCachePlanResult {
  const rewritten = rewriteSurfaceRequestBase(body, decision, systemPrompt);
  const promptCachePlan = computePromptCachePlan({
    body: rewritten,
    bodyDialect: decision.providerSettings?.dialect,
    sourceBody: body,
    context: options.context,
    decision,
    capabilities: options.capabilities,
    settings: options.settings
  });
  applyPromptCachePlan(rewritten, promptCachePlan, true);
  return { body: rewritten, promptCachePlan };
}

function rewriteSurfaceRequestBase(
  body: unknown,
  decision: RouteDecision,
  systemPrompt?: string
) {
  if (!decision.providerSettings) {
    throw new Error("Cannot rewrite request without selected provider settings.");
  }
  const translator = translators.get(decision.surface, decision.providerSettings.dialect);
  if (decision.surface !== decision.providerSettings.dialect && !translator) {
    throw new Error("Selected provider settings do not match the request surface.");
  }
  const targetBody = translator ? translator.request(body) : body;
  const settings = decision.providerSettings;
  if ("openai" in settings && settings.dialect === "openai-responses") {
    return rewriteOpenAIResponsesRequest(targetBody, settings, systemPrompt);
  }
  if ("openai" in settings && settings.dialect === "openai-chat") {
    return rewriteOpenAIChatRequest(targetBody, settings, systemPrompt);
  }
  if ("anthropic" in settings && settings.dialect === "anthropic-messages") {
    return rewriteAnthropicMessagesRequest(targetBody, settings, systemPrompt);
  }
  if (settings.dialect === "bedrock-converse") {
    return rewriteBedrockConverseRequest(targetBody, settings, systemPrompt);
  }
  throw new Error("Selected provider settings do not match the request surface.");
}

export function rewriteTokenCountRequest(
  body: unknown,
  decision: RouteDecision,
  systemPrompt?: string,
  options: RewriteOptions = {}
) {
  const request = rewriteTokenCountRequestBase(body, decision, systemPrompt);
  applyPromptCachePlan(request, options.promptCachePlan, false);
  return request;
}

export function rewriteTokenCountRequestWithPromptCachePlan(
  body: unknown,
  decision: RouteDecision,
  systemPrompt: string | undefined,
  options: RewriteWithPromptCachePlanOptions
): RewriteWithPromptCachePlanResult {
  const request = rewriteTokenCountRequestBase(body, decision, systemPrompt);
  const settings = { ...options.settings, automaticCaching: false };
  const promptCachePlan = computePromptCachePlan({
    body: request,
    bodyDialect: decision.providerSettings?.dialect,
    sourceBody: body,
    context: options.context,
    decision,
    capabilities: options.capabilities,
    settings
  });
  applyPromptCachePlan(request, promptCachePlan, false);
  return { body: request, promptCachePlan };
}

function rewriteTokenCountRequestBase(
  body: unknown,
  decision: RouteDecision,
  systemPrompt?: string
) {
  if (!decision.selectedModel) {
    throw new Error("Cannot rewrite token-count request without a selected model.");
  }

  const request = structuredClone(isRecord(body) ? body : {});
  request.model = decision.selectedModel;
  if (decision.providerSettings && "anthropic" in decision.providerSettings && decision.providerSettings.dialect === "anthropic-messages" && systemPrompt) {
    request.system = prependAnthropicSystemPrompt(request.system, systemPrompt);
  }
  // Deliberately no automatic-caching injection here: cache_control changes
  // pricing, not token counts, so injecting would send count_tokens a field
  // it can't benefit from.
  return request;
}

export function applyPromptCachePlan(
  request: unknown,
  plan: PromptCachePlan | undefined,
  allowAutomaticCaching: boolean
) {
  if (!isRecord(request) || !plan || plan.dialect !== "anthropic-messages") return;
  if (allowAutomaticCaching && plan.appliedControls.includes("top_level_auto_breakpoint")) {
    injectAutomaticCacheControl(request);
  }
  if (plan.appliedControls.includes("ttl_1h") && isAnthropicCacheTtlUpgradeEligible(request)) {
    upgradeCacheControlTtl(request);
  }
}

// Upgrade Anthropic ephemeral cache_control breakpoints from the default
// 5-minute TTL to 1-hour, wherever the harness placed them (the top-level
// automatic-caching field, tool definitions, system blocks, and any message
// content block). The 1h TTL costs 2× to write (vs 1.25× for 5m) but breaks
// even at 3 reads — easily cleared by agentic sessions with gaps past the 5m
// default. Upgrading every breakpoint (not just the latest turn's) is what
// keeps the transform byte-stable across turns: a block that carried ttl:1h
// while it was the live turn still reads ttl:1h once it becomes history, so
// the cached prefix never shifts. Upgrading all of them is also what keeps
// the request valid: Anthropic rejects requests where a longer-TTL breakpoint
// follows a shorter one, so a partial upgrade could 400. An explicitly-set
// ttl is left untouched — the harness chose it deliberately.
function upgradeCacheControlTtl(request: Record<string, unknown>) {
  upgradeBlock(request);
  upgradeInValue(request.tools);
  upgradeInValue(request.system);
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (isRecord(message)) upgradeInValue(message.content);
    }
  }
}

// Anthropic's top-level automatic-caching field: the API places a breakpoint
// on the last cacheable block and advances it as the conversation grows. Only
// requests that carry no cache_control anywhere get it — a client that placed
// its own breakpoints (or deliberately opted out of a marker) keeps control —
// and only multi-turn requests: an assistant turn proves the prefix is being
// re-sent, so the cache-write surcharge is recovered by follow-up reads,
// while one-shot prompts never pay it.
function injectAutomaticCacheControl(request: Record<string, unknown>) {
  if (hasAnthropicCacheControl(request)) return;
  if (!isAnthropicMultiTurnRequest(request)) return;
  request.cache_control = { type: "ephemeral" };
}

// Mirrors the traversal of hasAnthropicCacheControl: every breakpoint the
// guard can see, the upgrade must reach — a nested breakpoint left at 5m
// behind an upgraded 1h one would violate the longer-TTL-first ordering.
function upgradeInValue(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) upgradeInValue(item);
    return;
  }
  upgradeBlock(value);
  if (isRecord(value) && Array.isArray(value.content)) upgradeInValue(value.content);
}

function upgradeBlock(block: unknown) {
  if (!isRecord(block)) return;
  const cc = block.cache_control;
  if (isRecord(cc) && cc.type === "ephemeral" && !cc.ttl) {
    block.cache_control = { type: "ephemeral", ttl: "1h" };
  }
}

function rewriteOpenAIResponsesRequest(
  body: unknown,
  settings: Extract<SelectedRouteSettings, { openai: unknown }>,
  systemPrompt?: string
) {
  const request = structuredClone(isRecord(body) ? body : {});
  request.model = settings.model;
  if (request.store === undefined) request.store = false;
  if (systemPrompt) {
    request.instructions = typeof request.instructions === "string" && request.instructions.trim()
      ? `${systemPrompt}\n\n${request.instructions}`
      : systemPrompt;
  }
  if (settings.openai.reasoning) {
    request.reasoning = {
      ...(isRecord(request.reasoning) ? request.reasoning : {}),
      ...settings.openai.reasoning
    };
  } else if (isRecord(request.reasoning)) {
    const reasoning = { ...request.reasoning };
    delete reasoning.effort;
    if (Object.keys(reasoning).length > 0) request.reasoning = reasoning;
    else delete request.reasoning;
  }
  if (settings.openai.text) {
    request.text = {
      ...(isRecord(request.text) ? request.text : {}),
      ...settings.openai.text
    };
  } else if (isRecord(request.text)) {
    const text = { ...request.text };
    delete text.verbosity;
    if (Object.keys(text).length > 0) request.text = text;
    else delete request.text;
  }
  if (settings.openai.maxOutputTokens !== undefined) {
    request.max_output_tokens = settings.openai.maxOutputTokens;
  }
  return request;
}

function rewriteOpenAIChatRequest(
  body: unknown,
  settings: Extract<SelectedRouteSettings, { openai: unknown }>,
  systemPrompt?: string
) {
  const request = structuredClone(isRecord(body) ? body : {});
  request.model = settings.model;
  if (systemPrompt) {
    request.messages = prependOpenAIChatSystemPrompt(request.messages, systemPrompt);
  }
  if (settings.openai.reasoning?.effort) {
    request.reasoning_effort = settings.openai.reasoning.effort;
  } else {
    delete request.reasoning_effort;
  }
  if (settings.openai.maxOutputTokens !== undefined) {
    request.max_completion_tokens = settings.openai.maxOutputTokens;
  }
  if (request.stream === true) {
    const streamOptions = isRecord(request.stream_options) ? request.stream_options : {};
    if (streamOptions.include_usage === undefined) {
      request.stream_options = { ...streamOptions, include_usage: true };
    }
  }
  return request;
}

function prependOpenAIChatSystemPrompt(messages: unknown, systemPrompt: string) {
  const systemMessage = { role: "system", content: systemPrompt };
  if (Array.isArray(messages)) return [systemMessage, ...messages];
  return [systemMessage];
}

function rewriteAnthropicMessagesRequest(
  body: unknown,
  settings: Extract<SelectedRouteSettings, { anthropic: unknown }>,
  systemPrompt?: string
) {
  const request = structuredClone(isRecord(body) ? body : {});
  request.model = settings.model;
  if (systemPrompt) {
    request.system = prependAnthropicSystemPrompt(request.system, systemPrompt);
  }
  const thinking = anthropicThinkingForSettings(settings);
  if (thinking) {
    request.thinking = thinking;
  } else {
    delete request.thinking;
  }
  if (!isAnthropicThinkingEnabled(request.thinking)) removeClearThinkingContextManagement(request);
  const configuredEffort = effortSchema.safeParse(settings.anthropic.output_config?.effort);
  const effort = configuredEffort.success
    ? anthropicEffortForModel(settings.model, configuredEffort.data)
    : undefined;
  if (effort) {
    request.output_config = {
      ...(isRecord(request.output_config) ? request.output_config : {}),
      effort
    };
  } else if (isRecord(request.output_config) && anthropicEffortForModel(settings.model, "high")) {
    const outputConfig = { ...request.output_config };
    delete outputConfig.effort;
    if (Object.keys(outputConfig).length > 0) request.output_config = outputConfig;
    else delete request.output_config;
  } else {
    delete request.output_config;
  }
  if (settings.anthropic.maxTokens !== undefined) {
    request.max_tokens = settings.anthropic.maxTokens;
  } else if (request.max_tokens === undefined) {
    request.max_tokens = DEFAULT_ANTHROPIC_MAX_TOKENS;
  }
  return request;
}

function rewriteBedrockConverseRequest(
  body: unknown,
  settings: SelectedRouteSettings,
  systemPrompt?: string
) {
  const request = structuredClone(isRecord(body) ? body : {});
  const bedrockSettings = bedrockMetadataSettings("openai" in settings ? settings.openai.metadata : settings.anthropic.metadata);
  request.modelId = resolveBedrockConverseModelId({
    modelId: settings.model,
    inferenceProfile: stringValue(bedrockSettings?.inferenceProfile) ?? stringValue(bedrockSettings?.inferenceProfileId),
    inferenceProfileGeography: stringValue(bedrockSettings?.inferenceProfileGeography) ?? stringValue(bedrockSettings?.profileGeography)
  });
  delete request.stream;
  if (systemPrompt) {
    const existingSystem = Array.isArray(request.system) ? request.system : [];
    request.system = [{ text: systemPrompt }, ...existingSystem];
  }
  const maxTokens = "openai" in settings
    ? settings.openai.maxOutputTokens
    : settings.anthropic.maxTokens;
  if (maxTokens !== undefined) {
    request.inferenceConfig = {
      ...(isRecord(request.inferenceConfig) ? request.inferenceConfig : {}),
      maxTokens
    };
  }
  applyBedrockMetadataConfig(request, bedrockSettings);
  return request;
}

function applyBedrockMetadataConfig(request: Record<string, unknown>, settings: Record<string, unknown> | undefined) {
  if (!settings) return;
  const requestMetadata = stringRecord(settings.requestMetadata);
  if (requestMetadata) request.requestMetadata = requestMetadata;
  const guardrailIdentifier = stringValue(settings.guardrailIdentifier);
  const guardrailVersion = stringValue(settings.guardrailVersion);
  if (guardrailIdentifier && guardrailVersion) {
    request.guardrailConfig = {
      guardrailIdentifier,
      guardrailVersion,
      ...(settings.guardrailTrace === "enabled" || settings.guardrailTrace === "disabled" ? { trace: settings.guardrailTrace } : {})
    };
  }
  const latency = stringValue(settings.serviceTier) ?? stringValue(settings.latency);
  if (latency === "standard" || latency === "optimized") {
    request.performanceConfig = { latency };
  }
  if (isRecord(settings.additionalModelRequestFields)) {
    request.additionalModelRequestFields = settings.additionalModelRequestFields;
  }
}

function bedrockMetadataSettings(metadata: unknown) {
  if (!isRecord(metadata)) return undefined;
  const candidate = metadata.bedrockConverse ?? metadata.bedrock ?? metadata.bedrockSettings;
  return isRecord(candidate) ? candidate : undefined;
}

function stringRecord(value: unknown) {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function anthropicThinkingForSettings(settings: Extract<SelectedRouteSettings, { anthropic: unknown }>) {
  if (settings.anthropic.thinking) {
    if (settings.anthropic.thinking.type !== "adaptive" || supportsAnthropicAdaptiveThinking(settings.model)) {
      return settings.anthropic.thinking;
    }
    return undefined;
  }
  return undefined;
}

function isAnthropicThinkingEnabled(thinking: unknown) {
  return isRecord(thinking) && (thinking.type === "adaptive" || thinking.type === "enabled");
}

function removeClearThinkingContextManagement(request: Record<string, unknown>) {
  if (!isRecord(request.context_management)) return;
  const edits = request.context_management.edits;
  if (!Array.isArray(edits)) return;
  const filtered = edits.filter((edit) => !isRecord(edit) || edit.type !== "clear_thinking_20251015");
  if (filtered.length === edits.length) return;
  if (filtered.length > 0) {
    request.context_management = { ...request.context_management, edits: filtered };
    return;
  }
  const contextManagement = { ...request.context_management };
  delete contextManagement.edits;
  if (Object.keys(contextManagement).length > 0) request.context_management = contextManagement;
  else delete request.context_management;
}

function prependAnthropicSystemPrompt(system: unknown, systemPrompt: string) {
  if (Array.isArray(system)) {
    return [{ type: "text", text: systemPrompt }, ...system];
  }
  if (typeof system === "string" && system.trim()) {
    return `${systemPrompt}\n\n${system}`;
  }
  return systemPrompt;
}
