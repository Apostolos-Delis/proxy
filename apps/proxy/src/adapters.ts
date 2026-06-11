import type { FastifyReply } from "fastify";

import { buildAnthropicContext, buildOpenAIContext } from "./features.js";
import type { RouteContext, RouteDecision, Surface, Provider, SelectedRouteSettings, UpstreamCredential } from "./types.js";
import { isRecord } from "./util.js";

export type SurfaceAdapter = {
  readonly surface: Surface;
  readonly provider: Provider;
  readonly createOperation: string;
  readonly countTokensOperation?: string;
  buildContext(body: unknown, headers: Record<string, string | undefined>): RouteContext;
};

export type ProviderForwardInput = {
  requestId: string;
  idempotencyKey: string;
  surface: Surface;
  provider: Provider;
  body: unknown;
  headers: Record<string, string | undefined>;
  decision: RouteDecision;
  reply: FastifyReply;
  path?: string;
  credential?: UpstreamCredential;
  onAssistantText?: (text: string, truncated: boolean) => Promise<void>;
};

export type ProviderAdapter = {
  forward(input: ProviderForwardInput): Promise<void>;
};

export const openAIResponsesSurface: SurfaceAdapter = {
  surface: "openai-responses",
  provider: "openai",
  createOperation: "openai-responses:create",
  buildContext: buildOpenAIContext
};

export const anthropicMessagesSurface: SurfaceAdapter = {
  surface: "anthropic-messages",
  provider: "anthropic",
  createOperation: "anthropic-messages:create",
  countTokensOperation: "anthropic-messages:count_tokens",
  buildContext: buildAnthropicContext
};

export type RewriteOptions = {
  upgradeCacheTtl?: boolean;
};

export function rewriteSurfaceRequest(
  body: unknown,
  decision: RouteDecision,
  systemPrompt?: string,
  options: RewriteOptions = {}
) {
  if (!decision.providerSettings) {
    throw new Error("Cannot rewrite request without selected provider settings.");
  }
  if (decision.surface === "openai-responses" && decision.providerSettings.provider === "openai") {
    return rewriteOpenAIResponsesRequest(body, decision.providerSettings, systemPrompt);
  }
  if (decision.surface === "anthropic-messages" && decision.providerSettings.provider === "anthropic") {
    const rewritten = rewriteAnthropicMessagesRequest(body, decision.providerSettings, systemPrompt);
    if (options.upgradeCacheTtl) upgradeCacheControlTtl(rewritten);
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
  if (decision.providerSettings?.provider === "anthropic" && systemPrompt) {
    request.system = prependAnthropicSystemPrompt(request.system, systemPrompt);
  }
  if (options.upgradeCacheTtl) upgradeCacheControlTtl(request);
  return request;
}

// Upgrade Anthropic ephemeral cache_control breakpoints from the default
// 5-minute TTL to 1-hour, wherever the harness placed them (system blocks and
// any message content block). The 1h TTL costs 2× to write (vs 1.25× for 5m)
// but breaks even at 3 reads — easily cleared by agentic sessions with gaps
// past the 5m default. Upgrading every breakpoint (not just the latest turn's)
// is what keeps the transform byte-stable across turns: a block that carried
// ttl:1h while it was the live turn still reads ttl:1h once it becomes history,
// so the cached prefix never shifts. An explicitly-set ttl is left untouched —
// the harness chose it deliberately.
function upgradeCacheControlTtl(request: Record<string, unknown>) {
  upgradeInValue(request.system);
  if (Array.isArray(request.messages)) {
    for (const message of request.messages) {
      if (isRecord(message)) upgradeInValue(message.content);
    }
  }
}

function upgradeInValue(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) upgradeBlock(item);
    return;
  }
  upgradeBlock(value);
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
  settings: Extract<SelectedRouteSettings, { provider: "openai" }>,
  systemPrompt?: string
) {
  const request = structuredClone(isRecord(body) ? body : {});
  request.model = settings.model;
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

function rewriteAnthropicMessagesRequest(
  body: unknown,
  settings: Extract<SelectedRouteSettings, { provider: "anthropic" }>,
  systemPrompt?: string
) {
  const request = structuredClone(isRecord(body) ? body : {});
  request.model = settings.model;
  if (systemPrompt) {
    request.system = prependAnthropicSystemPrompt(request.system, systemPrompt);
  }
  if (settings.anthropic.thinking) {
    request.thinking = settings.anthropic.thinking;
  } else {
    delete request.thinking;
  }
  if (settings.anthropic.output_config) {
    request.output_config = {
      ...(isRecord(request.output_config) ? request.output_config : {}),
      ...settings.anthropic.output_config
    };
  } else if (isRecord(request.output_config)) {
    const outputConfig = { ...request.output_config };
    delete outputConfig.effort;
    if (Object.keys(outputConfig).length > 0) request.output_config = outputConfig;
    else delete request.output_config;
  }
  if (settings.anthropic.maxTokens !== undefined) {
    request.max_tokens = settings.anthropic.maxTokens;
  }
  return request;
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
