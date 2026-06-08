import { eq } from "drizzle-orm";

import { agentSessions, type PromptProxyTransaction } from "@prompt-proxy/db";

import { ensureSession } from "./identity.js";
import { routeValue, stringValue, surfaceValue } from "./values.js";

export async function persistSessionRoute(tx: PromptProxyTransaction, event: {
  tenantId: string;
  createdAt: string;
  sessionId?: string;
  payload: Record<string, unknown>;
}) {
  const payload = event.payload;
  const sessionId = stringValue(payload.sessionId) ?? event.sessionId;
  const surface = surfaceValue(payload.surface) ?? "openai-responses";
  const userId = stringValue(payload.userId);
  const route = routeValue(payload.currentRoute);
  const dbSessionId = await ensureSession(tx, {
    organizationId: event.tenantId,
    surface,
    sessionId,
    userId,
    route
  });
  if (!dbSessionId) return;
  await tx
    .update(agentSessions)
    .set({
      currentRoute: route,
      metadata: payload,
      updatedAt: new Date(event.createdAt)
    })
    .where(eq(agentSessions.id, dbSessionId));
}
