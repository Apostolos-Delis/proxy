import { GATEWAY_MODEL_ENDPOINTS } from "@proxy/schema";

import { buildAnthropicContext, buildOpenAIChatContext, buildOpenAIContext } from "./features.js";
import type { Dialect, RouteContext, Surface } from "./types.js";

export type SurfaceAdapter = {
  readonly surface: Surface;
  readonly dialect: Dialect;
  readonly createOperation: string;
  readonly countTokensOperation?: string;
  buildContext(
    body: unknown,
    headers: Record<string, string | undefined>,
    transport?: RouteContext["transport"]
  ): RouteContext;
};

export const openAIResponsesSurface: SurfaceAdapter = {
  surface: GATEWAY_MODEL_ENDPOINTS.responsesHttp.wireId,
  dialect: GATEWAY_MODEL_ENDPOINTS.responsesHttp.wireId,
  createOperation: "openai-responses:create",
  buildContext: buildOpenAIContext
};

export const openAIChatSurface: SurfaceAdapter = {
  surface: GATEWAY_MODEL_ENDPOINTS.chatCompletions.wireId,
  dialect: GATEWAY_MODEL_ENDPOINTS.chatCompletions.wireId,
  createOperation: "openai-chat:create",
  buildContext: buildOpenAIChatContext
};

export const anthropicMessagesSurface: SurfaceAdapter = {
  surface: GATEWAY_MODEL_ENDPOINTS.messages.wireId,
  dialect: GATEWAY_MODEL_ENDPOINTS.messages.wireId,
  createOperation: "anthropic-messages:create",
  countTokensOperation: "anthropic-messages:count_tokens",
  buildContext: buildAnthropicContext
};
