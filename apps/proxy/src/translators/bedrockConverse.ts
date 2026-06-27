import type { DialectTranslator } from "./index.js";
import {
  anthropicRequestToBedrock,
  chatRequestToBedrock,
  responsesRequestToBedrock
} from "./bedrockConverseRequest.js";
import { BedrockConverseTranslationError } from "./bedrockConverseShared.js";

export { BedrockConverseTranslationError } from "./bedrockConverseShared.js";
export {
  anthropicRequestToBedrock,
  chatRequestToBedrock,
  responsesRequestToBedrock
} from "./bedrockConverseRequest.js";
export {
  bedrockConverseErrorToAnthropicMessages,
  bedrockConverseErrorToOpenAI,
  bedrockConverseProviderMetadata,
  bedrockConverseResponseToAnthropicMessages,
  bedrockConverseResponseToOpenAIChat,
  bedrockConverseResponseToOpenAIResponses
} from "./bedrockConverseResponse.js";
export {
  bedrockConverseStreamToAnthropicMessagesSse,
  bedrockConverseStreamToOpenAIChatSse,
  bedrockConverseStreamToOpenAIResponsesSse
} from "./bedrockConverseStream.js";

export const openAIChatToBedrockConverse: DialectTranslator = {
  request: chatRequestToBedrock,
  response: unsupportedResponseTranslation,
  sseTransform: unsupportedSseTranslation
};

export const anthropicMessagesToBedrockConverse: DialectTranslator = {
  request: anthropicRequestToBedrock,
  response: unsupportedResponseTranslation,
  sseTransform: unsupportedSseTranslation
};

export const openAIResponsesToBedrockConverse: DialectTranslator = {
  request: responsesRequestToBedrock,
  response: unsupportedResponseTranslation,
  sseTransform: unsupportedSseTranslation
};

function unsupportedResponseTranslation(): unknown {
  throw new BedrockConverseTranslationError(
    "bedrock_response_translation_not_supported",
    "Bedrock Converse response translation is implemented in a later ticket."
  );
}

function unsupportedSseTranslation(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          throw new BedrockConverseTranslationError(
            "bedrock_stream_translation_not_supported",
            "Bedrock Converse stream translation is implemented in a later ticket."
          );
        }
      };
    }
  };
}
