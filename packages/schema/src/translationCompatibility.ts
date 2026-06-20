export const TRANSLATION_COMPATIBILITY_DIALECTS = [
  "anthropic-messages",
  "openai-responses",
  "openai-chat"
] as const;

export type TranslationDialect = typeof TRANSLATION_COMPATIBILITY_DIALECTS[number];

export type TranslationCompatibilityStatus = "native" | "translated" | "unavailable";

export const HARNESS_COMPATIBILITY_PROFILE_IDS = [
  "codex-responses-http",
  "codex-responses-websocket",
  "claude-code-messages",
  "openai-chat-sdk",
  "opencode-chat",
  "cursor-byok-chat",
  "generic-openai-responses",
  "generic-anthropic-messages"
] as const;

export type HarnessCompatibilityProfileId = typeof HARNESS_COMPATIBILITY_PROFILE_IDS[number];

export type TranslationCompatibilityReason =
  | "dialect_unavailable"
  | "translator_unavailable"
  | "stateful_translation_unavailable"
  | "previous_response_translation_unavailable"
  | "websocket_native_only"
  | "unsupported_field";

export type TranslationCompatibilityResult = {
  status: TranslationCompatibilityStatus;
  dialect?: TranslationDialect;
  from: TranslationDialect;
  to?: TranslationDialect;
  reason?: TranslationCompatibilityReason;
};

export const TRANSLATABLE_DIALECT_PAIRS = [
  ["openai-responses", "openai-chat"],
  ["openai-chat", "openai-responses"],
  ["anthropic-messages", "openai-chat"],
  ["openai-chat", "anthropic-messages"],
  ["anthropic-messages", "openai-responses"],
  ["openai-responses", "anthropic-messages"]
] as const satisfies readonly (readonly [TranslationDialect, TranslationDialect])[];

export type TranslationPair = readonly [TranslationDialect, TranslationDialect];

export type HarnessCompatibilityProfile = {
  profileId: HarnessCompatibilityProfileId;
  surface: TranslationDialect;
  transport: "http" | "websocket";
  statefulResponses?: boolean;
  hasPreviousResponseId?: boolean;
  unsupportedFields?: readonly string[];
};

export type HarnessCompatibilityResult = TranslationCompatibilityResult & {
  profileId: HarnessCompatibilityProfileId;
  surface: TranslationDialect;
  targetDialects: readonly TranslationDialect[];
  unsupportedFields?: readonly string[];
};

export function canTranslateDialect(from: TranslationDialect, to: TranslationDialect) {
  return from === to || TRANSLATABLE_DIALECT_PAIRS.some(([source, target]) => source === from && target === to);
}

export function translationCompatibilityForDialects(input: {
  from: TranslationDialect;
  targetDialects: readonly TranslationDialect[];
  transport?: "http" | "websocket";
  statefulResponses?: boolean;
  hasPreviousResponseId?: boolean;
  unsupportedFields?: readonly string[];
  availableTranslators?: readonly TranslationPair[];
}): TranslationCompatibilityResult {
  const result = harnessCompatibilityForTarget({
    profileId: defaultProfileIdForDialect(input.from),
    surface: input.from,
    targetDialects: input.targetDialects,
    transport: input.transport ?? "http",
    statefulResponses: input.statefulResponses,
    hasPreviousResponseId: input.hasPreviousResponseId,
    unsupportedFields: input.unsupportedFields,
    availableTranslators: input.availableTranslators
  });

  return {
    status: result.status,
    dialect: result.dialect,
    from: result.from,
    to: result.to,
    reason: result.reason
  };
}

export function harnessCompatibilityForTarget(input: HarnessCompatibilityProfile & {
  targetDialects: readonly TranslationDialect[];
  availableTranslators?: readonly TranslationPair[];
}): HarnessCompatibilityResult {
  if (input.targetDialects.includes(input.surface)) {
    return {
      status: "native",
      dialect: input.surface,
      from: input.surface,
      to: input.surface,
      profileId: input.profileId,
      surface: input.surface,
      targetDialects: input.targetDialects
    };
  }
  if (input.targetDialects.length === 0) {
    return unavailableResult(input, "dialect_unavailable");
  }
  if (input.transport === "websocket") {
    return unavailableResult(input, "websocket_native_only");
  }
  if (input.hasPreviousResponseId) {
    return unavailableResult(input, "previous_response_translation_unavailable");
  }

  const translators = input.availableTranslators ?? TRANSLATABLE_DIALECT_PAIRS;
  const targets = input.targetDialects.filter((dialect) => canTranslateDialectWithPairs(input.surface, dialect, translators));
  if (targets.length === 0) return unavailableResult(input, "translator_unavailable");

  let statefulBlockedTarget: TranslationDialect | undefined;
  let unsupportedFieldsTarget: TranslationDialect | undefined;
  for (const target of targets) {
    if (input.statefulResponses === true && !canTranslateStatefulResponses(input.surface, target, input.transport)) {
      statefulBlockedTarget ??= target;
      continue;
    }
    if (input.unsupportedFields && input.unsupportedFields.length > 0) {
      unsupportedFieldsTarget ??= target;
      continue;
    }
    return {
      status: "translated",
      dialect: target,
      from: input.surface,
      to: target,
      profileId: input.profileId,
      surface: input.surface,
      targetDialects: input.targetDialects
    };
  }

  if (unsupportedFieldsTarget) return unavailableResult(input, "unsupported_field", unsupportedFieldsTarget);
  return unavailableResult(input, "stateful_translation_unavailable", statefulBlockedTarget ?? targets[0]);
}

export function harnessCompatibilityMatrix(input: {
  profiles: readonly HarnessCompatibilityProfile[];
  targetDialects?: readonly TranslationDialect[];
  availableTranslators?: readonly TranslationPair[];
}): HarnessCompatibilityResult[] {
  const targetDialects = input.targetDialects ?? TRANSLATION_COMPATIBILITY_DIALECTS;
  return input.profiles.flatMap((profile) =>
    targetDialects.map((targetDialect) =>
      harnessCompatibilityForTarget({
        ...profile,
        targetDialects: [targetDialect],
        availableTranslators: input.availableTranslators
      })
    )
  );
}

function unavailableResult(
  input: HarnessCompatibilityProfile & { targetDialects: readonly TranslationDialect[] },
  reason: TranslationCompatibilityReason,
  to?: TranslationDialect
): HarnessCompatibilityResult {
  const result: HarnessCompatibilityResult = {
    status: "unavailable",
    from: input.surface,
    to,
    reason,
    profileId: input.profileId,
    surface: input.surface,
    targetDialects: input.targetDialects
  };
  if (reason === "unsupported_field") {
    return { ...result, unsupportedFields: input.unsupportedFields };
  }
  return result;
}

function defaultProfileIdForDialect(dialect: TranslationDialect): HarnessCompatibilityProfileId {
  if (dialect === "anthropic-messages") return "generic-anthropic-messages";
  if (dialect === "openai-responses") return "generic-openai-responses";
  return "openai-chat-sdk";
}

function canTranslateDialectWithPairs(
  from: TranslationDialect,
  to: TranslationDialect,
  translators: readonly TranslationPair[]
) {
  return from === to || translators.some(([source, target]) => source === from && target === to);
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
