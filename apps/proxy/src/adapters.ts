import type { FastifyReply } from "fastify";
import type { HarnessCompatibilityProfileId } from "@prompt-proxy/schema";

import { buildAnthropicContext, buildOpenAIChatContext, buildOpenAIContext } from "./features.js";
import { anthropicEffortForModel, supportsAnthropicAdaptiveThinking } from "./catalog.js";
import { translators } from "./translators/index.js";
import type { Dialect, JsonObject, RouteContext, RouteDecision, Surface, Provider, SelectedRouteSettings, UpstreamCredential } from "./types.js";
import { isRecord, roughTokenEstimate, stableJson } from "./util.js";

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
  onAssistantText?: (text: string, truncated: boolean) => Promise<void>;
  compressionTelemetry?: JsonObject;
  onTerminal?: (terminal: { status: "completed" | "failed" | "cancelled"; errorClass: string }) => void;
};

export type ProviderAdapter = {
  forward(input: ProviderForwardInput): Promise<void>;
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
  upgradeCacheTtl?: boolean;
  automaticCaching?: boolean;
};

const MIN_TTL_UPGRADE_CACHEABLE_TOKENS = 2048;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

export function rewriteSurfaceRequest(
  body: unknown,
  decision: RouteDecision,
  systemPrompt?: string,
  options: RewriteOptions = {}
) {
  if (!decision.providerSettings) {
    throw new Error("Cannot rewrite request without selected provider settings.");
  }
  const translator = translators.get(decision.surface, decision.providerSettings.dialect);
  if (decision.surface !== decision.providerSettings.dialect && !translator) {
    throw new Error("Selected provider settings do not match the request surface.");
  }
  const targetBody = translator ? translator.request(body) : body;
  if (decision.providerSettings.dialect === "openai-responses") {
    return rewriteOpenAIResponsesRequest(targetBody, decision.providerSettings, systemPrompt);
  }
  if (decision.providerSettings.dialect === "openai-chat") {
    return rewriteOpenAIChatRequest(targetBody, decision.providerSettings, systemPrompt);
  }
  if (decision.providerSettings.dialect === "anthropic-messages") {
    const rewritten = rewriteAnthropicMessagesRequest(targetBody, decision.providerSettings, systemPrompt);
    // Inject before the TTL policy runs so automatic breakpoints are eligible
    // for the same adaptive 1-hour upgrade as client-provided breakpoints.
    if (options.automaticCaching) injectAutomaticCacheControl(rewritten);
    if (options.upgradeCacheTtl && shouldUpgradeCacheControlTtl(rewritten)) upgradeCacheControlTtl(rewritten);
    return rewritten;
  }
  throw new Error("Selected provider settings do not match the request surface.");
}

export function rewriteTokenCountRequest(
  body: unknown,
  decision: RouteDecision,
  systemPrompt?: string,
  options: RewriteOptions = {}
) {
  if (!decision.selectedModel) {
    throw new Error("Cannot rewrite token-count request without a selected model.");
  }

  const request = structuredClone(isRecord(body) ? body : {});
  request.model = decision.selectedModel;
  if (decision.providerSettings?.dialect === "anthropic-messages" && systemPrompt) {
    request.system = prependAnthropicSystemPrompt(request.system, systemPrompt);
  }
  // Deliberately no automatic-caching injection here: cache_control changes
  // pricing, not token counts, so injecting would send count_tokens a field
  // it can't benefit from.
  if (options.upgradeCacheTtl && shouldUpgradeCacheControlTtl(request)) upgradeCacheControlTtl(request);
  return request;
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
  if (hasCacheControl(request)) return;
  if (!Array.isArray(request.messages)) return;
  if (!request.messages.some((message) => isRecord(message) && message.role === "assistant")) return;
  request.cache_control = { type: "ephemeral" };
}

function shouldUpgradeCacheControlTtl(request: Record<string, unknown>) {
  if (!Array.isArray(request.messages)) return false;
  if (!request.messages.some((message) => isRecord(message) && message.role === "assistant")) return false;
  return roughTokenEstimate(largestCacheControlPrefixChars(request)) >= MIN_TTL_UPGRADE_CACHEABLE_TOKENS;
}

function hasCacheControl(request: Record<string, unknown>): boolean {
  if (request.cache_control !== undefined) return true;
  if (anyBlockHasCacheControl(request.tools)) return true;
  if (anyBlockHasCacheControl(request.system)) return true;
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (isRecord(message) && anyBlockHasCacheControl(message.content)) return true;
    }
  }
  return false;
}

// Also recurses into nested content arrays (e.g. blocks inside a tool_result)
// so any marker anywhere suppresses injection — the conservative read of "the
// client already manages caching".
function anyBlockHasCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => anyBlockHasCacheControl(item));
  }
  if (!isRecord(value)) return false;
  if (value.cache_control !== undefined) return true;
  return Array.isArray(value.content) && anyBlockHasCacheControl(value.content);
}

function cacheablePrefixChars(request: Record<string, unknown>) {
  let chars = 0;
  chars += request.tools === undefined ? 0 : stableJson(request.tools).length;
  chars += contentChars(request.system);
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      chars += isRecord(message) ? contentChars(message.content) : contentChars(message);
    }
  }
  return chars;
}

function largestCacheControlPrefixChars(request: Record<string, unknown>) {
  let max = request.cache_control === undefined ? 0 : cacheablePrefixChars(request);
  let prefix = accumulateCacheablePrefix(request.tools, 0, (chars) => {
    max = Math.max(max, chars);
  });
  prefix = accumulateCacheablePrefix(request.system, prefix, (chars) => {
    max = Math.max(max, chars);
  });
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (isRecord(message)) {
        prefix += contentChars(message.role);
        prefix = accumulateCacheablePrefix(message.content, prefix, (chars) => {
          max = Math.max(max, chars);
        });
      } else {
        prefix = accumulateCacheablePrefix(message, prefix, (chars) => {
          max = Math.max(max, chars);
        });
      }
    }
  }
  return max;
}

function accumulateCacheablePrefix(
  value: unknown,
  prefix: number,
  onBreakpoint: (chars: number) => void
): number {
  if (Array.isArray(value)) {
    let current = prefix;
    for (const item of value) {
      current = accumulateCacheablePrefix(item, current, onBreakpoint);
    }
    return current;
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    const base = prefix + recordShellChars(value);
    const next = accumulateCacheablePrefix(value.content, base, onBreakpoint);
    if (value.cache_control !== undefined) onBreakpoint(next);
    return next;
  }
  const next = prefix + contentChars(value);
  if (isRecord(value) && value.cache_control !== undefined) onBreakpoint(next);
  return next;
}

function recordShellChars(value: Record<string, unknown>) {
  return Object.entries(value)
    .reduce((sum, [key, item]) => sum + key.length + (key === "content" ? 0 : contentChars(item)), 0);
}

function contentChars(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + contentChars(item), 0);
  if (isRecord(value)) {
    return Object.entries(value)
      .reduce((sum, [key, item]) => sum + key.length + contentChars(item), 0);
  }
  return 0;
}

// Mirrors the traversal of anyBlockHasCacheControl: every breakpoint the
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
  settings: SelectedRouteSettings,
  systemPrompt?: string
) {
  const request = structuredClone(isRecord(body) ? body : {});
  request.model = settings.model;
  request.store = false;
  delete request.prompt_cache_retention;
  if (systemPrompt) {
    request.instructions = typeof request.instructions === "string" && request.instructions.trim()
      ? `${systemPrompt}\n\n${request.instructions}`
      : systemPrompt;
  }
  if (settings.effort) {
    request.reasoning = {
      ...(isRecord(request.reasoning) ? request.reasoning : {}),
      effort: settings.effort === "max" ? "xhigh" : settings.effort
    };
  } else if (isRecord(request.reasoning)) {
    const reasoning = { ...request.reasoning };
    delete reasoning.effort;
    if (Object.keys(reasoning).length > 0) request.reasoning = reasoning;
    else delete request.reasoning;
  }
  if (settings.verbosity) {
    request.text = {
      ...(isRecord(request.text) ? request.text : {}),
      verbosity: settings.verbosity
    };
  } else if (isRecord(request.text)) {
    const text = { ...request.text };
    delete text.verbosity;
    if (Object.keys(text).length > 0) request.text = text;
    else delete request.text;
  }
  if (settings.maxOutputTokens !== undefined) {
    request.max_output_tokens = settings.maxOutputTokens;
  }
  return request;
}

function rewriteOpenAIChatRequest(
  body: unknown,
  settings: SelectedRouteSettings,
  systemPrompt?: string
) {
  const request = structuredClone(isRecord(body) ? body : {});
  request.model = settings.model;
  delete request.prompt_cache_retention;
  if (systemPrompt) {
    request.messages = prependOpenAIChatSystemPrompt(request.messages, systemPrompt);
  }
  if (settings.effort) {
    request.reasoning_effort = settings.effort === "max" ? "xhigh" : settings.effort;
  } else {
    delete request.reasoning_effort;
  }
  if (settings.maxOutputTokens !== undefined) {
    request.max_completion_tokens = settings.maxOutputTokens;
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
  settings: SelectedRouteSettings,
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
  const effort = settings.effort ? anthropicEffortForModel(settings.model, settings.effort) : undefined;
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
  if (settings.maxOutputTokens !== undefined) {
    request.max_tokens = settings.maxOutputTokens;
  } else if (request.max_tokens === undefined) {
    request.max_tokens = DEFAULT_ANTHROPIC_MAX_TOKENS;
  }
  return request;
}

function anthropicThinkingForSettings(settings: SelectedRouteSettings) {
  if (settings.thinking) {
    if (settings.thinking.type !== "adaptive" || supportsAnthropicAdaptiveThinking(settings.model)) return settings.thinking;
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
