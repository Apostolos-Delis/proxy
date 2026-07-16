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
