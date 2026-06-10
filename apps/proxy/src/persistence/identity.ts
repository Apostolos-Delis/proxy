import {
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
  agentSessions,
  apiKeys,
  defaultWorkspaceId,
  hashApiKey,
  organizationSettings,
  organizations,
  users,
  workspaces,
  type PromptProxyDbSession,
  type PromptProxyTransaction
} from "@prompt-proxy/db";
import { eq } from "drizzle-orm";

import type { RouteName, Surface } from "../types.js";

export type ResolvedApiKeyIdentity = {
  apiKeyId: string;
  organizationId: string;
  workspaceId: string;
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
      workspaceId: row.workspaceId,
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

  await tx
    .insert(workspaces)
    .values({
      id: defaultWorkspaceId(organizationId),
      organizationId,
      slug: DEFAULT_WORKSPACE_SLUG,
      name: DEFAULT_WORKSPACE_NAME
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
  workspaceId: string;
  surface: Surface | undefined;
  sessionId: string | undefined;
  requestId?: string;
  userId: string | undefined;
  route?: RouteName;
}) {
  if (!input.surface) return undefined;
  const externalSessionId = input.sessionId ?? (input.requestId ? `request:${input.requestId}` : undefined);
  if (!externalSessionId) return undefined;
  const id = sessionRowId(input.workspaceId, input.surface, externalSessionId);
  const metadata = {
    sessionIdentity: input.sessionId ? "harness" : "request_fallback"
  };
  await ensureUser(tx, input.userId);
  const updateValues: Partial<typeof agentSessions.$inferInsert> = {
    userId: input.userId,
    updatedAt: new Date()
  };
  if (input.route) updateValues.currentRoute = input.route;
  // RETURNING resolves the surviving row id when the upsert hits a session
  // created before the workspace migration (old id format, same unique key).
  const [row] = await tx
    .insert(agentSessions)
    .values({
      id,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      surface: input.surface,
      externalSessionId,
      currentRoute: input.route,
      metadata
    })
    .onConflictDoUpdate({
      target: [
        agentSessions.organizationId,
        agentSessions.workspaceId,
        agentSessions.surface,
        agentSessions.externalSessionId
      ],
      set: updateValues
    })
    .returning();
  return row?.id ?? id;
}

// Workspace ids embed the organization id, so the row id stays globally
// unique while sessions with the same external id stay distinct per workspace.
export function sessionRowId(workspaceId: string, surface: Surface, sessionId: string) {
  return `${workspaceId}:${surface}:${sessionId}`;
}

function organizationSlug(organizationId: string) {
  return organizationId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "local";
}
