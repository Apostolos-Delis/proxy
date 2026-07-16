import type {
  Dialect,
  GatewayModelCapabilities,
  GatewayOperationId,
  HarnessCompatibilityProfileId
} from "@proxy/schema";

import type { RequestIdentity } from "./auth.js";
import type {
  ModelResolutionDenial,
  ModelResolutionDenialCode,
  ModelResolutionService,
  ResolvedModelTarget
} from "./persistence/modelResolution.js";
import type { ProviderConnectionRuntimeTargetResolver } from "./persistence/providerConnectionRuntimeTarget.js";
import type {
  ProviderRegistryEndpoint,
  ProviderRegistryEntry
} from "./persistence/providers.js";
import { translators } from "./translators/index.js";
import type {
  RouteContext,
  RouteDecision,
  Surface,
  UpstreamCredential
} from "./types.js";
import { isRecord } from "./util.js";
import {
  applyGatewayParameterDefaults,
  applyRequestConfig,
  bedrockDeploymentModelId,
  deploymentRequestConfig,
  gatewayParameters
} from "./gatewayRequestConfig.js";

export type GatewayExecutionTarget = {
  resolution: ResolvedModelTarget;
  provider: string;
  upstreamModelId: string;
  deploymentId: string;
  providerConnectionId: string;
  requestConfig: Record<string, unknown>;
  deploymentConfig: Record<string, unknown>;
  capabilities: GatewayModelCapabilities;
  timeoutMs?: number;
  providerEntry: ProviderRegistryEntry;
  endpoint: ProviderRegistryEndpoint;
  credential?: UpstreamCredential;
};

export type GatewayRuntimeResolution =
  ResolvedModelTarget | ModelResolutionDenial;

export function gatewayDenialStatus(code: ModelResolutionDenialCode) {
  if (code === "api_key_not_found" || code === "api_key_inactive") return 401;
  if (
    code === "access_profile_missing" ||
    code === "access_profile_inactive" ||
    code === "model_access_denied" ||
    code === "operation_not_allowed"
  ) return 403;
  if (
    code === "invalid_parameters" ||
    code === "parameter_cap_exceeded" ||
    code === "classification_context_invalid" ||
    code === "model_unavailable"
  ) return 400;
  if (code === "classifier_failed" || code === "classifier_unavailable") return 502;
  return 503;
}

export class GatewayRuntime {
  constructor(
    private readonly models: ModelResolutionService,
    private readonly targets: ProviderConnectionRuntimeTargetResolver
  ) {}

  async resolve(input: {
    identity: RequestIdentity;
    context: RouteContext;
    ingressWireId: Dialect;
    operationId: GatewayOperationId;
    body: unknown;
    transport?: "http" | "websocket";
  }): Promise<GatewayRuntimeResolution> {
    if (!input.identity.apiKeyId) {
      return {
        outcome: "denied",
        code: "api_key_not_found",
        requestedModel: input.context.requestedModel,
        operationId: input.operationId
      };
    }
    return this.models.resolve({
      organizationId: input.identity.organizationId,
      workspaceId: input.identity.workspaceId,
      apiKeyId: input.identity.apiKeyId,
      ingressWireId: input.ingressWireId,
      operationId: input.operationId,
      requestedModel: input.context.requestedModel,
      parameters: gatewayParameters(input.body),
      harnessProfileId: input.context.harnessProfileId as HarnessCompatibilityProfileId | undefined,
      transport: input.transport ?? input.context.transport,
      statefulResponses: input.context.statefulResponses,
      hasPreviousResponseId: input.context.hasPreviousResponseId,
      unsupportedFields: input.context.unsupportedFields,
      isStreaming: input.context.isStreaming,
      classificationFeatures: {
        estimatedInputTokens: input.context.estimatedInputTokens,
        inputChars: input.context.inputChars,
        hasTools: input.context.hasTools,
        toolCount: input.context.toolCount,
        hasImages: input.context.hasImages,
        hasPreviousResponseId: input.context.hasPreviousResponseId,
        extractedHints: input.context.extractedHints
      }
    });
  }

  materialize(identity: RequestIdentity, resolution: ResolvedModelTarget) {
    return this.targets.resolve(
      identity.organizationId,
      identity.workspaceId,
      resolution
    );
  }

  async listModels(identity: RequestIdentity) {
    if (!identity.apiKeyId) return [];
    return this.models.listGrantedModels({
      organizationId: identity.organizationId,
      workspaceId: identity.workspaceId,
      apiKeyId: identity.apiKeyId
    });
  }
}

export function gatewayRequestBody(input: {
  body: unknown;
  ingressWireId: Dialect;
  operationId: GatewayOperationId;
  target: GatewayExecutionTarget;
}) {
  const resolution = input.target.resolution;
  const contract = translators.adapterContract(input.ingressWireId, resolution.egressWireId);
  if (contract === undefined) throw new Error("wire_adapter_unavailable");
  if (
    (contract?.id ?? null) !== resolution.wireAdapterId ||
    (contract?.version ?? null) !== resolution.wireAdapterVersion
  ) {
    throw new Error("wire_adapter_contract_changed");
  }
  if (input.operationId === "text.count_tokens" && input.ingressWireId !== resolution.egressWireId) {
    throw new Error("token_count_translation_unavailable");
  }

  const translator = translators.get(input.ingressWireId, resolution.egressWireId);
  const translated = translator ? translator.request(input.body) : input.body;
  const request = structuredClone(isRecord(translated) ? translated : {});
  const stream = request.stream;
  const eventType = request.type;
  applyRequestConfig(
    request,
    deploymentRequestConfig(resolution.egressWireId, input.target.deploymentConfig)
  );
  applyRequestConfig(request, input.target.requestConfig);
  restoreProtectedField(request, "stream", stream);
  restoreProtectedField(request, "type", eventType);
  if (resolution.egressWireId === "bedrock-converse") {
    request.modelId = bedrockDeploymentModelId(
      input.target.upstreamModelId,
      input.target.deploymentConfig
    );
  } else {
    request.model = input.target.upstreamModelId;
  }
  applyGatewayParameterDefaults(request, input.operationId, resolution.egressWireId);
  if (resolution.egressWireId === "openai-responses" && request.store === undefined) {
    request.store = false;
  }
  if (resolution.egressWireId === "openai-chat" && request.stream === true) {
    const streamOptions = isRecord(request.stream_options) ? request.stream_options : {};
    if (streamOptions.include_usage === undefined) {
      request.stream_options = { ...streamOptions, include_usage: true };
    }
  }
  return request;
}

export function gatewayRouteDecision(surface: Surface, target: GatewayExecutionTarget): RouteDecision {
  return {
    outcome: "route",
    surface,
    requestedModel: target.resolution.logicalModelSlug,
    selectedModel: target.upstreamModelId,
    provider: target.provider,
    guardrailActions: [],
    reasonCodes: target.resolution.routerDecision?.reasonCodes ?? [],
    policyVersion: "gateway-v1",
    selectedAdapterKind: target.resolution.providerAdapterKind
  };
}

function restoreProtectedField(request: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined) delete request[key];
  else request[key] = value;
}
