import type { Dialect } from "../types.js";
import {
  anthropicMessagesToOpenAIChat,
  anthropicMessagesToOpenAIResponses,
  openAIChatToAnthropicMessages,
  openAIResponsesToAnthropicMessages
} from "./anthropicOpenAI.js";
import { openAIChatToResponses, openAIResponsesToChat } from "./openai.js";

export type DialectTranslator = {
  request(body: unknown): unknown;
  response(body: unknown): unknown;
  sseTransform(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
};

class TranslatorRegistry {
  private readonly entries = new Map<string, DialectTranslator>();

  register(from: Dialect, to: Dialect, translator: DialectTranslator) {
    this.entries.set(translationKey(from, to), translator);
  }

  get(from: Dialect, to: Dialect) {
    if (from === to) return undefined;
    return this.entries.get(translationKey(from, to));
  }

  canTranslate(from: Dialect, to: Dialect) {
    return from === to || this.entries.has(translationKey(from, to));
  }
}

export const translators = new TranslatorRegistry();

translators.register("openai-responses", "openai-chat", openAIResponsesToChat);
translators.register("openai-chat", "openai-responses", openAIChatToResponses);
translators.register("anthropic-messages", "openai-chat", anthropicMessagesToOpenAIChat);
translators.register("openai-chat", "anthropic-messages", openAIChatToAnthropicMessages);
translators.register("anthropic-messages", "openai-responses", anthropicMessagesToOpenAIResponses);
translators.register("openai-responses", "anthropic-messages", openAIResponsesToAnthropicMessages);

export function translationTag(from: Dialect, to: Dialect) {
  return `translated_request:${from}_to_${to}`;
}

function translationKey(from: Dialect, to: Dialect) {
  return `${from}->${to}`;
}
