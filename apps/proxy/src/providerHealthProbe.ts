import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand
} from "@aws-sdk/client-bedrock-runtime";

import type { ProviderHealthClassification } from "@proxy/schema";

import type { AppConfig } from "./config.js";
import { jsonPayload, type EventService } from "./events.js";
import {
  providerEndpointForDialect,
  type ProviderRegistryEndpoint,
  type ProviderRegistryHttpEndpoint,
  type ProviderRegistryEntry,
  type ProviderRegistryResolver
} from "./persistence/providers.js";
import type { ProviderCredentialStore } from "./persistence/providerCredentials.js";
import {
  bedrockCredentialResolverConfig,
  resolveBedrockCredentials,
  resolvePlaintextBedrockCredentials
} from "./providerAdapters/bedrockCredentials.js";
import { classifyBedrockError } from "./providerAdapters/bedrockErrors.js";
import type {
  BedrockRuntimeClientFactory,
  BedrockRuntimeClientFactoryInput,
  BedrockRuntimeClientLike
} from "./providerAdapters/bedrockRuntime.js";
import type { ProviderAdapterFailureClassification } from "./providerAdapters/types.js";
import { canAuthenticateOrgProvider, providerRequestBody, providerRequestHeaders } from "./providerAdapters/genericHttp.js";
import { classifyProviderTerminalHealth } from "./providerHealth.js";
import type { Dialect, JsonObject, Provider, UpstreamCredential } from "./types.js";
import { isRecord } from "./util.js";
import {
  fetchWithPinnedAddress,
  providerRequestPinnedAddress,
  providerRequestRedirect,
  providerRequestUrl
} from "./upstream.js";
import { createId } from "./util.js";

const PROBE_PROMPT = "Reply with ok.";
const PROBE_MAX_OUTPUT_TOKENS = 8;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_OPERATIONS = ["full", "model_access", "streaming"] as const;

type ProviderHealthProbeOperation = typeof PROBE_OPERATIONS[number];

export type ProviderHealthProbeInput = {
  organizationId: string;
  workspaceId: string;
  actorUserId: string;
  providerAccountId: string;
  model: string;
  operation?: string;
};

export type ProviderHealthProbeResult = {
  probeId: string;
  providerAccountId: string;
  provider: string;
  model: string;
  status: "success" | "failed" | "partial";
  healthStatus: string;
  errorType?: string | null;
  message?: string | null;
  statusCode?: number | null;
  latencyMs: number;
  checkedAt: string;
  stateUpdated: boolean;
  dimensions: JsonObject;
};

export type ProviderHealthProbeDependencies = {
  config: AppConfig;
  events: EventService;
  providerCredentials: Pick<ProviderCredentialStore, "resolveAccount">;
  providerRegistry: ProviderRegistryResolver;
  bedrockRuntimeClientFactory?: BedrockRuntimeClientFactory;
};

type ProbeRequestResult = {
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  headers: Record<string, string>;
  bodyText?: string;
  error?: string;
  adapterClassification?: ProviderAdapterFailureClassification;
};

export class ProviderHealthProbeError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

export async function probeProviderCredential(
  dependencies: ProviderHealthProbeDependencies,
  input: ProviderHealthProbeInput
): Promise<ProviderHealthProbeResult> {
  const model = input.model.trim();
  if (!model) throw new ProviderHealthProbeError("provider_probe_model_required", 400);
  const operation = probeOperation(input.operation);

  const credential = await dependencies.providerCredentials.resolveAccount({
    organizationId: input.organizationId,
    providerAccountId: input.providerAccountId
  });
  if (!credential) throw new ProviderHealthProbeError("provider_credential_not_found", 404);

  const provider = await dependencies.providerRegistry.resolve({
    organizationId: input.organizationId,
    provider: credential.provider
  });
  if (!provider || !provider.enabled) throw new ProviderHealthProbeError("provider_not_found", 404);
  if (!canAuthenticateOrgProvider(provider, credential)) {
    throw new ProviderHealthProbeError("provider_credential_unresolved", 400);
  }

  if (provider.adapterKind === "aws-bedrock-converse") {
    return probeBedrockProviderCredential(dependencies, input, {
      provider,
      credential,
      model,
      operation
    });
  }

  const endpoint = probeEndpoint(provider);
  if (!endpoint) throw new ProviderHealthProbeError("provider_probe_endpoint_not_found", 400);

  const probeId = createId("provider_health_probe");
  const checkedAt = new Date();
  const basic = await runProbeRequest(dependencies.config, provider, endpoint, credential, model, false);
  if (!basic.ok) {
    return appendProbeResult(dependencies, input, {
      probeId,
      provider,
      endpoint,
      credential,
      model,
      checkedAt,
      basic,
      stream: streamNotAttempted(),
      toolCalls: toolCallsNotConfigured(),
      status: "failed"
    });
  }

  if (operation === "model_access") {
    return appendProbeResult(dependencies, input, {
      probeId,
      provider,
      endpoint,
      credential,
      model,
      checkedAt,
      basic,
      stream: streamNotAttempted(),
      toolCalls: toolCallsNotConfigured(),
      status: "success"
    });
  }

  const stream = supportsStreaming(endpoint)
    ? await runProbeRequest(dependencies.config, provider, endpoint, credential, model, true)
    : streamNotSupported();
  let status: ProviderHealthProbeResult["status"] = "partial";
  if (stream.ok) status = "success";
  else if (operation === "streaming") status = "failed";

  return appendProbeResult(dependencies, input, {
    probeId,
    provider,
    endpoint,
    credential,
    model,
    checkedAt,
    basic,
    stream,
    toolCalls: toolCallsNotConfigured(),
    status,
    classificationResult: operation === "streaming" && !stream.ok ? stream : undefined
  });
}

export function shouldUpdateHealthFromProbe(classification: ProviderHealthClassification | undefined) {
  return Boolean(
    classification &&
    classification.confidence !== "unknown" &&
    (classification.scope === "provider_account" || classification.scope === "provider_account_model")
  );
}

function probeEndpoint(provider: ProviderRegistryEntry) {
  return providerEndpointForDialect(provider, "anthropic-messages") ??
    providerEndpointForDialect(provider, "openai-responses") ??
    providerEndpointForDialect(provider, "openai-chat");
}

async function probeBedrockProviderCredential(
  dependencies: ProviderHealthProbeDependencies,
  input: ProviderHealthProbeInput,
  context: {
    provider: ProviderRegistryEntry;
    credential: UpstreamCredential;
    model: string;
    operation: ProviderHealthProbeOperation;
  }
) {
  const converseEndpoint = bedrockProbeEndpoint(context.provider, "Converse");
  if (!converseEndpoint) throw new ProviderHealthProbeError("provider_probe_endpoint_not_found", 400);
  const streamEndpoint = bedrockProbeEndpoint(context.provider, "ConverseStream");
  const probeId = createId("provider_health_probe");
  const checkedAt = new Date();
  const basic = await runBedrockProbeRequest(dependencies, context.provider, context.credential, context.model, "Converse");
  if (!basic.ok) {
    return appendProbeResult(dependencies, input, {
      probeId,
      provider: context.provider,
      endpoint: converseEndpoint,
      credential: context.credential,
      model: context.model,
      checkedAt,
      basic,
      stream: streamNotAttempted(),
      toolCalls: toolCallsNotConfigured(),
      status: "failed"
    });
  }
  if (context.operation === "model_access") {
    return appendProbeResult(dependencies, input, {
      probeId,
      provider: context.provider,
      endpoint: converseEndpoint,
      credential: context.credential,
      model: context.model,
      checkedAt,
      basic,
      stream: streamNotAttempted(),
      toolCalls: toolCallsNotConfigured(),
      status: "success"
    });
  }
  if (!streamEndpoint) {
    return appendProbeResult(dependencies, input, {
      probeId,
      provider: context.provider,
      endpoint: converseEndpoint,
      credential: context.credential,
      model: context.model,
      checkedAt,
      basic,
      stream: streamNotSupported(),
      toolCalls: toolCallsNotConfigured(),
      status: "success"
    });
  }

  const stream = await runBedrockProbeRequest(dependencies, context.provider, context.credential, context.model, "ConverseStream");
  let status: ProviderHealthProbeResult["status"] = "partial";
  if (stream.ok) status = "success";
  else if (context.operation === "streaming") status = "failed";
  return appendProbeResult(dependencies, input, {
    probeId,
    provider: context.provider,
    endpoint: streamEndpoint,
    credential: context.credential,
    model: context.model,
    checkedAt,
    basic,
    stream,
    toolCalls: toolCallsNotConfigured(),
    status,
    classificationResult: context.operation === "streaming" && !stream.ok ? stream : undefined
  });
}

async function runBedrockProbeRequest(
  dependencies: ProviderHealthProbeDependencies,
  provider: ProviderRegistryEntry,
  credential: UpstreamCredential,
  model: string,
  operation: "Converse" | "ConverseStream"
): Promise<ProbeRequestResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const region = bedrockRegion(provider, credential);
  try {
    const resolution = await resolveBedrockProbeCredential(dependencies.config, provider, credential);
    const clientFactory = dependencies.bedrockRuntimeClientFactory ?? defaultBedrockProbeClientFactory;
    const client = clientFactory({
      region,
      endpoint: bedrockEndpoint(provider, credential),
      credential: resolution
    });
    const request = bedrockProbeRequest(model);
    if (operation === "ConverseStream") {
      await consumeBedrockStream(client, request, controller.signal);
    } else {
      await client.send(new ConverseCommand(request as never), { abortSignal: controller.signal });
    }
    return {
      ok: true,
      statusCode: 200,
      latencyMs: elapsedMs(started),
      headers: {}
    };
  } catch (error) {
    const statusCode = bedrockErrorStatus(error);
    const adapterClassification = classifyBedrockError({
      error,
      status: statusCode || undefined,
      region,
      model,
      operation,
      timedOut: controller.signal.aborted
    });
    return {
      ok: false,
      statusCode,
      latencyMs: elapsedMs(started),
      headers: {},
      error: bedrockProbeErrorMessage(error),
      adapterClassification
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function appendProbeResult(
  dependencies: ProviderHealthProbeDependencies,
  input: ProviderHealthProbeInput,
  result: {
    probeId: string;
    provider: ProviderRegistryEntry;
    endpoint: ProviderRegistryEndpoint;
    credential: UpstreamCredential;
    model: string;
    checkedAt: Date;
    basic: ProbeRequestResult;
    stream: ProbeRequestResult | { ok: true; status: "not_supported" | "not_attempted"; latencyMs: 0 };
    toolCalls: JsonObject;
    status: "success" | "failed" | "partial";
    classificationResult?: ProbeRequestResult;
  }
) {
  const failureResult = result.classificationResult ?? result.basic;
  const classification = failureResult.ok
    ? undefined
    : classifyProbeFailure(result.credential.provider, result.model, failureResult, result.checkedAt);
  const eventClassification = classification ? probeEventClassification(classification) : undefined;
  const stateUpdated = result.status === "success" || shouldUpdateHealthFromProbe(classification);
  const healthStatus = result.status === "success" ? "healthy" : healthStatusForClassification(classification);
  const errorType = failureResult.ok ? streamErrorType(result.stream) : classification?.errorType ?? null;
  const message = failureResult.ok
    ? streamMessage(result.stream)
    : probeFailureMessage(classification, failureResult);
  const dimensions = jsonPayload({
    target: probeTargetDimension(result.endpoint),
    basicChat: requestDimension(result.basic),
    streaming: streamDimension(result.stream),
    toolCalls: result.toolCalls,
    failure: probeFailureDimension(failureResult)
  }) as JsonObject;

  await dependencies.events.append({
    tenantId: input.organizationId,
    workspaceId: input.workspaceId,
    scopeType: "provider_account",
    scopeId: input.providerAccountId,
    correlationId: result.probeId,
    actor: { type: "user", id: input.actorUserId },
    producer: "proxy.provider-health",
    eventType: "provider_account.health_probe_completed",
    payload: {
      probeId: result.probeId,
      provider: result.provider.slug,
      providerId: result.provider.id,
      providerAccountId: input.providerAccountId,
      model: result.model,
      endpointDialect: result.endpoint.dialect,
      status: result.status,
      healthStatus,
      errorType,
      message,
      statusCode: failureResult.statusCode,
      latencyMs: failureResult.latencyMs,
      checkedAt: result.checkedAt.toISOString(),
      stateUpdated,
      operation: input.operation ?? "full",
      streamingSucceeded: result.stream.ok === true && !("status" in result.stream),
      classification: eventClassification ? jsonPayload(eventClassification) : null,
      dimensions
    }
  });

  return {
    probeId: result.probeId,
    providerAccountId: input.providerAccountId,
    provider: result.provider.slug,
    model: result.model,
    status: result.status,
    healthStatus,
    errorType,
    message,
    statusCode: failureResult.statusCode,
    latencyMs: failureResult.latencyMs,
    checkedAt: result.checkedAt.toISOString(),
    stateUpdated,
    dimensions
  };
}

async function runProbeRequest(
  config: AppConfig,
  provider: ProviderRegistryEntry,
  endpoint: ProviderRegistryHttpEndpoint,
  credential: UpstreamCredential,
  model: string,
  stream: boolean
): Promise<ProbeRequestResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const body = providerRequestBody({
    provider,
    body: probeBody(endpoint.dialect, model, stream),
    credential
  });
  try {
    const response = await fetchWithPinnedAddress(providerRequestUrl({
      provider,
      endpoint,
      config,
      credential
    }), {
      method: "POST",
      headers: providerRequestHeaders({
        config,
        provider,
        endpoint,
        surface: endpoint.dialect,
        body,
        incoming: {},
        credential
      }),
      body: JSON.stringify(body),
      redirect: providerRequestRedirect({ provider, credential }),
      signal: controller.signal
    }, providerRequestPinnedAddress({ provider, config, credential }));
    const bodyText = await response.text();
    return {
      ok: response.ok,
      statusCode: response.status,
      latencyMs: elapsedMs(started),
      headers: responseHeaders(response.headers),
      bodyText: bodyText.slice(0, 2048)
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      latencyMs: elapsedMs(started),
      headers: {},
      error: error instanceof Error ? error.message : "Provider probe failed."
    };
  } finally {
    clearTimeout(timeout);
  }
}

function probeOperation(value: string | undefined): ProviderHealthProbeOperation {
  if (value === undefined || value === null || value.trim() === "") return "full";
  const normalized = value.trim();
  if (PROBE_OPERATIONS.some((operation) => operation === normalized)) {
    return normalized as ProviderHealthProbeOperation;
  }
  throw new ProviderHealthProbeError("provider_probe_operation_invalid", 400);
}

function probeBody(dialect: Dialect, model: string, stream: boolean) {
  if (dialect === "openai-responses") {
    return {
      model,
      input: PROBE_PROMPT,
      max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
      stream
    };
  }
  if (dialect === "openai-chat") {
    return {
      model,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: PROBE_MAX_OUTPUT_TOKENS,
      stream
    };
  }
  if (dialect === "anthropic-messages") {
    return {
      model,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: PROBE_MAX_OUTPUT_TOKENS,
      stream
    };
  }
  throw new ProviderHealthProbeError("provider_probe_endpoint_unsupported", 400);
}

function defaultBedrockProbeClientFactory(input: BedrockRuntimeClientFactoryInput): BedrockRuntimeClientLike {
  const clientConfig: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
    region: input.region,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.credential.kind === "aws_credentials"
      ? { credentials: input.credential.credentialProvider }
      : { token: { token: input.credential.bearerToken } })
  };
  return new BedrockRuntimeClient(clientConfig);
}

async function resolveBedrockProbeCredential(
  config: AppConfig,
  provider: ProviderRegistryEntry,
  credential: UpstreamCredential
) {
  if (credential.token) {
    return resolvePlaintextBedrockCredentials({
      plaintext: credential.token,
      accountSettings: credential.providerAccountSettings
    });
  }
  const resolved = await resolveBedrockCredentials({
    accountSettings: credential.providerAccountSettings,
    providerOrganizationId: provider.organizationId,
    config: bedrockCredentialResolverConfig(config)
  });
  if (!resolved) throw new Error("bedrock_credential_unresolved");
  return resolved;
}

function bedrockProbeEndpoint(provider: ProviderRegistryEntry, operation: "Converse" | "ConverseStream") {
  return provider.endpoints.find((endpoint) =>
    "operation" in endpoint &&
    endpoint.dialect === "bedrock-converse" &&
    endpoint.operation === operation
  );
}

function bedrockProbeRequest(modelId: string) {
  return {
    modelId,
    messages: [
      { role: "user", content: [{ text: PROBE_PROMPT }] }
    ],
    inferenceConfig: { maxTokens: PROBE_MAX_OUTPUT_TOKENS }
  };
}

async function consumeBedrockStream(
  client: BedrockRuntimeClientLike,
  request: Record<string, unknown>,
  signal: AbortSignal
) {
  const output = await client.send(new ConverseStreamCommand(request as never), { abortSignal: signal });
  const stream = isRecord(output) ? output.stream : undefined;
  if (!isAsyncIterable(stream)) throw new Error("bedrock_stream_missing");
  for await (const event of stream) {
    const exception = bedrockStreamException(event);
    if (exception) throw exception;
  }
}

function bedrockStreamException(event: unknown) {
  if (!isRecord(event)) return undefined;
  for (const [key, value] of Object.entries(event)) {
    if (!key.toLowerCase().includes("exception")) continue;
    if (isRecord(value)) {
      return {
        name: key,
        message: stringValue(value.message) ?? key,
        $metadata: value.$metadata
      };
    }
    return { name: key, message: key };
  }
  return undefined;
}

function bedrockRegion(provider: ProviderRegistryEntry, credential: UpstreamCredential) {
  return stringValue(credential.providerAccountSettings?.region) ??
    stringValue(provider.adapterConfig.defaultRegion) ??
    "us-east-1";
}

function bedrockEndpoint(provider: ProviderRegistryEntry, credential: UpstreamCredential) {
  return credential.baseUrl ??
    stringValue(credential.providerAccountSettings?.endpointOverride) ??
    (!provider.builtin ? provider.baseUrl : undefined);
}

function bedrockErrorStatus(error: unknown) {
  if (!isRecord(error)) return 0;
  const statusCode = error.$metadata && isRecord(error.$metadata) && typeof error.$metadata.httpStatusCode === "number"
    ? error.$metadata.httpStatusCode
    : undefined;
  if (statusCode && statusCode >= 400 && statusCode <= 599) return statusCode;
  const name = stringValue(error.name)?.toLowerCase() ?? "";
  if (name.includes("throttl")) return 429;
  if (name.includes("validation")) return 400;
  if (name.includes("access") || name.includes("auth")) return 403;
  return 0;
}

function bedrockProbeErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) return stringValue(error.message) ?? stringValue(error.name) ?? "Bedrock probe failed.";
  return "Bedrock probe failed.";
}

function classifyProbeFailure(
  provider: Provider,
  model: string,
  result: ProbeRequestResult,
  now: Date
) {
  return classifyProviderTerminalHealth({
    provider,
    model,
    terminalStatus: "failed",
    statusCode: result.statusCode,
    error: result.bodyText ?? result.error,
    headers: result.headers,
    adapterClassification: result.adapterClassification,
    now
  });
}

function healthStatusForClassification(classification: ProviderHealthClassification | undefined) {
  if (!classification) return "unknown";
  if (classification.scope === "provider_account") {
    if (classification.errorType === "auth_invalid") return "terminal";
    if (classification.cooldownUntil) return "cooldown";
  }
  if (classification.scope === "provider_account_model") {
    if (classification.errorType === "model_access_denied") return "terminal";
    if (classification.cooldownUntil) return "locked_out";
  }
  return "unknown";
}

function probeEventClassification(classification: ProviderHealthClassification): ProviderHealthClassification {
  return {
    ...classification,
    message: probeFailureMessage(classification)
  };
}

function probeFailureMessage(
  classification: ProviderHealthClassification | undefined,
  result?: Pick<ProbeRequestResult, "error">
) {
  if (classification) return `Probe classified as ${classification.errorType}.`;
  if (result?.error) return "Probe failed before receiving an upstream response.";
  return "Probe failed.";
}

function supportsStreaming(endpoint: ProviderRegistryHttpEndpoint) {
  return endpoint.dialect === "openai-responses" ||
    endpoint.dialect === "openai-chat" ||
    endpoint.dialect === "anthropic-messages";
}

function requestDimension(result: ProbeRequestResult) {
  return {
    status: result.ok ? "passed" : "failed",
    statusCode: result.statusCode,
    latencyMs: result.latencyMs
  };
}

function probeTargetDimension(endpoint: ProviderRegistryEndpoint) {
  return {
    dialect: endpoint.dialect,
    ...("operation" in endpoint ? { operation: endpoint.operation } : {})
  };
}

function probeFailureDimension(result: ProbeRequestResult) {
  const classification = result.adapterClassification;
  if (!classification) return undefined;
  return {
    category: classification.category,
    errorType: classification.errorType,
    metadata: classification.metadata
  };
}

function streamDimension(result: ProbeRequestResult | { ok: true; status: "not_supported" | "not_attempted"; latencyMs: 0 }) {
  if ("status" in result) return { status: result.status };
  return {
    status: result.ok ? "passed" : "failed",
    statusCode: result.statusCode,
    latencyMs: result.latencyMs
  };
}

function toolCallsNotConfigured(): JsonObject {
  return { status: "not_configured" };
}

function streamNotSupported() {
  return { ok: true as const, status: "not_supported" as const, latencyMs: 0 as const };
}

function streamNotAttempted() {
  return { ok: true as const, status: "not_attempted" as const, latencyMs: 0 as const };
}

function streamErrorType(result: ProbeRequestResult | { ok: true; status: "not_supported" | "not_attempted"; latencyMs: 0 }) {
  return result.ok ? null : "stream_failed";
}

function streamMessage(result: ProbeRequestResult | { ok: true; status: "not_supported" | "not_attempted"; latencyMs: 0 }) {
  if (result.ok) return null;
  return result.error ?? "Streaming probe failed.";
}

function responseHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function elapsedMs(started: number) {
  return Math.max(0, Date.now() - started);
}
