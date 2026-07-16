import { and, eq } from "drizzle-orm";

import {
  agentSessions,
  promptArtifacts,
  type ProxyDbSession
} from "@proxy/db";

import type { Surface } from "../types.js";
import { createId, roughTokenEstimate, sha256 } from "../util.js";
import { sessionRowId } from "./identity.js";
import { recordValue } from "./values.js";

export type PinnedSystemPrompt = { pinned: true; systemPrompt?: string };

export class SessionSystemPromptStore {
  constructor(private readonly db: ProxyDbSession) {}

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
    if (typeof artifactId !== "string") return { pinned: true };
    const [artifact] = await this.db
      .select({ rawText: promptArtifacts.rawText })
      .from(promptArtifacts)
      .where(and(
        eq(promptArtifacts.id, artifactId),
        eq(promptArtifacts.organizationId, input.organizationId),
        eq(promptArtifacts.workspaceId, input.workspaceId)
      ))
      .limit(1);
    return { pinned: true, systemPrompt: artifact?.rawText ?? undefined };
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
