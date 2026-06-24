import { and, desc, eq, gte, sql } from "drizzle-orm";

import {
  requests,
  usageLedger,
  type ProxyDbSession
} from "@proxy/db";

import { CACHE_TTL_DEFAULT_MS } from "./cacheWindows.js";
import { sessionRowId } from "./persistence/identity.js";
import type { Surface } from "./types.js";
import { isRecord } from "./util.js";

export type CompressionCacheWindowSource = "provider_usage" | "none";

export type CompressionCacheWindow = {
  source: CompressionCacheWindowSource;
  frozenPrefixItems: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  inputTokens: number;
  evidenceRequestId: string | null;
  evidenceCreatedAt: string | null;
};

type ResolveCompressionCacheWindowInput = {
  organizationId: string;
  workspaceId: string;
  sessionId?: string;
  surface: Surface;
  provider: string;
  model: string;
  body: unknown;
  now?: Date;
};

export class CompressionCacheWindowResolver {
  constructor(private readonly db: ProxyDbSession) {}

  async resolve(input: ResolveCompressionCacheWindowInput): Promise<CompressionCacheWindow> {
    const empty = noCompressionCacheWindow();
    if (!input.sessionId) return empty;

    const now = input.now ?? new Date();
    const sessionId = sessionRowId(input.workspaceId, input.surface, input.sessionId);
    const [row] = await this.db
      .select({
        requestId: usageLedger.requestId,
        inputTokens: usageLedger.inputTokens,
        cachedInputTokens: usageLedger.cachedInputTokens,
        cacheCreationInputTokens: usageLedger.cacheCreationInputTokens,
        createdAt: usageLedger.createdAt
      })
      .from(usageLedger)
      .innerJoin(requests, and(
        eq(requests.organizationId, usageLedger.organizationId),
        eq(requests.workspaceId, usageLedger.workspaceId),
        eq(requests.id, usageLedger.requestId)
      ))
      .where(and(
        eq(usageLedger.organizationId, input.organizationId),
        eq(usageLedger.workspaceId, input.workspaceId),
        eq(usageLedger.kind, "provider"),
        eq(usageLedger.sessionId, sessionId),
        eq(usageLedger.provider, input.provider),
        eq(usageLedger.model, input.model),
        eq(requests.surface, input.surface),
        gte(usageLedger.createdAt, new Date(now.getTime() - CACHE_TTL_DEFAULT_MS)),
        sql`${usageLedger.cachedInputTokens} + ${usageLedger.cacheCreationInputTokens} > 0`
      ))
      .orderBy(desc(usageLedger.createdAt))
      .limit(1);

    if (!row) return empty;
    return {
      source: "provider_usage",
      frozenPrefixItems: frozenPrefixItemsForSurface(input.surface, input.body),
      cachedInputTokens: row.cachedInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      inputTokens: row.inputTokens,
      evidenceRequestId: row.requestId,
      evidenceCreatedAt: row.createdAt.toISOString()
    };
  }
}

export function noCompressionCacheWindow(): CompressionCacheWindow {
  return {
    source: "none",
    frozenPrefixItems: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    inputTokens: 0,
    evidenceRequestId: null,
    evidenceCreatedAt: null
  };
}

export function compressionCacheWindowEventPayload(window: CompressionCacheWindow) {
  return {
    source: window.source,
    frozenPrefixItems: window.frozenPrefixItems,
    cachedInputTokens: window.cachedInputTokens,
    cacheCreationInputTokens: window.cacheCreationInputTokens,
    inputTokens: window.inputTokens,
    evidenceRequestId: window.evidenceRequestId,
    evidenceCreatedAt: window.evidenceCreatedAt
  };
}

function frozenPrefixItemsForSurface(surface: Surface, body: unknown) {
  if (!isRecord(body)) return 0;
  if (surface === "openai-responses" && Array.isArray(body.input)) return Math.max(0, body.input.length - 1);
  if ((surface === "anthropic-messages" || surface === "openai-chat") && Array.isArray(body.messages)) {
    return Math.max(0, body.messages.length - 1);
  }
  return 0;
}
