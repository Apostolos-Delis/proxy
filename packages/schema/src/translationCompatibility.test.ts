import { describe, expect, it } from "vitest";

import { canTranslateDialect, translationCompatibilityForDialects } from "./translationCompatibility.js";

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
  });
});
