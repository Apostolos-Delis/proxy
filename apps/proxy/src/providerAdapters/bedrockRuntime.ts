import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand
} from "@aws-sdk/client-bedrock-runtime";

import type { AppConfig } from "../config.js";
import {
  type EventAppender,
  jsonPayload
} from "../events.js";
import type { ProviderForwardInput } from "../adapters.js";
import type {
  ProviderRegistryEndpoint,
  ProviderRegistryEntry
} from "../persistence/providers.js";
import {
  bedrockCredentialEventMetadata,
  bedrockCredentialResolverConfig,
  type BedrockCredentialResolution,
  redactBedrockCredentialError,
  resolveBedrockCredentials,
  resolvePlaintextBedrockCredentials
} from "./bedrockCredentials.js";
import type { GenericHttpResponseTranslation } from "./genericHttp.js";
import type { ProviderAdapterFailureClassification } from "./types.js";
import { classifyBedrockError, parseBedrockErrorBody } from "./bedrockErrors.js";
import { resolveBedrockConverseModelId } from "./bedrockModelIds.js";
import {
  bedrockConverseErrorToAnthropicMessages,
  bedrockConverseErrorToOpenAI,
  bedrockConverseResponseToAnthropicMessages,
  bedrockConverseResponseToOpenAIChat,
  bedrockConverseResponseToOpenAIResponses,
  bedrockConverseStreamToAnthropicMessagesSse,
  bedrockConverseStreamToOpenAIChatSse,
  bedrockConverseStreamToOpenAIResponsesSse
} from "../translators/bedrockConverse.js";
import { requestBodyHash } from "../toolResultCompression.js";
import type { Surface, UpstreamCredential } from "../types.js";
import { isRecord } from "../util.js";

type BedrockRequestContext = {
  region: string;
  model: string | undefined;
  operation: "Converse" | "ConverseStream";
};

export type BedrockRuntimeClientLike = {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
};

export type BedrockRuntimeClientFactoryInput = {
  region: string;
  endpoint?: string;
  credential: BedrockCredentialResolution;
};

export type BedrockRuntimeClientFactory = (input: BedrockRuntimeClientFactoryInput) => BedrockRuntimeClientLike;

export class BedrockRuntimeProviderAdapter {
  private readonly responseContexts = new WeakMap<Response, BedrockRequestContext>();
  private readonly fetchErrorContexts = new WeakMap<object, BedrockRequestContext>();

  constructor(
    private readonly config: AppConfig,
    private readonly events: EventAppender,
    private readonly clientFactory: BedrockRuntimeClientFactory = defaultBedrockRuntimeClientFactory
  ) {}

  async fetchWithRateLimitRetries(input: {
    input: ProviderForwardInput;
    providerAttemptId: string;
    provider: ProviderRegistryEntry;
    endpoint: ProviderRegistryEndpoint;
    signal: AbortSignal;
  }) {
    assertBedrockEndpoint(input.endpoint);
    const request = bedrockRequest(input.input.body, input.input.decision.selectedModel, input.input.decision.providerSettings);
    const streaming = input.input.responseStream === true || isRecord(input.input.body) && input.input.body.stream === true;
    const operation: BedrockRequestContext["operation"] = streaming ? "ConverseStream" : "Converse";
    assertOperationEndpoint(input.provider, operation);
    const region = bedrockRegion(input.provider, input.input.credential);
    const context = {
      region,
      model: typeof request.modelId === "string" ? request.modelId : input.input.decision.selectedModel,
      operation
    };

    try {
      const credential = await this.resolveCredential(input.provider, input.input.credential);
      const client = this.clientFactory({
        region,
        endpoint: bedrockEndpoint(input.provider, input.input.credential),
        credential
      });

      await this.events.append({
        scopeType: "request",
        scopeId: input.input.requestId,
        correlationId: input.input.requestId,
        idempotencyKey: `${input.input.idempotencyKey}:provider-forwarded:1`,
        producer: "proxy.provider",
        eventType: "provider.request_forwarded",
        payload: {
          surface: input.input.surface,
          provider: input.input.provider,
          adapterKind: input.provider.adapterKind,
          model: input.input.decision.selectedModel ?? "unknown",
          providerAttemptId: input.providerAttemptId,
          upstreamAttempt: 1,
          operation,
          preparedRequestHash: requestBodyHash(input.input.body),
          forwardedRequestHash: requestBodyHash(request),
          credential: jsonPayload(bedrockCredentialEventMetadata(credential)),
          ...input.input.compressionTelemetry
        }
      });

      const response = streaming
        ? await this.converseStream({ client, request, surface: input.input.surface, signal: input.signal })
        : await this.converse({ client, request, surface: input.input.surface, signal: input.signal });
      this.responseContexts.set(response, context);
      return response;
    } catch (error) {
      this.rememberFetchErrorContext(error, context);
      throw error;
    }
  }

  responseTranslation(): GenericHttpResponseTranslation {
    return { kind: "native" };
  }

  translateResponseText(text: string) {
    return text;
  }

  transformResponseStream(body: AsyncIterable<Uint8Array>) {
    return body;
  }

  classifyResponse(input: { status: number; bodyText?: string; response?: Response }) {
    if (input.status < 400) return undefined;
    const context = this.contextForResponse(input.response);
    return classifyBedrockError({
      ...parseBedrockErrorBody(input.bodyText),
      status: input.status,
      region: context?.region,
      model: context?.model,
      operation: context?.operation
    });
  }

  classifyFetchError(input: { error: unknown; timedOut: boolean }): ProviderAdapterFailureClassification {
    const redactedCredentialError = redactBedrockCredentialError(input.error);
    const context = this.contextForFetchError(input.error);
    return classifyBedrockError({
      error: { name: redactedCredentialError.code, message: redactedCredentialError.message },
      timedOut: input.timedOut,
      region: context?.region,
      model: context?.model,
      operation: context?.operation
    });
  }

  classifyStreamError(input: { message?: string; response?: Response }) {
    const context = this.contextForResponse(input.response);
    return classifyBedrockError({
      message: input.message,
      region: context?.region,
      model: context?.model,
      operation: "ConverseStream"
    });
  }

  classifyMalformedResponse(input: { message?: string; response?: Response }) {
    const context = this.contextForResponse(input.response);
    return classifyBedrockError({
      message: input.message ?? "Malformed Bedrock response.",
      region: context?.region,
      model: context?.model,
      operation: context?.operation
    });
  }

  private async converse(input: {
    client: BedrockRuntimeClientLike;
    request: Record<string, unknown>;
    surface: Surface;
    signal: AbortSignal;
  }) {
    try {
      const output = await input.client.send(new ConverseCommand(input.request as never), { abortSignal: input.signal });
      const body = bedrockResponseForSurface(input.surface, output);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: bedrockResponseHeaders(output, "application/json; charset=utf-8")
      });
    } catch (error) {
      return new Response(JSON.stringify(errorResponseForSurface(input.surface, error)), {
        status: bedrockErrorStatus(error),
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  }

  private async converseStream(input: {
    client: BedrockRuntimeClientLike;
    request: Record<string, unknown>;
    surface: Surface;
    signal: AbortSignal;
  }) {
    try {
      const output = await input.client.send(new ConverseStreamCommand(input.request as never), { abortSignal: input.signal });
      const stream = bedrockStreamOutput(output);
      return new Response(readableStreamFromAsyncIterable(streamForSurface(input.surface, stream)), {
        status: 200,
        headers: bedrockResponseHeaders(output, "text/event-stream; charset=utf-8")
      });
    } catch (error) {
      return new Response(JSON.stringify(errorResponseForSurface(input.surface, error)), {
        status: bedrockErrorStatus(error),
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  }

  private async resolveCredential(
    provider: ProviderRegistryEntry,
    credential: UpstreamCredential | undefined
  ) {
    if (credential?.token) {
      return resolvePlaintextBedrockCredentials({
        plaintext: credential.token,
        accountSettings: credential.providerAccountSettings
      });
    }
    const resolved = await resolveBedrockCredentials({
      accountSettings: credential?.providerAccountSettings,
      providerOrganizationId: provider.builtin ? null : provider.organizationId,
      config: bedrockCredentialResolverConfig(this.config)
    });
    if (!resolved) {
      throw new Error("bedrock_credential_unresolved");
    }
    return resolved;
  }

  private contextForResponse(response: Response | undefined) {
    return response ? this.responseContexts.get(response) : undefined;
  }

  private contextForFetchError(error: unknown) {
    return isObject(error) ? this.fetchErrorContexts.get(error) : undefined;
  }

  private rememberFetchErrorContext(error: unknown, context: BedrockRequestContext) {
    if (isObject(error)) this.fetchErrorContexts.set(error, context);
  }
}

function defaultBedrockRuntimeClientFactory(input: BedrockRuntimeClientFactoryInput) {
  const clientConfig: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
    region: input.region,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.credential.kind === "aws_credentials"
      ? { credentials: input.credential.credentialProvider }
      : { token: { token: input.credential.bearerToken } })
  };
  return new BedrockRuntimeClient(clientConfig);
}

function bedrockRequest(body: unknown, selectedModel: string | undefined, providerSettings: ProviderForwardInput["decision"]["providerSettings"]) {
  const request = structuredClone(isRecord(body) ? body : {});
  const settings = bedrockMetadataSettings(providerSettings);
  if (selectedModel) {
    request.modelId = resolveBedrockConverseModelId({
      modelId: selectedModel,
      inferenceProfile: stringValue(settings?.inferenceProfile) ?? stringValue(settings?.inferenceProfileId),
      inferenceProfileGeography: stringValue(settings?.inferenceProfileGeography) ?? stringValue(settings?.profileGeography)
    });
  }
  delete request.stream;
  return request;
}

function bedrockResponseForSurface(surface: Surface, output: unknown) {
  if (surface === "openai-chat") return bedrockConverseResponseToOpenAIChat(output);
  if (surface === "openai-responses") return bedrockConverseResponseToOpenAIResponses(output);
  return bedrockConverseResponseToAnthropicMessages(output);
}

function streamForSurface(surface: Surface, stream: AsyncIterable<unknown>) {
  if (surface === "openai-chat") return bedrockConverseStreamToOpenAIChatSse(stream);
  if (surface === "openai-responses") return bedrockConverseStreamToOpenAIResponsesSse(stream);
  return bedrockConverseStreamToAnthropicMessagesSse(stream);
}

function errorResponseForSurface(surface: Surface, error: unknown) {
  if (surface === "anthropic-messages") return bedrockConverseErrorToAnthropicMessages(error);
  return bedrockConverseErrorToOpenAI(error);
}

function bedrockStreamOutput(output: unknown) {
  if (!isRecord(output) || !isAsyncIterable(output.stream)) {
    throw new Error("bedrock_stream_missing");
  }
  return output.stream;
}

function readableStreamFromAsyncIterable(iterable: AsyncIterable<Uint8Array>) {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    }
  });
}

function bedrockResponseHeaders(output: unknown, contentType: string) {
  const headers = new Headers({ "content-type": contentType });
  const requestId = bedrockRequestId(output);
  if (requestId) headers.set("x-amzn-requestid", requestId);
  return headers;
}

function bedrockRequestId(output: unknown) {
  if (!isRecord(output) || !isRecord(output.$metadata)) return undefined;
  return typeof output.$metadata.requestId === "string" ? output.$metadata.requestId : undefined;
}

function bedrockRegion(provider: ProviderRegistryEntry, credential: UpstreamCredential | undefined) {
  return stringValue(credential?.providerAccountSettings?.region) ??
    stringValue(provider.adapterConfig.defaultRegion) ??
    "us-east-1";
}

function bedrockEndpoint(provider: ProviderRegistryEntry, credential: UpstreamCredential | undefined) {
  return credential?.baseUrl ??
    stringValue(credential?.providerAccountSettings?.endpointOverride) ??
    (!provider.builtin ? provider.baseUrl : undefined);
}

function assertBedrockEndpoint(endpoint: ProviderRegistryEndpoint): asserts endpoint is Extract<ProviderRegistryEndpoint, { operation: unknown }> {
  if (!("operation" in endpoint) || endpoint.dialect !== "bedrock-converse") {
    throw new Error("Bedrock adapter requires a Bedrock operation endpoint.");
  }
}

function assertOperationEndpoint(provider: ProviderRegistryEntry, operation: "Converse" | "ConverseStream") {
  const found = provider.endpoints.some((endpoint) =>
    "operation" in endpoint &&
    endpoint.dialect === "bedrock-converse" &&
    endpoint.operation === operation
  );
  if (!found) throw new Error(`Bedrock provider does not expose ${operation}.`);
}

function bedrockErrorStatus(error: unknown) {
  if (!isRecord(error)) return 502;
  const statusCode = error.$metadata && isRecord(error.$metadata) && typeof error.$metadata.httpStatusCode === "number"
    ? error.$metadata.httpStatusCode
    : undefined;
  if (statusCode && statusCode >= 400 && statusCode <= 599) return statusCode;
  const name = stringValue(error.name)?.toLowerCase() ?? "";
  if (name.includes("throttl")) return 429;
  if (name.includes("validation")) return 400;
  if (name.includes("access") || name.includes("auth")) return 403;
  return 502;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bedrockMetadataSettings(providerSettings: ProviderForwardInput["decision"]["providerSettings"]) {
  if (!providerSettings) return undefined;
  const metadata = "openai" in providerSettings ? providerSettings.openai.metadata : providerSettings.anthropic.metadata;
  if (!isRecord(metadata)) return undefined;
  const candidate = metadata.bedrockConverse ?? metadata.bedrock ?? metadata.bedrockSettings;
  return isRecord(candidate) ? candidate : undefined;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
