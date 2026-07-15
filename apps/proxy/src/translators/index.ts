import type { TranslationPair } from "@proxy/schema";

import type { Dialect } from "../types.js";
import {
  anthropicMessagesToOpenAIChat,
  anthropicMessagesToOpenAIResponses,
  openAIChatToAnthropicMessages,
  openAIResponsesToAnthropicMessages
} from "./anthropicOpenAI.js";
import { openAIChatToResponses, openAIResponsesToChat } from "./openai.js";
import {
  anthropicMessagesToBedrockConverse,
  openAIChatToBedrockConverse,
  openAIResponsesToBedrockConverse
} from "./bedrockConverse.js";

export type DialectTranslator = {
  request(body: unknown): unknown;
  response(body: unknown): unknown;
  sseTransform(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
};

class TranslatorRegistry {
  private readonly entries = new Map<string, {
    from: Dialect;
    to: Dialect;
    id: string;
    version: string;
    translator: DialectTranslator;
  }>();

  register(input: {
    from: Dialect;
    to: Dialect;
    id: string;
    version: string;
    translator: DialectTranslator;
  }) {
    this.entries.set(translationKey(input.from, input.to), {
      from: input.from,
      to: input.to,
      id: input.id,
      version: input.version,
      translator: input.translator
    });
  }

  get(from: Dialect, to: Dialect) {
    if (from === to) return undefined;
    return this.entries.get(translationKey(from, to))?.translator;
  }

  canTranslate(from: Dialect, to: Dialect) {
    return this.adapterContract(from, to) !== undefined;
  }

  adapterContract(from: Dialect, to: Dialect): { id: string; version: string } | null | undefined {
    if (from === to) return null;
    const entry = this.entries.get(translationKey(from, to));
    return entry ? { id: entry.id, version: entry.version } : undefined;
  }

  availablePairs(): TranslationPair[] {
    return [...this.entries.values()]
      .filter(({ from, to }) => this.get(from, to))
      .map(({ from, to }) => [from, to]);
  }
}

export const translators = new TranslatorRegistry();

translators.register({
  from: "openai-responses",
  to: "openai-chat",
  id: "openai-responses-to-openai-chat",
  version: "1",
  translator: openAIResponsesToChat
});
translators.register({
  from: "openai-chat",
  to: "openai-responses",
  id: "openai-chat-to-openai-responses",
  version: "1",
  translator: openAIChatToResponses
});
translators.register({
  from: "anthropic-messages",
  to: "openai-chat",
  id: "anthropic-messages-to-openai-chat",
  version: "1",
  translator: anthropicMessagesToOpenAIChat
});
translators.register({
  from: "openai-chat",
  to: "anthropic-messages",
  id: "openai-chat-to-anthropic-messages",
  version: "1",
  translator: openAIChatToAnthropicMessages
});
translators.register({
  from: "anthropic-messages",
  to: "openai-responses",
  id: "anthropic-messages-to-openai-responses",
  version: "1",
  translator: anthropicMessagesToOpenAIResponses
});
translators.register({
  from: "openai-responses",
  to: "anthropic-messages",
  id: "openai-responses-to-anthropic-messages",
  version: "1",
  translator: openAIResponsesToAnthropicMessages
});
translators.register({
  from: "openai-chat",
  to: "bedrock-converse",
  id: "openai-chat-to-bedrock-converse",
  version: "1",
  translator: openAIChatToBedrockConverse
});
translators.register({
  from: "anthropic-messages",
  to: "bedrock-converse",
  id: "anthropic-messages-to-bedrock-converse",
  version: "1",
  translator: anthropicMessagesToBedrockConverse
});
translators.register({
  from: "openai-responses",
  to: "bedrock-converse",
  id: "openai-responses-to-bedrock-converse",
  version: "1",
  translator: openAIResponsesToBedrockConverse
});

export function translationTag(from: Dialect, to: Dialect) {
  return `translated_request:${from}_to_${to}`;
}

function translationKey(from: Dialect, to: Dialect) {
  return `${from}->${to}`;
}
