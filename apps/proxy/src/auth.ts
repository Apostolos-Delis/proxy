import { defaultWorkspaceId } from "@proxy/db";
import type { GatewayAccessProfileLimits } from "@proxy/schema";

import type { AppConfig } from "./config.js";
import type { ApiKeyIdentityStore, ResolvedApiKeyIdentity } from "./persistence/identity.js";
import type { RouteContext } from "./types.js";
import { headerValue, sha256 } from "./util.js";

export type RequestIdentity = {
  organizationId: string;
  workspaceId: string;
  userId?: string;
  apiKeyId?: string;
  accessProfileId: string | null;
  accessProfileLimits: GatewayAccessProfileLimits;
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
        // Attribute local dev-token traffic to the seeded user so it lands on a
        // real person instead of "Unknown user"; harness identity headers stay
        // available only as raw request context.
        userId: this.config.seedUserId,
        accessProfileId: null,
        accessProfileLimits: {},
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
  return {
    ...context,
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    userId: identity.userId,
    teamId: undefined,
    apiKeyId: identity.apiKeyId
  };
}

export function actorForIdentity(identity: RequestIdentity) {
  if (identity.userId) return { type: "user" as const, id: identity.userId };
  if (identity.apiKeyId) return { type: "system" as const, id: identity.apiKeyId };
  return { type: "proxy" as const, id: "proxy" };
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
    transport: context.transport ?? "http",
    harness: context.harness ?? null,
    harnessProfileId: context.harnessProfileId ?? null,
    sessionId: context.sessionId ?? null,
    userId: context.userId ?? null,
    teamId: context.teamId ?? null,
    harnessUserId: rawContext.userId ?? null,
    harnessTeamId: rawContext.teamId ?? null,
    authSource: identity.source,
    apiKeyId: identity.apiKeyId ?? null,
    workspaceId: identity.workspaceId,
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
    accessProfileId: identity.accessProfileId,
    accessProfileLimits: identity.accessProfileLimits,
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
