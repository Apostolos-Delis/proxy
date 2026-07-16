import type { ProxyDbSession } from "@proxy/db";

import type { GatewayExecutionTarget } from "../gatewayRuntime.js";
import type { ResolvedModelTarget } from "./modelResolution.js";
import {
  loadProviderConnectionTarget,
  materializeProviderConnection,
  ProviderConnectionTargetError,
  type ProviderConnectionTargetOptions
} from "./providerConnectionTarget.js";
import type { ProviderRegistryEndpoint } from "./providers.js";

export type ProviderConnectionRuntimeTargetOptions = ProviderConnectionTargetOptions;

export class ProviderConnectionRuntimeTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class ProviderConnectionRuntimeTargetResolver {
  constructor(
    private readonly db: ProxyDbSession,
    private readonly options: ProviderConnectionRuntimeTargetOptions
  ) {}

  async resolve(
    organizationId: string,
    workspaceId: string,
    resolution: ResolvedModelTarget,
    signal?: AbortSignal
  ): Promise<GatewayExecutionTarget> {
    const row = await loadProviderConnectionTarget(this.db, {
      organizationId,
      workspaceId,
      deploymentId: resolution.deploymentId,
      providerConnectionId: resolution.providerConnectionId,
      upstreamModelId: resolution.upstreamModelId,
      bindingId: resolution.bindingId
    }, signal);
    if (!row) throw new ProviderConnectionRuntimeTargetError("resolved_target_unavailable");
    if (
      row.apiWireId !== resolution.egressWireId ||
      row.adapterKind !== resolution.providerAdapterKind ||
      row.adapterContractVersion !== resolution.providerAdapterContractVersion ||
      row.endpointPath !== resolution.endpointPath
    ) {
      throw new ProviderConnectionRuntimeTargetError("resolved_target_contract_changed");
    }

    const endpoints = providerEndpoints(row.apiWireId, row.endpointPath);
    let connection;
    try {
      connection = await materializeProviderConnection(row, {
        organizationId,
        providerConnectionId: resolution.providerConnectionId,
        endpoints
      }, this.options, signal);
    } catch (error) {
      if (error instanceof ProviderConnectionTargetError) {
        throw new ProviderConnectionRuntimeTargetError(error.code);
      }
      throw error;
    }
    return {
      resolution,
      provider: row.provider,
      upstreamModelId: resolution.upstreamModelId,
      deploymentId: resolution.deploymentId,
      providerConnectionId: resolution.providerConnectionId,
      requestConfig: row.requestConfig,
      deploymentConfig: row.deploymentConfig,
      capabilities: {
        ...row.canonicalCapabilities,
        ...row.deploymentCapabilities
      },
      timeoutMs: timeoutMs(row.deploymentConfig),
      providerEntry: connection.providerEntry,
      endpoint: endpoints[0]!,
      credential: connection.credential
    };
  }
}

function providerEndpoints(
  wireId: ResolvedModelTarget["egressWireId"],
  endpointPath: string | null
): ProviderRegistryEndpoint[] {
  if (wireId === "bedrock-converse") {
    return [
      { dialect: wireId, operation: "Converse" },
      { dialect: wireId, operation: "ConverseStream" }
    ];
  }
  if (!endpointPath) throw new ProviderConnectionRuntimeTargetError("provider_endpoint_unavailable");
  return [{ dialect: wireId, path: endpointPath }];
}

function timeoutMs(config: Record<string, unknown>) {
  const value = config.timeoutMs ?? config.timeout_ms;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 600_000
    ? value
    : undefined;
}
