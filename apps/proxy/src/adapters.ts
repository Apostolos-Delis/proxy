import type { FastifyReply } from "fastify";

import { buildAnthropicContext, buildOpenAIContext } from "./features.js";
import type { RouteContext, RouteDecision, Surface, Provider, SelectedRouteSettings } from "./types.js";
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

export function rewriteSurfaceRequest(body: unknown, decision: RouteDecision) {
  if (!decision.providerSettings) {
    throw new Error("Cannot rewrite request without selected provider settings.");
  }
  if (decision.surface === "openai-responses" && decision.providerSettings.provider === "openai") {
    return rewriteOpenAIResponsesRequest(body, decision.providerSettings);
  }
  if (decision.surface === "anthropic-messages" && decision.providerSettings.provider === "anthropic") {
    return rewriteAnthropicMessagesRequest(body, decision.providerSettings);
  }
  throw new Error("Selected provider settings do not match the request surface.");
}

export function rewriteTokenCountRequest(body: unknown, decision: RouteDecision) {
  if (!decision.selectedModel) {
    throw new Error("Cannot rewrite token-count request without a selected model.");
  }

  const request = structuredClone(isRecord(body) ? body : {});
  request.model = decision.selectedModel;
  return request;
}

function rewriteOpenAIResponsesRequest(
  body: unknown,
  settings: Extract<SelectedRouteSettings, { provider: "openai" }>
) {
  const request = structuredClone(isRecord(body) ? body : {});
  request.model = settings.model;
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
  } else {
    delete request.max_output_tokens;
  }
  return request;
}

function rewriteAnthropicMessagesRequest(
  body: unknown,
  settings: Extract<SelectedRouteSettings, { provider: "anthropic" }>
) {
  const request = structuredClone(isRecord(body) ? body : {});
  request.model = settings.model;
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
  } else {
    delete request.max_tokens;
  }
  return request;
}
