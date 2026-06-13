import { and, eq } from "drizzle-orm";

import {
  agentSessions,
  defaultWorkspaceId,
  promptArtifacts,
  type PromptProxyDbSession,
  type PromptProxyTransaction
} from "@prompt-proxy/db";
import { sessionPinnedSettingsSchema } from "@prompt-proxy/schema";

import type { SessionPinLoader } from "../policy.js";
import type { Surface } from "../types.js";
import { createId, roughTokenEstimate, sha256 } from "../util.js";
import { ensureSession, sessionRowId } from "./identity.js";
import { recordValue, routeValue, stringValue, surfaceValue } from "./values.js";

export type PinnedSystemPrompt = { pinned: true; systemPrompt?: string };

export async function persistSessionRoute(tx: PromptProxyTransaction, event: {
  tenantId: string;
  workspaceId?: string;
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
    workspaceId: event.workspaceId ?? defaultWorkspaceId(event.tenantId),
    surface,
    sessionId,
    userId,
    route
  });
  if (!dbSessionId) return;
  const [existing] = await tx
    .select({ metadata: agentSessions.metadata })
    .from(agentSessions)
    .where(eq(agentSessions.id, dbSessionId))
    .limit(1);
  const existingMetadata = recordValue(existing?.metadata);
  const metadata: Record<string, unknown> = {
    ...payload,
    sessionIdentity: sessionId ? "harness" : "request_fallback"
  };
  if (existingMetadata && Object.prototype.hasOwnProperty.call(existingMetadata, "pinnedSystemPromptHash")) {
    metadata.pinnedSystemPromptArtifactId = existingMetadata.pinnedSystemPromptArtifactId;
    metadata.pinnedSystemPromptHash = existingMetadata.pinnedSystemPromptHash;
  }
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
  return async ({ workspaceId, surface, sessionId }) => {
    const [row] = await db
      .select({
        currentRoute: agentSessions.currentRoute,
        pinnedSettings: agentSessions.pinnedSettings,
        routingConfigVersionId: agentSessions.routingConfigVersionId,
        requestCount: agentSessions.requestCount,
        metadata: agentSessions.metadata
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionRowId(workspaceId, surface, sessionId)))
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
      softFloor: recordValue(row.metadata)?.softFloor === true,
      pin: parsed?.success
        ? {
            settings: parsed.data,
            routingConfigVersionId: row.routingConfigVersionId ?? undefined
          }
        : undefined
    };
  };
}

export class SessionSystemPromptStore {
  constructor(private readonly db: PromptProxyDbSession) {}

  async resolve(input: {
    organizationId: string;
    workspaceId: string;
    surface: Surface;
    sessionId?: string;
  }): Promise<PinnedSystemPrompt | undefined> {
    if (!input.sessionId) return undefined;
    const [row] = await this.db
      .select({ metadata: agentSessions.metadata })
      .from(agentSessions)
      .where(and(
        eq(agentSessions.id, sessionRowId(input.workspaceId, input.surface, input.sessionId)),
        eq(agentSessions.organizationId, input.organizationId),
        eq(agentSessions.workspaceId, input.workspaceId)
      ))
      .limit(1);
    const metadata = recordValue(row?.metadata);
    if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "pinnedSystemPromptHash")) return undefined;
    const artifactId = metadata.pinnedSystemPromptArtifactId;
    if (typeof artifactId !== "string") {
      return {
        pinned: true,
        systemPrompt: undefined
      };
    }
    const [artifact] = await this.db
      .select({ rawText: promptArtifacts.rawText })
      .from(promptArtifacts)
      .where(and(
        eq(promptArtifacts.id, artifactId),
        eq(promptArtifacts.organizationId, input.organizationId),
        eq(promptArtifacts.workspaceId, input.workspaceId)
      ))
      .limit(1);
    return {
      pinned: true,
      systemPrompt: artifact?.rawText ?? undefined
    };
  }

  async pin(input: {
    organizationId: string;
    workspaceId: string;
    surface: Surface;
    requestId: string;
    sessionId?: string;
    systemPrompt?: string;
  }) {
    if (!input.sessionId) return;
    const id = sessionRowId(input.workspaceId, input.surface, input.sessionId);
    const [row] = await this.db
      .select({ metadata: agentSessions.metadata })
      .from(agentSessions)
      .where(and(
        eq(agentSessions.id, id),
        eq(agentSessions.organizationId, input.organizationId),
        eq(agentSessions.workspaceId, input.workspaceId)
      ))
      .limit(1);
    if (!row) return;
    const metadata = recordValue(row.metadata) ?? {};
    if (Object.prototype.hasOwnProperty.call(metadata, "pinnedSystemPromptHash")) return;
    const systemPrompt = input.systemPrompt?.trim() ? input.systemPrompt : undefined;
    const artifactId = systemPrompt ? createId("prompt_artifact") : undefined;
    if (systemPrompt && artifactId) {
      await this.db.insert(promptArtifacts).values({
        id: artifactId,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        kind: "organization_system_prompt",
        storageMode: "raw_text",
        contentHash: sha256(systemPrompt),
        rawText: systemPrompt,
        tokenEstimate: roughTokenEstimate(systemPrompt.length),
        sourceRole: "system",
        metadata: {
          surface: input.surface,
          chars: systemPrompt.length,
          source: "session_system_prompt_pin"
        }
      });
    }
    await this.db
      .update(agentSessions)
      .set({
        metadata: {
          ...metadata,
          pinnedSystemPromptArtifactId: artifactId ?? null,
          pinnedSystemPromptHash: sha256(systemPrompt ?? "")
        },
        updatedAt: new Date()
      })
      .where(and(
        eq(agentSessions.id, id),
        eq(agentSessions.organizationId, input.organizationId),
        eq(agentSessions.workspaceId, input.workspaceId)
      ));
  }
}
