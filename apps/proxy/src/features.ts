import { ROUTING_HINT_NAMES, type RoutingHintName } from "@prompt-proxy/schema";

import type { RouteContext } from "./types.js";
import { explicitAlias } from "./catalog.js";
import { detectHarness, promptBlockTagsForSurface } from "./harness.js";
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
  const surface = "openai-responses";
  const profile = detectHarness({ surface, body: request, headers });
  const promptBlockTags = promptBlockTagsForSurface(surface);
  const fullText = [
    stringifyText(request.instructions),
    stringifyText(request.input),
    stringifyText(request.metadata)
  ].join("\n");
  const latestUserText = latestOpenAIUserText(request.input, promptBlockTags);
  const routingInput = routingInputFrom(latestUserText, fullText);
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const requestedModel = typeof request.model === "string" ? request.model : "router-auto";

  return {
    surface,
    harness: profile.name,
    statefulResponses: profile.statefulResponses,
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
    sessionId: profile.sessionId(request, headers),
    userId: headers["x-prompt-proxy-user-id"] ?? headers["x-user-id"],
    teamId: headers["x-prompt-proxy-team-id"] ?? headers["x-team-id"],
    explicitAlias: explicitAlias(surface, requestedModel)
  };
}

export function buildOpenAIChatContext(body: unknown, headers: Record<string, string | undefined>): RouteContext {
  const request = isRecord(body) ? body : {};
  const surface = "openai-chat";
  const profile = detectHarness({ surface, body: request, headers });
  const promptBlockTags = promptBlockTagsForSurface(surface);
  const fullText = [
    stringifyText(request.messages),
    stringifyText(request.metadata)
  ].join("\n");
  const latestUserText = latestOpenAIChatUserText(request.messages, promptBlockTags);
  const routingInput = routingInputFrom(latestUserText, fullText);
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const requestedModel = typeof request.model === "string" ? request.model : "router-auto";

  return {
    surface,
    harness: profile.name,
    statefulResponses: profile.statefulResponses,
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
    sessionId: profile.sessionId(request, headers),
    userId: headers["x-prompt-proxy-user-id"] ?? headers["x-user-id"],
    teamId: headers["x-prompt-proxy-team-id"] ?? headers["x-team-id"],
    explicitAlias: explicitAlias(surface, requestedModel)
  };
}

export function buildAnthropicContext(body: unknown, headers: Record<string, string | undefined>): RouteContext {
  const request = isRecord(body) ? body : {};
  const surface = "anthropic-messages";
  const profile = detectHarness({ surface, body: request, headers });
  const promptBlockTags = promptBlockTagsForSurface(surface);
  const fullText = [
    stringifyText(request.system),
    stringifyText(request.messages),
    stringifyText(request.metadata)
  ].join("\n");
  const latestUserText = latestAnthropicUserText(request.messages, promptBlockTags);
  const routingInput = routingInputFrom(latestUserText, fullText);
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const requestedModel = typeof request.model === "string" ? request.model : "claude-router-auto";

  return {
    surface,
    harness: profile.name,
    statefulResponses: profile.statefulResponses,
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
    sessionId: profile.sessionId(request, headers),
    userId: headers["x-prompt-proxy-user-id"] ?? headers["x-user-id"],
    teamId: headers["x-prompt-proxy-team-id"] ?? headers["x-team-id"],
    explicitAlias: explicitAlias(surface, requestedModel)
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

export function hasUserSignal(context: RouteContext) {
  return context.routingInputSource === "latest_user_message";
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

function stripHarnessBlocks(text: string, tags: ReadonlySet<string>): string {
  let stripped = text;
  for (const tag of tags) {
    stripped = stripped.replace(new RegExp(`<${escapeRegExp(tag)}>[\\s\\S]*?<\\/${escapeRegExp(tag)}>`, "g"), "");
  }
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

function latestOpenAIUserText(input: unknown, promptBlockTags: ReadonlySet<string>): string | undefined {
  if (typeof input === "string") return stripHarnessBlocks(input, promptBlockTags) || undefined;
  if (!Array.isArray(input)) return undefined;

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item)) continue;
    if (item.role !== "user") continue;
    const text = stripHarnessBlocks(textContent(item.content ?? item.text ?? item.input), promptBlockTags);
    if (text) return text;
  }
  return undefined;
}

function latestOpenAIChatUserText(messages: unknown, promptBlockTags: ReadonlySet<string>): string | undefined {
  if (!Array.isArray(messages)) return undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = stripHarnessBlocks(openAIChatContentText(message.content), promptBlockTags);
    if (text) return text;
  }
  return undefined;
}

function openAIChatContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textContent(content);
  return content.map((part) => {
    if (!isRecord(part)) return textContent(part);
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      return part.text;
    }
    if (typeof part.content === "string") return part.content;
    return "";
  }).filter(Boolean).join("\n");
}

function latestAnthropicUserText(messages: unknown, promptBlockTags: ReadonlySet<string>): string | undefined {
  if (!Array.isArray(messages)) return undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = stripHarnessBlocks(textContent(nonToolResultContent(message.content)), promptBlockTags);
    if (text) return text;
  }
  return undefined;
}

// Agent loops send tool results as user-role messages; their text is tool
// output, not user intent, so a tool_result-only turn defers to the previous
// human turn.
function nonToolResultContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter((block) => !(isRecord(block) && block.type === "tool_result"));
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EXCERPT_HEAD_CHARS = 300;
const EXCERPT_TAIL_CHARS = 700;
const EXCERPT_TRUNCATION_MARKER = "\n[...excerpt truncated...]\n";

function redactExcerpt(value: string) {
  const redacted = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted_email]")
    .replace(/(sk|rk|pk|anthropic|claude|openai)[-_][A-Za-z0-9_-]{16,}/gi, "[redacted_token]");
  if (redacted.length <= EXCERPT_HEAD_CHARS + EXCERPT_TAIL_CHARS) return redacted;
  // The ask usually sits at the end of the message, after any harness
  // preamble routing didn't recognize, so the tail gets the larger share.
  return (
    redacted.slice(0, EXCERPT_HEAD_CHARS) +
    EXCERPT_TRUNCATION_MARKER +
    redacted.slice(-EXCERPT_TAIL_CHARS)
  );
}
