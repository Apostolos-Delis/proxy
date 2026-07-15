import { and, eq } from "drizzle-orm";

import {
  canonicalModels,
  decryptSecret,
  deploymentWireBindings,
  modelDeployments,
  providerConnections,
  type ProxyDbSession
} from "@proxy/db";
import { providerCapabilitiesWithDefaults } from "@proxy/schema";

import {
  ClassifierError,
  type ClassifierTarget,
  type LogicalModelClassifierDeployment,
  type LogicalModelClassifierTargetResolver
} from "../classifier.js";
import {
  assertSafeDefaultHeaders,
  trimProviderBaseUrl,
  validateProviderBaseUrl,
  type ProviderNetworkPolicy
} from "./providers.js";
import { workspaceScope } from "./scope.js";

export type ProviderConnectionClassifierTargetOptions = {
  allowedPrivateUpstreamCidrs: ProviderNetworkPolicy["allowedPrivateUpstreamCidrs"];
  encryptionKey?: string;
  resolveSecretReference?: (input: {
    reference: string;
    provider: string;
    baseUrl: string;
    signal?: AbortSignal;
  }) => string | undefined | Promise<string | undefined>;
};

export class ProviderConnectionClassifierTargetResolver implements LogicalModelClassifierTargetResolver {
  constructor(
    private readonly db: ProxyDbSession,
    private readonly options: ProviderConnectionClassifierTargetOptions
  ) {}

  async resolve(deployment: LogicalModelClassifierDeployment, signal?: AbortSignal): Promise<ClassifierTarget> {
    signal?.throwIfAborted();
    const [row] = await this.db
      .select({
        provider: providerConnections.slug,
        baseUrl: providerConnections.baseUrl,
        adapterKind: providerConnections.adapterKind,
        adapterConfig: providerConnections.adapterConfig,
        authStyle: providerConnections.authStyle,
        secretRef: providerConnections.secretRef,
        secretCiphertext: providerConnections.secretCiphertext,
        defaultHeaders: providerConnections.defaultHeaders,
        endpointPath: deploymentWireBindings.endpointPath
      })
      .from(modelDeployments)
      .innerJoin(canonicalModels, and(
        eq(canonicalModels.organizationId, modelDeployments.organizationId),
        eq(canonicalModels.workspaceId, modelDeployments.workspaceId),
        eq(canonicalModels.id, modelDeployments.canonicalModelId)
      ))
      .innerJoin(providerConnections, and(
        eq(providerConnections.organizationId, modelDeployments.organizationId),
        eq(providerConnections.workspaceId, modelDeployments.workspaceId),
        eq(providerConnections.id, modelDeployments.providerConnectionId)
      ))
      .innerJoin(deploymentWireBindings, and(
        eq(deploymentWireBindings.organizationId, modelDeployments.organizationId),
        eq(deploymentWireBindings.workspaceId, modelDeployments.workspaceId),
        eq(deploymentWireBindings.deploymentId, modelDeployments.id),
        eq(deploymentWireBindings.providerConnectionId, providerConnections.id)
      ))
      .where(and(
        workspaceScope(modelDeployments, deployment.organizationId, deployment.workspaceId),
        workspaceScope(canonicalModels, deployment.organizationId, deployment.workspaceId),
        workspaceScope(providerConnections, deployment.organizationId, deployment.workspaceId),
        workspaceScope(deploymentWireBindings, deployment.organizationId, deployment.workspaceId),
        eq(modelDeployments.id, deployment.deploymentId),
        eq(modelDeployments.providerConnectionId, deployment.providerConnectionId),
        eq(modelDeployments.upstreamModelId, deployment.model),
        eq(deploymentWireBindings.id, deployment.bindingId),
        eq(deploymentWireBindings.apiWireId, "openai-responses"),
        eq(modelDeployments.status, "active"),
        eq(canonicalModels.status, "active"),
        eq(providerConnections.status, "active"),
        eq(deploymentWireBindings.enabled, true)
      ))
      .limit(1);
    signal?.throwIfAborted();
    if (!row?.endpointPath || row.adapterKind !== "generic-http-json") {
      throw new ClassifierError("Classifier deployment is unavailable.");
    }

    assertSafeDefaultHeaders(row.defaultHeaders);
    const baseUrl = trimProviderBaseUrl(row.baseUrl);
    const pinnedAddress = await validateProviderBaseUrl(baseUrl, this.options);
    signal?.throwIfAborted();
    const token = row.authStyle === "none"
      ? undefined
      : await this.token(row.provider, baseUrl, row.secretRef, row.secretCiphertext, signal);
    signal?.throwIfAborted();
    if (row.authStyle !== "none" && !token) {
      throw new ClassifierError("Classifier provider credential is not configured.");
    }
    const endpoint = { dialect: "openai-responses" as const, path: row.endpointPath };
    return {
      provider: {
        id: deployment.providerConnectionId,
        organizationId: deployment.organizationId,
        slug: row.provider,
        baseUrl,
        adapterKind: row.adapterKind,
        adapterConfig: row.adapterConfig,
        authStyle: row.authStyle,
        endpoints: [endpoint],
        defaultHeaders: row.defaultHeaders,
        capabilities: providerCapabilitiesWithDefaults(row.provider),
        forwardHarnessHeaders: false,
        enabled: true,
        builtin: false,
        pinnedAddress
      },
      endpoint,
      credential: token ? {
        provider: row.provider,
        token,
        providerAccountId: deployment.providerConnectionId,
        authType: "api_key",
        baseUrl,
        pinnedAddress
      } : undefined
    };
  }

  private async token(
    provider: string,
    baseUrl: string,
    secretRef: string | null,
    secretCiphertext: string | null,
    signal?: AbortSignal
  ) {
    if (secretCiphertext) {
      if (!this.options.encryptionKey) throw new ClassifierError("Provider secret encryption key is not configured.");
      return decryptSecret(secretCiphertext, this.options.encryptionKey);
    }
    if (!secretRef || !this.options.resolveSecretReference) return undefined;
    return this.options.resolveSecretReference({ reference: secretRef, provider, baseUrl, signal });
  }
}
