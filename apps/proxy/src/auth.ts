import { defaultWorkspaceId } from "@prompt-proxy/db";

import type { AppConfig } from "./config.js";
import type { ApiKeyIdentityStore, ResolvedApiKeyIdentity } from "./persistence/identity.js";
import type { RouteContext } from "./types.js";
import { headerValue, sha256 } from "./util.js";

export type RequestIdentity = {
  organizationId: string;
  workspaceId: string;
  userId?: string;
  apiKeyId?: string;
  scopes: string[];
  routingConfigId: string | null;
  source: "api_key" | "dev_proxy_token";
};

export class ProxyAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly apiKeys?: ApiKeyIdentityStore
  ) {}

  async resolve(headers: Record<string, unknown>): Promise<RequestIdentity> {
    const credential = credentialFrom(headers);
    if (!credential) throw unauthorized();

    if (this.apiKeys) {
      const identity = await this.apiKeys.resolve(credential);
      if (identity) return apiKeyIdentity(identity);
    }

    if (this.config.allowDevProxyTokenFallback && credential === this.config.proxyToken) {
      return {
        organizationId: this.config.defaultOrganizationId,
        workspaceId: defaultWorkspaceId(this.config.defaultOrganizationId),
        scopes: ["proxy"],
        routingConfigId: null,
        source: "dev_proxy_token"
      };
    }

    throw unauthorized();
  }
}

export function scopedIdempotencyKey(organizationId: string, workspaceId: string, idempotencyKey: string) {
  return sha256(`${organizationId}:${workspaceId}:${idempotencyKey}`);
}

export function contextForIdentity(context: RouteContext, identity: RequestIdentity): RouteContext {
  const useHarnessIdentity = identity.source === "dev_proxy_token" || identity.scopes.includes("harness_identity");
  return {
    ...context,
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    userId: identity.userId ?? (useHarnessIdentity ? context.userId : undefined),
    teamId: useHarnessIdentity ? context.teamId : undefined,
    apiKeyId: identity.apiKeyId
  };
}

export function actorForIdentity(identity: RequestIdentity) {
  if (identity.userId) return { type: "user" as const, id: identity.userId };
  if (identity.apiKeyId) return { type: "system" as const, id: identity.apiKeyId };
  return { type: "proxy" as const, id: "prompt-proxy" };
}

export function requestReceivedPayload(
  surface: RouteContext["surface"],
  context: RouteContext,
  rawContext: RouteContext,
  identity: RequestIdentity,
  extra: Record<string, unknown> = {}
) {
  return {
    ...extra,
    surface,
    sessionId: context.sessionId ?? null,
    userId: context.userId ?? null,
    teamId: context.teamId ?? null,
    harnessUserId: rawContext.userId ?? null,
    harnessTeamId: rawContext.teamId ?? null,
    authSource: identity.source,
    apiKeyId: identity.apiKeyId ?? null,
    workspaceId: identity.workspaceId,
    routingConfigId: identity.routingConfigId,
    requestedModel: context.requestedModel,
    inputHash: context.inputHash,
    inputChars: context.inputChars
  };
}

function apiKeyIdentity(identity: ResolvedApiKeyIdentity): RequestIdentity {
  return {
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    userId: identity.userId,
    apiKeyId: identity.apiKeyId,
    scopes: identity.scopes,
    routingConfigId: identity.routingConfigId,
    source: "api_key"
  };
}

function credentialFrom(headers: Record<string, unknown>) {
  const auth = headerValue(headers, "authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  return bearer || headerValue(headers, "x-api-key");
}

function unauthorized() {
  const error = new Error("Unauthorized");
  (error as Error & { statusCode: number }).statusCode = 401;
  return error;
}
