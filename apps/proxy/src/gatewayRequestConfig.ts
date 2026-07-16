import type { Dialect, GatewayOperationId, GatewayParameterCaps } from "@proxy/schema";

import { isRecord } from "./util.js";

export function gatewayParameters(body: unknown): GatewayParameterCaps {
  if (!isRecord(body)) return {};
  const parameters: GatewayParameterCaps = {};
  for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const) {
    const value = body[key];
    if (value !== undefined) parameters[key] = value as number;
  }
  if (isRecord(body.inferenceConfig) && body.inferenceConfig.maxTokens !== undefined) {
    parameters.max_tokens = body.inferenceConfig.maxTokens as number;
  }
  return parameters;
}

export function deploymentRequestConfig(
  egressWireId: Dialect,
  config: Record<string, unknown>
) {
  const request: Record<string, unknown> = {};
  if (egressWireId !== "bedrock-converse" && isRecord(config.metadata)) {
    request.metadata = config.metadata;
  }
  if (egressWireId === "openai-responses") {
    if (isRecord(config.reasoning)) request.reasoning = config.reasoning;
    if (isRecord(config.text)) request.text = config.text;
    const maxOutputTokens = positiveInteger(config.maxOutputTokens ?? config.max_output_tokens);
    if (maxOutputTokens) request.max_output_tokens = maxOutputTokens;
  }
  if (egressWireId === "openai-chat") {
    const reasoning = isRecord(config.reasoning) ? config.reasoning : {};
    if (typeof reasoning.effort === "string") request.reasoning_effort = reasoning.effort;
    const maxCompletionTokens = positiveInteger(
      config.maxCompletionTokens ?? config.max_completion_tokens ??
      config.maxOutputTokens ?? config.max_output_tokens
    );
    if (maxCompletionTokens) request.max_completion_tokens = maxCompletionTokens;
  }
  if (egressWireId === "anthropic-messages") {
    if (isRecord(config.thinking)) request.thinking = config.thinking;
    if (isRecord(config.output_config)) request.output_config = config.output_config;
    const maxTokens = positiveInteger(config.maxTokens ?? config.max_tokens);
    if (maxTokens) request.max_tokens = maxTokens;
  }
  if (egressWireId === "bedrock-converse") {
    const inferenceConfig = isRecord(config.inferenceConfig)
      ? { ...config.inferenceConfig }
      : {};
    const maxTokens = positiveInteger(
      config.maxTokens ?? config.max_tokens ??
      config.maxOutputTokens ?? config.max_output_tokens
    );
    if (maxTokens) inferenceConfig.maxTokens = maxTokens;
    if (Object.keys(inferenceConfig).length > 0) request.inferenceConfig = inferenceConfig;
    applyBedrockMetadataConfig(request, bedrockMetadataSettings(config.metadata));
  }
  return request;
}

export function applyGatewaySystemPrompt(
  request: Record<string, unknown>,
  egressWireId: Dialect,
  systemPrompt: string | undefined
) {
  if (!systemPrompt) return;
  if (egressWireId === "openai-responses") {
    request.instructions = typeof request.instructions === "string" && request.instructions.trim()
      ? `${systemPrompt}\n\n${request.instructions}`
      : systemPrompt;
    return;
  }
  if (egressWireId === "openai-chat") {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    request.messages = [{ role: "system", content: systemPrompt }, ...messages];
    return;
  }
  if (egressWireId === "anthropic-messages") {
    if (Array.isArray(request.system)) {
      request.system = [{ type: "text", text: systemPrompt }, ...request.system];
    } else if (typeof request.system === "string" && request.system.trim()) {
      request.system = `${systemPrompt}\n\n${request.system}`;
    } else {
      request.system = systemPrompt;
    }
    return;
  }
  const system = Array.isArray(request.system) ? request.system : [];
  request.system = [{ text: systemPrompt }, ...system];
}

export function applyRequestConfig(
  request: Record<string, unknown>,
  config: Record<string, unknown>
) {
  for (const [key, value] of Object.entries(config)) {
    request[key] = isRecord(request[key]) && isRecord(value)
      ? { ...request[key], ...value }
      : value;
  }
}

export function effectiveGatewayParameters(input: {
  parameters?: GatewayParameterCaps;
  operationId: GatewayOperationId;
  egressWireId: Dialect;
  deploymentConfig: Record<string, unknown>;
  requestConfig: Record<string, unknown>;
}) {
  if (input.operationId !== "text.generate") return {};
  const request: Record<string, unknown> = {};
  const requestedValues = Object.values(input.parameters ?? {})
    .filter((value): value is number => typeof value === "number");
  const parameterKey = nativeMaxTokenKey(input.egressWireId);
  if (requestedValues.length > 0) {
    const requestedMax = Math.max(...requestedValues);
    if (parameterKey) request[parameterKey] = requestedMax;
    if (input.egressWireId === "bedrock-converse") {
      request.inferenceConfig = { maxTokens: requestedMax };
    }
  }
  applyRequestConfig(request, deploymentRequestConfig(input.egressWireId, input.deploymentConfig));
  applyRequestConfig(request, input.requestConfig);
  return gatewayParameters(request);
}

function nativeMaxTokenKey(egressWireId: Dialect) {
  if (egressWireId === "openai-responses") return "max_output_tokens";
  if (egressWireId === "openai-chat") return "max_completion_tokens";
  if (egressWireId === "anthropic-messages") return "max_tokens";
  return undefined;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function applyBedrockMetadataConfig(
  request: Record<string, unknown>,
  settings: Record<string, unknown> | undefined
) {
  if (!settings) return;
  const requestMetadata = stringRecord(settings.requestMetadata);
  if (requestMetadata) request.requestMetadata = requestMetadata;
  const guardrailIdentifier = stringValue(settings.guardrailIdentifier);
  const guardrailVersion = stringValue(settings.guardrailVersion);
  if (guardrailIdentifier && guardrailVersion) {
    request.guardrailConfig = {
      guardrailIdentifier,
      guardrailVersion,
      ...(settings.guardrailTrace === "enabled" || settings.guardrailTrace === "disabled"
        ? { trace: settings.guardrailTrace }
        : {})
    };
  }
  const latency = stringValue(settings.serviceTier) ?? stringValue(settings.latency);
  if (latency === "standard" || latency === "optimized") {
    request.performanceConfig = { latency };
  }
  if (isRecord(settings.additionalModelRequestFields)) {
    request.additionalModelRequestFields = settings.additionalModelRequestFields;
  }
}

function bedrockMetadataSettings(metadata: unknown) {
  if (!isRecord(metadata)) return undefined;
  const candidate = metadata.bedrockConverse ?? metadata.bedrock ?? metadata.bedrockSettings;
  return isRecord(candidate) ? candidate : undefined;
}

function stringRecord(value: unknown) {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
