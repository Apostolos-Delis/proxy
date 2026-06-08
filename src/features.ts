import type { RouteContext, Surface } from "./types.js";
import { explicitAlias } from "./catalog.js";
import { isRecord, roughTokenEstimate, sha256, stableJson } from "./util.js";

const hintPatterns: [string, RegExp][] = [
  ["quick", /\b(quick|simple|typo|format|rename|one-line)\b/i],
  ["deep", /\b(think hard|deep review|root cause|prove|exhaustive)\b/i],
  ["security", /\b(security|auth|oauth|permission|secret|crypto)\b/i],
  ["migration", /\b(migration|refactor|architecture|schema)\b/i],
  ["concurrency", /\b(concurrency|race condition|deadlock|lock)\b/i],
  ["failing_test", /\b(failing test|regression|flaky|stack trace|root cause)\b/i],
  ["production", /\b(production|data loss|payment|billing)\b/i]
];

export function buildOpenAIContext(body: unknown, headers: Record<string, string | undefined>): RouteContext {
  const request = isRecord(body) ? body : {};
  const text = [
    stringifyText(request.instructions),
    stringifyText(request.input),
    stringifyText(request.metadata)
  ].join("\n");
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const requestedModel = typeof request.model === "string" ? request.model : "router-auto";

  return {
    surface: "openai-responses",
    requestedModel,
    inputChars: text.length,
    inputHash: sha256(text),
    estimatedInputTokens: roughTokenEstimate(text.length),
    hasTools: tools.length > 0,
    toolCount: tools.length,
    hasPreviousResponseId: typeof request.previous_response_id === "string",
    hasImages: hasImageInput(request.input),
    extractedHints: extractHints(text),
    sessionId: headers["x-codex-session-id"],
    userId: headers["x-prompt-proxy-user-id"] ?? headers["x-user-id"],
    teamId: headers["x-prompt-proxy-team-id"] ?? headers["x-team-id"],
    explicitAlias: explicitAlias("openai-responses", requestedModel)
  };
}

export function buildAnthropicContext(body: unknown, headers: Record<string, string | undefined>): RouteContext {
  const request = isRecord(body) ? body : {};
  const text = [
    stringifyText(request.system),
    stringifyText(request.messages),
    stringifyText(request.metadata)
  ].join("\n");
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const requestedModel = typeof request.model === "string" ? request.model : "claude-router-auto";

  return {
    surface: "anthropic-messages",
    requestedModel,
    inputChars: text.length,
    inputHash: sha256(text),
    estimatedInputTokens: roughTokenEstimate(text.length),
    hasTools: tools.length > 0,
    toolCount: tools.length,
    hasPreviousResponseId: false,
    hasImages: hasImageInput(request.messages),
    extractedHints: extractHints(text),
    sessionId: headers["x-claude-code-session-id"],
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
    input_excerpt: allowExcerpt ? redactExcerpt(sourceText ?? "") : null,
    input_hash: context.inputHash,
    input_chars: context.inputChars,
    estimated_input_tokens: context.estimatedInputTokens,
    has_tools: context.hasTools,
    tool_count: context.toolCount,
    has_previous_response_id: context.hasPreviousResponseId,
    has_images: context.hasImages,
    extracted_hints: context.extractedHints,
    session_route: null,
    explicit_alias: context.explicitAlias ?? null
  };
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
  return hintPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
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
