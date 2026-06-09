import {
  agentSessions,
  apiKeys,
  hashApiKey,
  organizationSettings,
  organizations,
  users,
  type PromptProxyDbSession,
  type PromptProxyTransaction
} from "@prompt-proxy/db";
import { eq } from "drizzle-orm";

import type { RouteName, Surface } from "../types.js";

export type ResolvedApiKeyIdentity = {
  apiKeyId: string;
  organizationId: string;
  userId?: string;
  scopes: string[];
  routingConfigId: string | null;
};

export class ApiKeyIdentityStore {
  constructor(private readonly db: PromptProxyDbSession) {}

  async resolve(secret: string, now = new Date()): Promise<ResolvedApiKeyIdentity | undefined> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hashApiKey(secret)))
      .limit(1);

    if (!row) return undefined;
    if (row.revokedAt) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return undefined;

    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(eq(apiKeys.id, row.id));

    return {
      apiKeyId: row.id,
      organizationId: row.organizationId,
      userId: row.userId ?? undefined,
      scopes: row.scopes,
      routingConfigId: row.routingConfigId ?? null
    };
  }
}

export async function ensureOrganization(tx: PromptProxyTransaction, organizationId: string) {
  await tx
    .insert(organizations)
    .values({
      id: organizationId,
      slug: organizationSlug(organizationId),
      name: organizationId
    })
    .onConflictDoNothing();

  await tx
    .insert(organizationSettings)
    .values({
      organizationId
    })
    .onConflictDoNothing();
}

export async function ensureUser(tx: PromptProxyTransaction, userId: string | undefined) {
  if (!userId) return;
  await tx
    .insert(users)
    .values({
      id: userId,
      externalId: userId
    })
    .onConflictDoNothing();
}

export async function ensureSession(tx: PromptProxyTransaction, input: {
  organizationId: string;
  surface: Surface | undefined;
  sessionId: string | undefined;
  requestId?: string;
  userId: string | undefined;
  route?: RouteName;
}) {
  if (!input.surface) return undefined;
  const externalSessionId = input.sessionId ?? (input.requestId ? `request:${input.requestId}` : undefined);
  if (!externalSessionId) return undefined;
  const id = sessionRowId(input.organizationId, input.surface, externalSessionId);
  const metadata = {
    sessionIdentity: input.sessionId ? "harness" : "request_fallback"
  };
  await ensureUser(tx, input.userId);
  const updateValues: Partial<typeof agentSessions.$inferInsert> = {
    userId: input.userId,
    updatedAt: new Date()
  };
  if (input.route) updateValues.currentRoute = input.route;
  await tx
    .insert(agentSessions)
    .values({
      id,
      organizationId: input.organizationId,
      userId: input.userId,
      surface: input.surface,
      externalSessionId,
      currentRoute: input.route,
      metadata
    })
    .onConflictDoUpdate({
      target: [agentSessions.organizationId, agentSessions.surface, agentSessions.externalSessionId],
      set: updateValues
    });
  return id;
}

export function sessionRowId(organizationId: string, surface: Surface, sessionId: string) {
  return `${organizationId}:${surface}:${sessionId}`;
}

function organizationSlug(organizationId: string) {
  return organizationId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "local";
}
