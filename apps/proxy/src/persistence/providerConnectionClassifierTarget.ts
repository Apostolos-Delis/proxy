import type { ProxyDbSession } from "@proxy/db";

import {
  ClassifierError,
  type ClassifierTarget,
  type LogicalModelClassifierDeployment,
  type LogicalModelClassifierTargetResolver
} from "../classifier.js";
import {
  loadProviderConnectionTarget,
  materializeProviderConnection,
  ProviderConnectionTargetError,
  type ProviderConnectionTargetOptions
} from "./providerConnectionTarget.js";

export type ProviderConnectionClassifierTargetOptions = ProviderConnectionTargetOptions;

export class ProviderConnectionClassifierTargetResolver implements LogicalModelClassifierTargetResolver {
  constructor(
    private readonly db: ProxyDbSession,
    private readonly options: ProviderConnectionClassifierTargetOptions
  ) {}

  async resolve(deployment: LogicalModelClassifierDeployment, signal?: AbortSignal): Promise<ClassifierTarget> {
    const row = await loadProviderConnectionTarget(this.db, {
      organizationId: deployment.organizationId,
      workspaceId: deployment.workspaceId,
      deploymentId: deployment.deploymentId,
      providerConnectionId: deployment.providerConnectionId,
      upstreamModelId: deployment.model,
      bindingId: deployment.bindingId
    }, signal);
    if (
      !row?.endpointPath ||
      row.apiWireId !== "openai-responses" ||
      row.adapterKind !== "generic-http-json"
    ) {
      throw new ClassifierError("Classifier deployment is unavailable.");
    }

    const endpoint = { dialect: "openai-responses" as const, path: row.endpointPath };
    let connection;
    try {
      connection = await materializeProviderConnection(row, {
        organizationId: deployment.organizationId,
        providerConnectionId: deployment.providerConnectionId,
        endpoints: [endpoint]
      }, this.options, signal);
    } catch (error) {
      if (error instanceof ProviderConnectionTargetError) {
        if (error.code === "provider_secret_encryption_key_unavailable") {
          throw new ClassifierError("Provider secret encryption key is not configured.");
        }
        if (error.code === "provider_connection_credential_unavailable") {
          throw new ClassifierError("Classifier provider credential is not configured.");
        }
      }
      throw error;
    }
    return {
      provider: connection.providerEntry,
      endpoint,
      credential: connection.credential
    };
  }
}
