import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  anthropicMessagesToBedrockConverse,
  bedrockConverseErrorToAnthropicMessages,
  bedrockConverseErrorToOpenAI,
  bedrockConverseProviderMetadata,
  bedrockConverseResponseToAnthropicMessages,
  bedrockConverseResponseToOpenAIChat,
  bedrockConverseResponseToOpenAIResponses,
  bedrockConverseStreamToAnthropicMessagesSse,
  bedrockConverseStreamToOpenAIChatSse,
  bedrockConverseStreamToOpenAIResponsesSse,
  BedrockConverseTranslationError,
  openAIChatToBedrockConverse,
  openAIResponsesToBedrockConverse
} from "../src/translators/bedrockConverse.js";
import { normalizeUsage } from "../src/persistence/values.js";

async function fixture(path: string) {
  const file = fileURLToPath(new URL(`./fixtures/bedrock/${path}`, import.meta.url));
  return JSON.parse(await readFile(file, "utf8"));
}

async function textFixture(path: string) {
  const file = fileURLToPath(new URL(`./fixtures/bedrock/${path}`, import.meta.url));
  return readFile(file, "utf8");
}

async function sseFixture(path: string) {
  return `${(await textFixture(path)).trimEnd()}\n\n`;
}

async function collectSse(chunks: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of chunks) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

async function* streamEvents(items: unknown[]) {
  for (const item of items) yield item;
}

describe("Bedrock Converse request translator", () => {
  it.each([
    [
      "openai-chat_to_bedrock-converse_text",
      openAIChatToBedrockConverse.request
    ],
    [
      "openai-chat_to_bedrock-converse_tool-history",
      openAIChatToBedrockConverse.request
    ],
    [
      "anthropic-messages_to_bedrock-converse_text",
      anthropicMessagesToBedrockConverse.request
    ],
    [
      "anthropic-messages_to_bedrock-converse_tool-history",
      anthropicMessagesToBedrockConverse.request
    ],
    [
      "openai-responses_to_bedrock-converse_text-stateless",
      openAIResponsesToBedrockConverse.request
    ]
  ])("maps %s", async (name, translate) => {
    const input = await fixture(`caller-requests/${name}.request.json`);
    const expected = await fixture(`expected-converse/${name}.expected.json`);

    expect(translate(input)).toEqual(expected);
  });

  it("fails closed for stateful OpenAI Responses requests", async () => {
    const input = await fixture("caller-requests/openai-responses_to_bedrock-converse_stateful-unsupported.request.json");
    const expected = await fixture("unsupported/openai-responses_to_bedrock-converse_stateful-unsupported.reason.json");

    expect(() => openAIResponsesToBedrockConverse.request(input)).toThrow(BedrockConverseTranslationError);
    try {
      openAIResponsesToBedrockConverse.request(input);
    } catch (error) {
      expect(error).toMatchObject(expected);
    }
  });

  it("rejects remote image URLs before provider spend", () => {
    expect(() => openAIChatToBedrockConverse.request({
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }]
      }]
    })).toThrow(BedrockConverseTranslationError);
  });

  it("decodes OpenAI data URL images into Bedrock byte arrays", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const translated = openAIChatToBedrockConverse.request({
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` }
        }]
      }]
    }) as any;

    const image = translated.messages[0].content[0].image;
    expect(image.format).toBe("png");
    expect(image.source.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(image.source.bytes)).toEqual(Array.from(bytes));
  });

  it("decodes Anthropic base64 images into Bedrock byte arrays", () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff]);
    const translated = anthropicMessagesToBedrockConverse.request({
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: bytes.toString("base64")
          }
        }]
      }]
    }) as any;

    const image = translated.messages[0].content[0].image;
    expect(image.format).toBe("jpeg");
    expect(image.source.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(image.source.bytes)).toEqual(Array.from(bytes));
  });

  it("rejects malformed base64 image data before provider spend", () => {
    expect(() => openAIChatToBedrockConverse.request({
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages: [{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: "data:image/png;base64,not-valid!" }
        }]
      }]
    })).toThrow(BedrockConverseTranslationError);
  });

  it("rejects provider-native OpenAI Responses image file references before provider spend", () => {
    expect(() => openAIResponsesToBedrockConverse.request({
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      input: [{
        role: "user",
        content: [{ type: "input_image", file_id: "file_123" }]
      }]
    })).toThrow(BedrockConverseTranslationError);
  });
});

describe("Bedrock Converse response normalizer", () => {
  it("maps text responses to each caller shape", async () => {
    const input = await fixture("converse-responses/bedrock-converse_response_text.response.json");

    const chat = bedrockConverseResponseToOpenAIChat(input) as any;
    expect(chat).toMatchObject({
      object: "chat.completion",
      choices: [{
        message: {
          role: "assistant",
          content: "The migration is low risk if the adapter boundary lands first."
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 42,
        completion_tokens: 13,
        total_tokens: 55
      }
    });
    expect(normalizeUsage(chat.usage)).toEqual({
      inputTokens: 42,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 13,
      reasoningTokens: 0,
      totalTokens: 55
    });

    const responses = bedrockConverseResponseToOpenAIResponses(input) as any;
    expect(responses).toMatchObject({
      object: "response",
      status: "completed",
      output_text: "The migration is low risk if the adapter boundary lands first.",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The migration is low risk if the adapter boundary lands first." }]
      }],
      usage: {
        input_tokens: 42,
        output_tokens: 13,
        total_tokens: 55
      }
    });
    expect(normalizeUsage(responses.usage)).toEqual({
      inputTokens: 42,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 13,
      reasoningTokens: 0,
      totalTokens: 55
    });

    const anthropic = bedrockConverseResponseToAnthropicMessages(input);
    expect(anthropic).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "The migration is low risk if the adapter boundary lands first." }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 42,
        output_tokens: 13
      }
    });
  });

  it("maps Bedrock tool use blocks back to caller tool-call shapes", async () => {
    const input = await fixture("converse-responses/bedrock-converse_response_tool-use.response.json");

    const chat = bedrockConverseResponseToOpenAIChat(input) as any;
    expect(chat.choices[0].message).toMatchObject({
      content: null,
      tool_calls: [{
        id: "call_list_files",
        type: "function",
        function: {
          name: "shell",
          arguments: "{\"cmd\":\"ls apps/proxy\"}"
        }
      }]
    });
    expect(chat.choices[0].finish_reason).toBe("tool_calls");

    const responses = bedrockConverseResponseToOpenAIResponses(input) as any;
    expect(responses.output).toEqual([{
      id: "call_list_files",
      type: "function_call",
      call_id: "call_list_files",
      name: "shell",
      arguments: "{\"cmd\":\"ls apps/proxy\"}"
    }]);

    const anthropic = bedrockConverseResponseToAnthropicMessages(input);
    expect(anthropic).toMatchObject({
      content: [{
        type: "tool_use",
        id: "call_list_files",
        name: "shell",
        input: { cmd: "ls apps/proxy" }
      }],
      stop_reason: "tool_use"
    });
  });

  it("maps max-token stop reasons into caller completion categories", async () => {
    const input = await fixture("converse-responses/bedrock-converse_response_usage-stop-reason.response.json");

    expect((bedrockConverseResponseToOpenAIChat(input) as any).choices[0].finish_reason).toBe("length");
    expect(bedrockConverseResponseToOpenAIResponses(input)).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" }
    });
    expect(bedrockConverseResponseToAnthropicMessages(input)).toMatchObject({
      stop_reason: "max_tokens"
    });
  });

  it("keeps guardrail trace in provider metadata while returning caller-native categories", async () => {
    const input = await fixture("converse-responses/bedrock-converse_response_guardrail-intervened.response.json");
    const metadata = bedrockConverseProviderMetadata(input) as any;

    expect(metadata).toMatchObject({
      provider: "amazon-bedrock",
      bedrock: {
        stopReason: "guardrail_intervened",
        trace: {
          guardrail: {
            action: "INTERVENED"
          }
        },
        responseMetadata: {
          requestId: "bedrock-request-guardrail"
        }
      }
    });
    expect((bedrockConverseResponseToOpenAIChat(input) as any).choices[0].finish_reason).toBe("content_filter");
    expect(bedrockConverseResponseToOpenAIResponses(input)).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" }
    });
    expect(bedrockConverseResponseToAnthropicMessages(input)).toMatchObject({
      stop_reason: "refusal"
    });
    expect(JSON.stringify(bedrockConverseResponseToOpenAIChat(input))).not.toContain("unsafe_test_topic");
  });

  it("normalizes Bedrock errors into caller error envelopes", () => {
    expect(bedrockConverseErrorToOpenAI({
      name: "ThrottlingException",
      message: "Rate exceeded"
    })).toEqual({
      error: {
        message: "Rate exceeded",
        type: "rate_limit_error",
        code: "ThrottlingException"
      }
    });
    expect(bedrockConverseErrorToAnthropicMessages({
      name: "AccessDeniedException",
      message: "Missing bedrock:InvokeModel"
    })).toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Missing bedrock:InvokeModel"
      }
    });
  });
});

describe("Bedrock Converse stream translator", () => {
  it.each([
    [
      "openai-chat",
      "bedrock-converse_stream_text",
      "openai-chat_bedrock-converse_stream_text",
      bedrockConverseStreamToOpenAIChatSse
    ],
    [
      "openai-responses",
      "bedrock-converse_stream_text",
      "openai-responses_bedrock-converse_stream_text",
      bedrockConverseStreamToOpenAIResponsesSse
    ],
    [
      "anthropic-messages",
      "bedrock-converse_stream_text",
      "anthropic-messages_bedrock-converse_stream_text",
      bedrockConverseStreamToAnthropicMessagesSse
    ]
  ])("maps text streams to %s SSE", async (_surface, inputName, expectedName, translate) => {
    const input = await fixture(`converse-stream-events/${inputName}.events.json`) as unknown[];
    const expected = await sseFixture(`expected-sse/${expectedName}.expected.sse`);

    expect(await collectSse(translate(streamEvents(input)))).toBe(expected);
  });

  it.each([
    [
      "openai-chat",
      "openai-chat_bedrock-converse_stream_tool-call",
      bedrockConverseStreamToOpenAIChatSse
    ],
    [
      "openai-responses",
      "openai-responses_bedrock-converse_stream_tool-call",
      bedrockConverseStreamToOpenAIResponsesSse
    ],
    [
      "anthropic-messages",
      "anthropic-messages_bedrock-converse_stream_tool-call",
      bedrockConverseStreamToAnthropicMessagesSse
    ]
  ])("preserves Bedrock tool-call stream IDs and argument deltas for %s", async (_surface, expectedName, translate) => {
    const input = await fixture("converse-stream-events/bedrock-converse_stream_tool-call.events.json") as unknown[];
    const expected = await sseFixture(`expected-sse/${expectedName}.expected.sse`);
    const output = await collectSse(translate(streamEvents(input)));

    expect(output).toBe(expected);
    expect(output).toContain("call_list_files");
    expect(output).toContain("{\\\"cmd\\\"");
    expect(output).toContain(":\\\"ls apps/proxy\\\"}");
  });

  it("emits terminal OpenAI Chat usage from Bedrock metadata", async () => {
    const input = await fixture("converse-stream-events/bedrock-converse_stream_metadata-usage.events.json") as unknown[];
    const expected = await sseFixture("expected-sse/openai-chat_bedrock-converse_stream_metadata-usage.expected.sse");
    const output = await collectSse(bedrockConverseStreamToOpenAIChatSse(streamEvents(input)));

    expect(output).toBe(expected);
    expect(output).toContain("\"usage\":{\"prompt_tokens\":18,\"completion_tokens\":4,\"total_tokens\":22}");
  });

  it("terminates OpenAI Responses streams cleanly on AWS exception events", async () => {
    const input = await fixture("converse-stream-events/bedrock-converse_stream_aws-exception.events.json") as unknown[];
    const expected = await sseFixture("expected-sse/openai-responses_bedrock-converse_stream_aws-exception.expected.sse");
    const output = await collectSse(bedrockConverseStreamToOpenAIResponsesSse(streamEvents(input)));

    expect(output).toBe(expected);
    expect(output).toContain("Rate exceeded while streaming from Bedrock.");
    expect(output).toContain("\"type\":\"rate_limit_error\"");
  });
});
