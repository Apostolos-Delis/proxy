import type { FastifyReply } from "fastify";

import { buildAnthropicContext, buildOpenAIContext } from "./features.js";
import type { RouteContext, RouteDecision, Surface, Provider } from "./types.js";

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
