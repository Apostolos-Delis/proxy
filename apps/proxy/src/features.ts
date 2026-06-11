import { ROUTING_HINT_NAMES, type RoutingHintName } from "@prompt-proxy/schema";

import type { RouteContext } from "./types.js";
import { explicitAlias } from "./catalog.js";
import { isRecord, roughTokenEstimate, sha256, stableJson } from "./util.js";

const hintPatterns: Record<RoutingHintName, RegExp> = {
  quick: /\b(quick|simple|typo|format|rename|one-line)\b/i,
  deep: /\b(think hard|deep review|root cause|prove|exhaustive)\b/i,
  security: /\b(security|auth|oauth|permission|secret|crypto)\b/i,
  migration: /\b(migration|refactor|architecture|schema)\b/i,
  concurrency: /\b(concurrency|race condition|deadlock|lock)\b/i,
  failing_test: /\b(failing test|regression|flaky|stack trace|root cause)\b/i,
  production: /\b(production|data loss|payment|billing)\b/i
};

export function buildOpenAIContext(body: unknown, headers: Record<string, string | undefined>): RouteContext {
  const request = isRecord(body) ? body : {};
  const fullText = [
    stringifyText(request.instructions),
    stringifyText(request.input),
    stringifyText(request.metadata)
  ].join("\n");
  const latestUserText = latestOpenAIUserText(request.input);
  const routingInput = routingInputFrom(latestUserText, fullText);
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const requestedModel = typeof request.model === "string" ? request.model : "router-auto";

  return {
    surface: "openai-responses",
    requestedModel,
    inputChars: fullText.length,
    inputHash: sha256(fullText),
    estimatedInputTokens: roughTokenEstimate(fullText.length),
    routingInputSource: routingInput.source,
    routingInputText: routingInput.text,
    routingInputChars: routingInput.text.length,
    routingInputHash: sha256(routingInput.text),
    routingEstimatedInputTokens: roughTokenEstimate(routingInput.text.length),
    hasTools: tools.length > 0,
    toolCount: tools.length,
    hasPreviousResponseId: typeof request.previous_response_id === "string",
    hasImages: hasImageInput(request.input),
    extractedHints: extractHints(fullText),
    routingExtractedHints: extractHints(routingInput.text),
    sessionId: headers["x-codex-session-id"] ?? headers.session_id ?? headers["x-client-request-id"]
      ?? promptCacheKeySessionId(request.prompt_cache_key),
    userId: headers["x-prompt-proxy-user-id"] ?? headers["x-user-id"],
    teamId: headers["x-prompt-proxy-team-id"] ?? headers["x-team-id"],
    explicitAlias: explicitAlias("openai-responses", requestedModel)
  };
}

export function buildAnthropicContext(body: unknown, headers: Record<string, string | undefined>): RouteContext {
  const request = isRecord(body) ? body : {};
  const fullText = [
    stringifyText(request.system),
    stringifyText(request.messages),
    stringifyText(request.metadata)
  ].join("\n");
  const latestUserText = latestAnthropicUserText(request.messages);
  const routingInput = routingInputFrom(latestUserText, fullText);
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const requestedModel = typeof request.model === "string" ? request.model : "claude-router-auto";

  return {
    surface: "anthropic-messages",
    requestedModel,
    inputChars: fullText.length,
    inputHash: sha256(fullText),
    estimatedInputTokens: roughTokenEstimate(fullText.length),
    routingInputSource: routingInput.source,
    routingInputText: routingInput.text,
    routingInputChars: routingInput.text.length,
    routingInputHash: sha256(routingInput.text),
    routingEstimatedInputTokens: roughTokenEstimate(routingInput.text.length),
    hasTools: tools.length > 0,
    toolCount: tools.length,
    hasPreviousResponseId: false,
    hasImages: hasImageInput(request.messages),
    extractedHints: extractHints(fullText),
    routingExtractedHints: extractHints(routingInput.text),
    sessionId: headers["x-claude-code-session-id"] ?? anthropicMetadataSessionId(request.metadata),
    userId: headers["x-prompt-proxy-user-id"] ?? headers["x-user-id"],
    teamId: headers["x-prompt-proxy-team-id"] ?? headers["x-team-id"],
    explicitAlias: explicitAlias("anthropic-messages", requestedModel)
  };
}

export function classifierView(context: RouteContext, allowExcerpt: boolean, sourceText?: string) {
  return {
    surface: context.surface,
    requested_model: context.requestedModel,
    content_mode: allowExcerpt ? "redacted_excerpt" : "features_only",
    redaction_state: "redacted",
    routing_basis: context.routingInputSource,
    input_excerpt: allowExcerpt ? redactExcerpt(sourceText ?? context.routingInputText) : null,
    input_hash: context.routingInputHash,
    input_chars: context.routingInputChars,
    estimated_input_tokens: context.routingEstimatedInputTokens,
    full_input_hash: context.inputHash,
    full_input_chars: context.inputChars,
    full_estimated_input_tokens: context.estimatedInputTokens,
    has_tools: context.hasTools,
    tool_count: context.toolCount,
    has_previous_response_id: context.hasPreviousResponseId,
    has_images: context.hasImages,
    extracted_hints: context.routingExtractedHints,
    session_route: null,
    explicit_alias: context.explicitAlias ?? null
  };
}

// Claude Code stamps metadata.user_id as "user_<hash>_account_<uuid>_session_<uuid>";
// the session suffix links requests when no session header is configured.
function anthropicMetadataSessionId(metadata: unknown) {
  if (!isRecord(metadata) || typeof metadata.user_id !== "string") return undefined;
  const match = /_session_([0-9a-f][0-9a-f-]{7,})$/i.exec(metadata.user_id);
  return match?.[1];
}

// Codex sets prompt_cache_key to its conversation id on every request.
// Client-supplied, so only accept id-shaped values.
function promptCacheKeySessionId(value: unknown) {
  if (typeof value !== "string") return undefined;
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : undefined;
}

function routingInputFrom(latestUserText: string | undefined, fullText: string) {
  const text = latestUserText?.trim();
  if (text) {
    return {
      source: "latest_user_message" as const,
      text
    };
  }
  return {
    source: "full_request" as const,
    text: fullText
  };
}

function latestOpenAIUserText(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return undefined;

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item)) continue;
    if (item.role !== "user") continue;
    const text = textContent(item.content ?? item.text ?? item.input);
    if (text.trim()) return text;
  }
  return undefined;
}

function latestAnthropicUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = textContent(message.content);
    if (text.trim()) return text;
  }
  return undefined;
}

function textContent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("\n");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return textContent(value.content);
    return stringifyText(value);
  }
  return stableJson(value);
}

function stringifyText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringifyText).join("\n");
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${stringifyText(item)}`)
      .join("\n");
  }
  return stableJson(value);
}

function extractHints(text: string) {
  return ROUTING_HINT_NAMES.filter((name) => hintPatterns[name].test(text));
}

function hasImageInput(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasImageInput);
  if (!isRecord(value)) return false;

  const type = value.type;
  if (typeof type === "string" && /image/i.test(type)) return true;

  return Object.values(value).some(hasImageInput);
}

function redactExcerpt(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted_email]")
    .replace(/(sk|rk|pk|anthropic|claude|openai)[-_][A-Za-z0-9_-]{16,}/gi, "[redacted_token]")
    .slice(0, 1000);
}
