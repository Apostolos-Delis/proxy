import { describe, expect, it } from "vitest";

import {
  canTranslateDialect,
  HARNESS_COMPATIBILITY_PROFILE_IDS,
  harnessCompatibilityForTarget,
  harnessCompatibilityMatrix,
  TRANSLATION_COMPATIBILITY_DIALECTS,
  translationCompatibilityForDialects,
  type HarnessCompatibilityProfile
} from "./translationCompatibility.js";

const harnessProfiles = [
  { profileId: "codex-responses-http", surface: "openai-responses", transport: "http", statefulResponses: true },
  { profileId: "codex-responses-websocket", surface: "openai-responses", transport: "websocket", statefulResponses: true },
  { profileId: "claude-code-messages", surface: "anthropic-messages", transport: "http" },
  { profileId: "openai-chat-sdk", surface: "openai-chat", transport: "http" },
  { profileId: "opencode-chat", surface: "openai-chat", transport: "http" },
  { profileId: "cursor-byok-chat", surface: "openai-chat", transport: "http" },
  { profileId: "generic-openai-responses", surface: "openai-responses", transport: "http" },
  { profileId: "generic-anthropic-messages", surface: "anthropic-messages", transport: "http" }
] as const satisfies readonly HarnessCompatibilityProfile[];

describe("translation compatibility", () => {
  it("reports native coverage before translated coverage", () => {
    expect(translationCompatibilityForDialects({
      from: "openai-responses",
      targetDialects: ["anthropic-messages", "openai-responses"]
    })).toEqual({
      status: "native",
      dialect: "openai-responses",
      from: "openai-responses",
      to: "openai-responses"
    });
  });

  it("reports translated coverage for cross-family HTTP targets", () => {
    expect(translationCompatibilityForDialects({
      from: "openai-responses",
      targetDialects: ["anthropic-messages"],
      transport: "http",
      statefulResponses: true
    })).toEqual({
      status: "translated",
      dialect: "anthropic-messages",
      from: "openai-responses",
      to: "anthropic-messages"
    });
  });

  it("skips blocked translated candidates when a later target dialect is compatible", () => {
    expect(translationCompatibilityForDialects({
      from: "openai-responses",
      targetDialects: ["openai-chat", "anthropic-messages"],
      transport: "http",
      statefulResponses: true
    })).toMatchObject({
      status: "translated",
      dialect: "anthropic-messages",
      to: "anthropic-messages"
    });
  });

  it("keeps prior-response and websocket traffic native-only", () => {
    expect(translationCompatibilityForDialects({
      from: "openai-responses",
      targetDialects: ["anthropic-messages"],
      transport: "http",
      hasPreviousResponseId: true
    }).reason).toBe("previous_response_translation_unavailable");
    expect(translationCompatibilityForDialects({
      from: "openai-responses",
      targetDialects: ["anthropic-messages"],
      transport: "websocket"
    }).reason).toBe("websocket_native_only");
  });

  it("keeps stateful Responses to Chat unavailable", () => {
    expect(translationCompatibilityForDialects({
      from: "openai-responses",
      targetDialects: ["openai-chat"],
      transport: "http",
      statefulResponses: true
    })).toMatchObject({
      status: "unavailable",
      reason: "stateful_translation_unavailable"
    });
  });

  it("exposes the registered dialect matrix", () => {
    expect(canTranslateDialect("anthropic-messages", "openai-chat")).toBe(true);
    expect(canTranslateDialect("openai-chat", "anthropic-messages")).toBe(true);
    expect(TRANSLATION_COMPATIBILITY_DIALECTS).toContain("bedrock-converse");
    expect(canTranslateDialect("openai-chat", "bedrock-converse")).toBe(true);
  });

  it("generates harness compatibility rows for every profile and target dialect", () => {
    const matrix = harnessCompatibilityMatrix({ profiles: harnessProfiles });

    expect(matrix).toHaveLength(HARNESS_COMPATIBILITY_PROFILE_IDS.length * TRANSLATION_COMPATIBILITY_DIALECTS.length);
    expect(new Set(matrix.map((entry) => entry.profileId))).toEqual(new Set(HARNESS_COMPATIBILITY_PROFILE_IDS));
    expect(matrix.find((entry) =>
      entry.profileId === "claude-code-messages" &&
      entry.targetDialects[0] === "anthropic-messages"
    )).toMatchObject({
      status: "native",
      dialect: "anthropic-messages"
    });
  });

  it("keeps websocket translated targets native-only in the harness contract", () => {
    expect(harnessCompatibilityForTarget({
      profileId: "codex-responses-websocket",
      surface: "openai-responses",
      transport: "websocket",
      statefulResponses: true,
      targetDialects: ["openai-chat"]
    })).toMatchObject({
      status: "unavailable",
      reason: "websocket_native_only"
    });
  });

  it("keeps prior-response translated targets native-only in the harness contract", () => {
    expect(harnessCompatibilityForTarget({
      profileId: "codex-responses-http",
      surface: "openai-responses",
      transport: "http",
      statefulResponses: true,
      hasPreviousResponseId: true,
      targetDialects: ["openai-chat"]
    })).toMatchObject({
      status: "unavailable",
      reason: "previous_response_translation_unavailable"
    });
  });

  it("distinguishes missing endpoints, missing translators, and unsupported fields", () => {
    expect(harnessCompatibilityForTarget({
      profileId: "openai-chat-sdk",
      surface: "openai-chat",
      transport: "http",
      targetDialects: []
    })).toMatchObject({
      status: "unavailable",
      reason: "dialect_unavailable"
    });
    expect(harnessCompatibilityForTarget({
      profileId: "openai-chat-sdk",
      surface: "openai-chat",
      transport: "http",
      targetDialects: ["anthropic-messages"],
      availableTranslators: []
    })).toMatchObject({
      status: "unavailable",
      reason: "translator_unavailable"
    });
    expect(harnessCompatibilityForTarget({
      profileId: "openai-chat-sdk",
      surface: "openai-chat",
      transport: "http",
      targetDialects: ["anthropic-messages"],
      unsupportedFields: ["parallel_tool_calls"]
    })).toMatchObject({
      status: "unavailable",
      reason: "unsupported_field",
      unsupportedFields: ["parallel_tool_calls"]
    });
  });

  it("evaluates Bedrock targets without a registered runtime translator", () => {
    expect(harnessCompatibilityForTarget({
      profileId: "openai-chat-sdk",
      surface: "openai-chat",
      transport: "http",
      targetDialects: ["bedrock-converse"],
      availableTranslators: []
    })).toMatchObject({
      status: "unavailable",
      reason: "translator_unavailable",
      to: "bedrock-converse"
    });
  });

  it("reports translated Bedrock compatibility when the Bedrock translator is available", () => {
    expect(harnessCompatibilityForTarget({
      profileId: "openai-chat-sdk",
      surface: "openai-chat",
      transport: "http",
      targetDialects: ["bedrock-converse"],
      availableTranslators: [["openai-chat", "bedrock-converse"]]
    })).toMatchObject({
      status: "translated",
      dialect: "bedrock-converse",
      from: "openai-chat",
      to: "bedrock-converse"
    });
  });

  it("blocks stateful Responses translation to Bedrock with an explicit reason", () => {
    expect(harnessCompatibilityForTarget({
      profileId: "codex-responses-http",
      surface: "openai-responses",
      transport: "http",
      statefulResponses: true,
      targetDialects: ["bedrock-converse"],
      availableTranslators: [["openai-responses", "bedrock-converse"]]
    })).toMatchObject({
      status: "unavailable",
      reason: "stateful_translation_unavailable",
      to: "bedrock-converse"
    });
  });

  it("uses Bedrock-specific reason codes for signed and encrypted reasoning fields", () => {
    expect(harnessCompatibilityForTarget({
      profileId: "codex-responses-http",
      surface: "openai-responses",
      transport: "http",
      targetDialects: ["bedrock-converse"],
      unsupportedFields: ["include.reasoning.encrypted_content"],
      availableTranslators: [["openai-responses", "bedrock-converse"]]
    })).toMatchObject({
      status: "unavailable",
      reason: "encrypted_reasoning_unavailable",
      unsupportedFields: ["include.reasoning.encrypted_content"]
    });
    expect(harnessCompatibilityForTarget({
      profileId: "claude-code-messages",
      surface: "anthropic-messages",
      transport: "http",
      targetDialects: ["bedrock-converse"],
      unsupportedFields: ["thinking.signature"],
      availableTranslators: [["anthropic-messages", "bedrock-converse"]]
    })).toMatchObject({
      status: "unavailable",
      reason: "signed_reasoning_unavailable",
      unsupportedFields: ["thinking.signature"]
    });
  });

  it("rejects Bedrock-only deployment settings on non-Bedrock targets", () => {
    expect(harnessCompatibilityForTarget({
      profileId: "openai-chat-sdk",
      surface: "openai-chat",
      transport: "http",
      targetDialects: ["openai-responses"],
      bedrockSettingsOnNonBedrockTarget: true
    })).toMatchObject({
      status: "unavailable",
      reason: "bedrock_settings_on_non_bedrock_target",
      to: "openai-responses"
    });
  });
});
