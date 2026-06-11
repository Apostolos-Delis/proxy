import { eq } from "drizzle-orm";

import { agentSessions, type PromptProxyDbSession, type PromptProxyTransaction } from "@prompt-proxy/db";
import { sessionPinnedSettingsSchema } from "@prompt-proxy/schema";

import type { SessionPinLoader } from "../policy.js";
import { ensureSession, sessionRowId } from "./identity.js";
import { recordValue, routeValue, stringValue, surfaceValue } from "./values.js";

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
  const metadata = {
    ...payload,
    sessionIdentity: sessionId ? "harness" : "request_fallback"
  };
  const dbSessionId = await ensureSession(tx, {
    organizationId: event.tenantId,
    surface,
    sessionId,
    userId,
    route
  });
  if (!dbSessionId) return;
  const pinRecord = recordValue(payload.pin);
  const pinSettings = pinRecord ? sessionPinnedSettingsSchema.safeParse(pinRecord.settings) : undefined;
  await tx
    .update(agentSessions)
    .set({
      currentRoute: route,
      metadata,
      // Events without a valid pin (e.g. replays of pre-pin history) leave the
      // stored pin untouched rather than clobbering it.
      ...(pinRecord && pinSettings?.success
        ? {
            pinnedSettings: pinSettings.data,
            routingConfigVersionId: stringValue(pinRecord.routingConfigVersionId) ?? null
          }
        : {}),
      updatedAt: new Date(event.createdAt)
    })
    .where(eq(agentSessions.id, dbSessionId));
}

export function createSessionPinLoader(db: PromptProxyDbSession): SessionPinLoader {
  return async ({ organizationId, surface, sessionId }) => {
    const [row] = await db
      .select({
        currentRoute: agentSessions.currentRoute,
        pinnedSettings: agentSessions.pinnedSettings,
        routingConfigVersionId: agentSessions.routingConfigVersionId,
        requestCount: agentSessions.requestCount
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionRowId(organizationId, surface, sessionId)))
      .limit(1);
    if (!row) return undefined;
    const currentRoute = routeValue(row.currentRoute);
    if (!currentRoute) return undefined;
    const parsed = row.pinnedSettings
      ? sessionPinnedSettingsSchema.safeParse(row.pinnedSettings)
      : undefined;
    return {
      currentRoute,
      requestCount: row.requestCount,
      pin: parsed?.success
        ? {
            settings: parsed.data,
            routingConfigVersionId: row.routingConfigVersionId ?? undefined
          }
        : undefined
    };
  };
}
