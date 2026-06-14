export const TRANSLATION_COMPATIBILITY_DIALECTS = [
  "anthropic-messages",
  "openai-responses",
  "openai-chat"
] as const;

export type TranslationDialect = typeof TRANSLATION_COMPATIBILITY_DIALECTS[number];

export type TranslationCompatibilityStatus = "native" | "translated" | "unavailable";

export type TranslationCompatibilityResult = {
  status: TranslationCompatibilityStatus;
  dialect?: TranslationDialect;
  from: TranslationDialect;
  to?: TranslationDialect;
  reason?: string;
};

export const TRANSLATABLE_DIALECT_PAIRS = [
  ["openai-responses", "openai-chat"],
  ["openai-chat", "openai-responses"],
  ["anthropic-messages", "openai-chat"],
  ["openai-chat", "anthropic-messages"],
  ["anthropic-messages", "openai-responses"],
  ["openai-responses", "anthropic-messages"]
] as const satisfies readonly (readonly [TranslationDialect, TranslationDialect])[];

export function canTranslateDialect(from: TranslationDialect, to: TranslationDialect) {
  return from === to || TRANSLATABLE_DIALECT_PAIRS.some(([source, target]) => source === from && target === to);
}

export function translationCompatibilityForDialects(input: {
  from: TranslationDialect;
  targetDialects: readonly TranslationDialect[];
  transport?: "http" | "websocket";
  statefulResponses?: boolean;
  hasPreviousResponseId?: boolean;
}): TranslationCompatibilityResult {
  if (input.targetDialects.includes(input.from)) {
    return { status: "native", dialect: input.from, from: input.from, to: input.from };
  }
  if (input.transport === "websocket") {
    return { status: "unavailable", from: input.from, reason: "websocket_native_only" };
  }
  if (input.hasPreviousResponseId) {
    return { status: "unavailable", from: input.from, reason: "previous_response_translation_unavailable" };
  }
  const target = input.targetDialects.find((dialect) => canTranslateDialect(input.from, dialect));
  if (!target) return { status: "unavailable", from: input.from, reason: "translator_unavailable" };
  if (input.statefulResponses === true && !canTranslateStatefulResponses(input.from, target, input.transport)) {
    return { status: "unavailable", from: input.from, to: target, reason: "stateful_translation_unavailable" };
  }
  return { status: "translated", dialect: target, from: input.from, to: target };
}

function canTranslateStatefulResponses(
  from: TranslationDialect,
  to: TranslationDialect,
  transport: "http" | "websocket" | undefined
) {
  return from === "openai-responses" &&
    to === "anthropic-messages" &&
    transport !== "websocket";
}
