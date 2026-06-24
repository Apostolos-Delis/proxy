import type { ProviderHealthClassification } from "@proxy/schema";

import type { AppConfig } from "./config.js";
import { jsonPayload, type EventService } from "./events.js";
import {
  providerEndpointForDialect,
  type ProviderRegistryEndpoint,
  type ProviderRegistryEntry,
  type ProviderRegistryResolver
} from "./persistence/providers.js";
import type { ProviderCredentialStore } from "./persistence/providerCredentials.js";
import { canAuthenticateOrgProvider, providerRequestBody, providerRequestHeaders } from "./proxy.js";
import { classifyProviderTerminalHealth } from "./providerHealth.js";
import type { Dialect, JsonObject, Provider, UpstreamCredential } from "./types.js";
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

export type ProviderHealthProbeInput = {
  organizationId: string;
  workspaceId: string;
  actorUserId: string;
  providerAccountId: string;
  model: string;
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
};

type ProbeRequestResult = {
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  headers: Record<string, string>;
  bodyText?: string;
  error?: string;
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

  const stream = supportsStreaming(endpoint)
    ? await runProbeRequest(dependencies.config, provider, endpoint, credential, model, true)
    : streamNotSupported();
  const status = stream.ok ? "success" : "partial";

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
    status
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
  }
) {
  const classification = result.basic.ok
    ? undefined
    : classifyProbeFailure(result.credential.provider, result.model, result.basic, result.checkedAt);
  const eventClassification = classification ? probeEventClassification(classification) : undefined;
  const stateUpdated = result.status === "success" || shouldUpdateHealthFromProbe(classification);
  const healthStatus = result.status === "success" ? "healthy" : healthStatusForClassification(classification);
  const errorType = result.basic.ok ? streamErrorType(result.stream) : classification?.errorType ?? null;
  const message = result.basic.ok
    ? streamMessage(result.stream)
    : probeFailureMessage(classification, result.basic);
  const dimensions = jsonPayload({
    basicChat: requestDimension(result.basic),
    streaming: streamDimension(result.stream),
    toolCalls: result.toolCalls
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
      statusCode: result.basic.statusCode,
      latencyMs: result.basic.latencyMs,
      checkedAt: result.checkedAt.toISOString(),
      stateUpdated,
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
    statusCode: result.basic.statusCode,
    latencyMs: result.basic.latencyMs,
    checkedAt: result.checkedAt.toISOString(),
    stateUpdated,
    dimensions
  };
}

async function runProbeRequest(
  config: AppConfig,
  provider: ProviderRegistryEntry,
  endpoint: ProviderRegistryEndpoint,
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

function supportsStreaming(endpoint: ProviderRegistryEndpoint) {
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

function elapsedMs(started: number) {
  return Math.max(0, Date.now() - started);
}
