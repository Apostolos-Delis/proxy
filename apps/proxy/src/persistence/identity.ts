import {
  agentSessions,
  organizationSettings,
  organizations,
  users,
  type PromptProxyTransaction
} from "@prompt-proxy/db";

import type { RouteName, Surface } from "../types.js";

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
  userId: string | undefined;
  route?: RouteName;
}) {
  if (!input.sessionId || !input.surface) return undefined;
  const id = sessionRowId(input.organizationId, input.surface, input.sessionId);
  await ensureUser(tx, input.userId);
  await tx
    .insert(agentSessions)
    .values({
      id,
      organizationId: input.organizationId,
      userId: input.userId,
      surface: input.surface,
      externalSessionId: input.sessionId,
      currentRoute: input.route
    })
    .onConflictDoUpdate({
      target: [agentSessions.organizationId, agentSessions.surface, agentSessions.externalSessionId],
      set: {
        userId: input.userId,
        currentRoute: input.route,
        updatedAt: new Date()
      }
    });
  return id;
}

export function sessionRowId(organizationId: string, surface: Surface, sessionId: string) {
  return `${organizationId}:${surface}:${sessionId}`;
}

function organizationSlug(organizationId: string) {
  return organizationId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "local";
}
