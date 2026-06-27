import {
  cloneRecord,
  parseMaybeJson,
  stringValue,
  textContent
} from "./canonical.js";
import { isRecord } from "../util.js";
import {
  BedrockConverseTranslationError,
  type BedrockContentBlock,
  type BedrockMessage
} from "./bedrockConverseShared.js";

export function chatRequestToBedrock(body: unknown) {
  const source = cloneRecord(body);
  const request = baseBedrockRequest(source);
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const system: BedrockContentBlock[] = [];
  request.messages = chatMessagesToBedrock(messages, system);
  if (system.length > 0) request.system = system;
  applyOpenAIToolConfig(request, source);
  applyInferenceConfig(request, {
    maxTokens: source.max_completion_tokens ?? source.max_tokens,
    temperature: source.temperature,
    topP: source.top_p,
    stop: source.stop
  });
  return request;
}

export function anthropicRequestToBedrock(body: unknown) {
  const source = cloneRecord(body);
  const request = baseBedrockRequest(source);
  const system = anthropicSystemBlocks(source.system);
  if (system.length > 0) request.system = system;
  request.messages = anthropicMessagesToBedrock(Array.isArray(source.messages) ? source.messages : []);
  applyAnthropicToolConfig(request, source);
  applyInferenceConfig(request, {
    maxTokens: source.max_tokens ?? source.max_output_tokens,
    temperature: source.temperature,
    topP: source.top_p,
    stop: source.stop_sequences
  });
  return request;
}

export function responsesRequestToBedrock(body: unknown) {
  const source = cloneRecord(body);
  if (typeof source.previous_response_id === "string") {
    throw new BedrockConverseTranslationError(
      "previous_response_id_not_supported",
      "Stateful OpenAI Responses requests cannot be translated to Bedrock Converse in V1."
    );
  }
  if (Array.isArray(source.include) && source.include.includes("reasoning.encrypted_content")) {
    throw new BedrockConverseTranslationError(
      "encrypted_reasoning_not_supported",
      "Encrypted OpenAI Responses reasoning cannot be translated to Bedrock Converse in V1."
    );
  }

  const request = baseBedrockRequest(source);
  if (typeof source.instructions === "string" && source.instructions.trim()) {
    request.system = [{ text: source.instructions }];
  }
  request.messages = responsesInputToBedrock(source.input);
  applyResponsesToolConfig(request, source);
  applyInferenceConfig(request, {
    maxTokens: source.max_output_tokens,
    temperature: source.temperature,
    topP: source.top_p,
    stop: source.stop ?? source.stop_sequences
  });
  return request;
}

function baseBedrockRequest(source: Record<string, unknown>) {
  const model = stringValue(source.model);
  const request: Record<string, unknown> = {};
  if (model) request.modelId = model;
  return request;
}

function chatMessagesToBedrock(messages: unknown[], system: BedrockContentBlock[]) {
  const out: BedrockMessage[] = [];
  const pendingUserBlocks: BedrockContentBlock[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = stringValue(message.role);
    if (role === "system" || role === "developer") {
      system.push(...textBlocks(message.content));
      continue;
    }
    if (role === "tool") {
      const toolUseId = stringValue(message.tool_call_id);
      if (toolUseId) pendingUserBlocks.push(toolResultBlock(toolUseId, message.content));
      continue;
    }
    if (role === "user") {
      pushMessage(out, "user", [...pendingUserBlocks, ...openAIContentBlocks(message.content)]);
      pendingUserBlocks.length = 0;
      continue;
    }
    if (role === "assistant") {
      flushPendingUserBlocks(out, pendingUserBlocks);
      const blocks = [
        ...openAIContentBlocks(message.content),
        ...chatToolUseBlocks(message.tool_calls)
      ];
      pushMessage(out, "assistant", blocks);
    }
  }
  flushPendingUserBlocks(out, pendingUserBlocks);
  return out;
}

function anthropicMessagesToBedrock(messages: unknown[]) {
  const out: BedrockMessage[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    pushMessage(out, role, anthropicContentBlocks(message.content));
  }
  return out;
}

function responsesInputToBedrock(input: unknown) {
  const out: BedrockMessage[] = [];
  const pendingUserBlocks: BedrockContentBlock[] = [];
  const items = Array.isArray(input) ? input : [{ type: "message", role: "user", content: input }];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call") {
      flushPendingUserBlocks(out, pendingUserBlocks);
      pushMessage(out, "assistant", [responsesFunctionCallToToolUse(item)]);
      continue;
    }
    if (item.type === "function_call_output") {
      const toolUseId = stringValue(item.call_id) ?? stringValue(item.id);
      if (toolUseId) pendingUserBlocks.push(toolResultBlock(toolUseId, item.output));
      continue;
    }
    const role = item.role === "assistant" ? "assistant" : "user";
    if (role === "assistant") flushPendingUserBlocks(out, pendingUserBlocks);
    const blocks = responsesContentBlocks(item.content ?? item.text ?? item.input);
    if (role === "user") {
      pushMessage(out, "user", [...pendingUserBlocks, ...blocks]);
      pendingUserBlocks.length = 0;
    } else {
      pushMessage(out, "assistant", blocks);
    }
  }
  flushPendingUserBlocks(out, pendingUserBlocks);
  return out;
}

function pushMessage(messages: BedrockMessage[], role: "user" | "assistant", content: BedrockContentBlock[]) {
  if (content.length === 0) return;
  const previous = messages[messages.length - 1];
  if (previous?.role === role) {
    previous.content.push(...content);
    return;
  }
  messages.push({ role, content });
}

function flushPendingUserBlocks(messages: BedrockMessage[], pendingUserBlocks: BedrockContentBlock[]) {
  if (pendingUserBlocks.length === 0) return;
  pushMessage(messages, "user", [...pendingUserBlocks]);
  pendingUserBlocks.length = 0;
}

function anthropicSystemBlocks(system: unknown): BedrockContentBlock[] {
  if (typeof system === "string") return system.trim() ? [{ text: system }] : [];
  if (!Array.isArray(system)) return [];
  return system.flatMap((block) => {
    if (typeof block === "string") return block.trim() ? [{ text: block }] : [];
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") return [{ text: block.text }];
    return [];
  });
}

function textBlocks(value: unknown): BedrockContentBlock[] {
  const text = textContent(value);
  return text ? [{ text }] : [];
}

function openAIContentBlocks(content: unknown): BedrockContentBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return textBlocks(content);
  return content.flatMap(openAIContentPartToBedrock);
}

function openAIContentPartToBedrock(part: unknown): BedrockContentBlock[] {
  if (typeof part === "string") return part ? [{ text: part }] : [];
  if (!isRecord(part)) return textBlocks(part);
  if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
    return [{ text: part.text }];
  }
  if ((part.type === "image_url" || part.type === "input_image") && part.image_url !== undefined) {
    return [imageBlockFromOpenAI(part.image_url)];
  }
  if (part.type === "file" || part.type === "input_file") {
    throw new BedrockConverseTranslationError(
      "provider_file_not_supported",
      "Provider-native file references cannot be translated to Bedrock Converse in V1."
    );
  }
  return [];
}

function anthropicContentBlocks(content: unknown): BedrockContentBlock[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return textBlocks(content);
  return content.flatMap((block) => {
    if (typeof block === "string") return block ? [{ text: block }] : [];
    if (!isRecord(block)) return textBlocks(block);
    if (block.type === "text" && typeof block.text === "string") return [{ text: block.text }];
    if (block.type === "image") return [imageBlockFromAnthropic(block.source)];
    if (block.type === "tool_use") {
      return [{
        toolUse: {
          toolUseId: stringValue(block.id) ?? "toolu_translated",
          name: stringValue(block.name) ?? "tool",
          input: jsonObjectOrValue(block.input)
        }
      }];
    }
    if (block.type === "tool_result") {
      const toolUseId = stringValue(block.tool_use_id);
      return toolUseId ? [toolResultBlock(toolUseId, block.content, block.is_error === true)] : [];
    }
    if (block.type === "thinking" || block.type === "reasoning") {
      throw new BedrockConverseTranslationError(
        signedOrEncryptedReason(block),
        "Signed or encrypted reasoning cannot be translated to Bedrock Converse in V1."
      );
    }
    return [];
  });
}

function responsesContentBlocks(content: unknown): BedrockContentBlock[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return textBlocks(content);
  return content.flatMap((part) => {
    if (typeof part === "string") return part ? [{ text: part }] : [];
    if (!isRecord(part)) return textBlocks(part);
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      return [{ text: part.text }];
    }
    if (part.type === "input_image") {
      if (part.file_id !== undefined || part.file_data !== undefined) {
        throw new BedrockConverseTranslationError(
          "provider_file_not_supported",
          "Provider-native file references cannot be translated to Bedrock Converse in V1."
        );
      }
      if (part.image_url !== undefined) return [imageBlockFromOpenAI(part.image_url)];
    }
    if (part.type === "file" || part.type === "input_file") {
      throw new BedrockConverseTranslationError(
        "provider_file_not_supported",
        "Provider-native file references cannot be translated to Bedrock Converse in V1."
      );
    }
    if (part.type === "reasoning" && typeof part.encrypted_content === "string") {
      throw new BedrockConverseTranslationError(
        "encrypted_reasoning_not_supported",
        "Encrypted OpenAI Responses reasoning cannot be translated to Bedrock Converse in V1."
      );
    }
    return [];
  });
}

function chatToolUseBlocks(toolCalls: unknown): BedrockContentBlock[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.flatMap((toolCall) => {
    if (!isRecord(toolCall)) return [];
    const fn = isRecord(toolCall.function) ? toolCall.function : {};
    const id = stringValue(toolCall.id);
    const name = stringValue(fn.name);
    if (!id || !name) return [];
    return [{
      toolUse: {
        toolUseId: id,
        name,
        input: jsonObjectOrValue(parseMaybeJson(fn.arguments))
      }
    }];
  });
}

function responsesFunctionCallToToolUse(item: Record<string, unknown>): BedrockContentBlock {
  return {
    toolUse: {
      toolUseId: stringValue(item.call_id) ?? stringValue(item.id) ?? "call_translated",
      name: stringValue(item.name) ?? "tool",
      input: jsonObjectOrValue(parseMaybeJson(item.arguments))
    }
  };
}

function toolResultBlock(toolUseId: string, content: unknown, isError = false): BedrockContentBlock {
  const parsed = parseMaybeJson(content);
  const resultContent = typeof parsed === "string"
    ? [{ text: parsed }]
    : [{ json: parsed }];
  return {
    toolResult: {
      toolUseId,
      content: resultContent,
      status: isError ? "error" : "success"
    }
  };
}

function applyOpenAIToolConfig(request: Record<string, unknown>, source: Record<string, unknown>) {
  if (!Array.isArray(source.tools) || source.tools.length === 0) return;
  request.toolConfig = {
    tools: source.tools.flatMap(openAIToolToBedrock),
    ...toolChoiceConfig(openAIToolChoice(source.tool_choice))
  };
}

function applyResponsesToolConfig(request: Record<string, unknown>, source: Record<string, unknown>) {
  if (!Array.isArray(source.tools) || source.tools.length === 0) return;
  request.toolConfig = {
    tools: source.tools.flatMap(responsesToolToBedrock),
    ...toolChoiceConfig(openAIToolChoice(source.tool_choice))
  };
}

function applyAnthropicToolConfig(request: Record<string, unknown>, source: Record<string, unknown>) {
  if (!Array.isArray(source.tools) || source.tools.length === 0) return;
  request.toolConfig = {
    tools: source.tools.flatMap(anthropicToolToBedrock),
    ...toolChoiceConfig(anthropicToolChoice(source.tool_choice))
  };
}

function openAIToolToBedrock(tool: unknown): BedrockContentBlock[] {
  if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) return [];
  const spec = toolSpec(
    stringValue(tool.function.name),
    stringValue(tool.function.description),
    isRecord(tool.function.parameters) ? tool.function.parameters : {}
  );
  return spec ? [spec] : [];
}

function responsesToolToBedrock(tool: unknown): BedrockContentBlock[] {
  if (!isRecord(tool) || tool.type !== "function") return [];
  const spec = toolSpec(
    stringValue(tool.name),
    stringValue(tool.description),
    isRecord(tool.parameters) ? tool.parameters : {}
  );
  return spec ? [spec] : [];
}

function anthropicToolToBedrock(tool: unknown): BedrockContentBlock[] {
  if (!isRecord(tool)) return [];
  const spec = toolSpec(
    stringValue(tool.name),
    stringValue(tool.description),
    isRecord(tool.input_schema) ? tool.input_schema : {}
  );
  return spec ? [spec] : [];
}

function toolSpec(name: string | undefined, description: string | undefined, inputSchema: Record<string, unknown>) {
  if (!name) return undefined;
  const spec: Record<string, unknown> = {
    name,
    inputSchema: { json: inputSchema }
  };
  if (description) spec.description = description;
  return { toolSpec: spec };
}

function openAIToolChoice(value: unknown) {
  if (value === "auto") return { auto: {} };
  if (value === "required") return { any: {} };
  if (isRecord(value)) {
    if (value.type === "auto") return { auto: {} };
    if (value.type === "required" || value.type === "any") return { any: {} };
    if (value.type === "function" && isRecord(value.function) && typeof value.function.name === "string") {
      return { tool: { name: value.function.name } };
    }
  }
  return undefined;
}

function anthropicToolChoice(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (value.type === "auto") return { auto: {} };
  if (value.type === "any") return { any: {} };
  if (value.type === "tool" && typeof value.name === "string") return { tool: { name: value.name } };
  return undefined;
}

function toolChoiceConfig(toolChoice: Record<string, unknown> | undefined) {
  return toolChoice ? { toolChoice } : {};
}

function applyInferenceConfig(
  request: Record<string, unknown>,
  input: { maxTokens?: unknown; temperature?: unknown; topP?: unknown; stop?: unknown }
) {
  const config: Record<string, unknown> = {};
  if (typeof input.maxTokens === "number") config.maxTokens = input.maxTokens;
  if (typeof input.temperature === "number") config.temperature = input.temperature;
  if (typeof input.topP === "number") config.topP = input.topP;
  const stopSequences = stopSequencesFrom(input.stop);
  if (stopSequences.length > 0) config.stopSequences = stopSequences;
  if (Object.keys(config).length > 0) request.inferenceConfig = config;
}

function stopSequencesFrom(value: unknown) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function imageBlockFromOpenAI(value: unknown) {
  let url: string | undefined;
  if (typeof value === "string") {
    url = value;
  } else if (isRecord(value) && typeof value.url === "string") {
    url = value.url;
  }
  if (!url) {
    throw new BedrockConverseTranslationError(
      "image_url_not_supported",
      "OpenAI image content must include a data URL to translate to Bedrock Converse in V1."
    );
  }
  return imageBlockFromDataUrl(url);
}

function imageBlockFromAnthropic(source: unknown) {
  if (!isRecord(source)) {
    throw new BedrockConverseTranslationError(
      "image_source_not_supported",
      "Anthropic image content must include a base64 source to translate to Bedrock Converse in V1."
    );
  }
  if (source.type === "url") {
    throw new BedrockConverseTranslationError(
      "remote_image_url_not_supported",
      "Remote image URLs cannot be translated to Bedrock Converse in V1."
    );
  }
  if (source.type !== "base64" || typeof source.media_type !== "string" || typeof source.data !== "string") {
    throw new BedrockConverseTranslationError(
      "image_source_not_supported",
      "Anthropic image content must include a base64 source to translate to Bedrock Converse in V1."
    );
  }
  return imageBlock(source.media_type, source.data);
}

function imageBlockFromDataUrl(url: string) {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(url);
  if (!match) {
    throw new BedrockConverseTranslationError(
      "remote_image_url_not_supported",
      "Remote image URLs cannot be translated to Bedrock Converse in V1."
    );
  }
  return imageBlock(match[1], match[2]);
}

function imageBlock(mediaType: string, data: string) {
  return {
    image: {
      format: imageFormat(mediaType),
      source: { bytes: decodeBase64Image(data) }
    }
  };
}

function decodeBase64Image(data: string) {
  const normalized = data.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new BedrockConverseTranslationError(
      "image_base64_invalid",
      "Image content must be valid base64 to translate to Bedrock Converse in V1."
    );
  }
  return Buffer.from(normalized, "base64");
}

function imageFormat(mediaType: string) {
  const subtype = mediaType.split("/").at(-1)?.toLowerCase();
  if (subtype === "jpg") return "jpeg";
  if (subtype === "png" || subtype === "jpeg" || subtype === "gif" || subtype === "webp") return subtype;
  return subtype ?? "png";
}

function jsonObjectOrValue(value: unknown) {
  if (value === undefined || value === null || value === "") return {};
  return value;
}

function signedOrEncryptedReason(block: Record<string, unknown>) {
  if (typeof block.encrypted_content === "string") return "encrypted_reasoning_not_supported";
  return "signed_reasoning_not_supported";
}
