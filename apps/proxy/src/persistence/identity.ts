import {
  DEFAULT_WORKSPACE_NAME,
  DEFAULT_WORKSPACE_SLUG,
  accessProfiles,
  agentSessions,
  apiKeys,
  defaultWorkspaceId,
  hashApiKey,
  organizationSettings,
  organizations,
  users,
  workspaces,
  type ProxyDbSession,
  type ProxyTransaction
} from "@proxy/db";
import type { GatewayAccessProfileLimits } from "@proxy/schema";
import { and, eq } from "drizzle-orm";

type ApiKeyIdentityStoreOptions = {
  cacheTtlMs?: number;
  lastUsedFlushDelayMs?: number;
};

type CachedApiKeyIdentity = {
  identity?: ResolvedApiKeyIdentity;
  expiresAtMs: number;
};

const defaultCacheTtlMs = 5_000;
const defaultLastUsedFlushDelayMs = 1_000;

export type ResolvedApiKeyIdentity = {
  apiKeyId: string;
  organizationId: string;
  workspaceId: string;
  userId?: string;
  accessProfileId: string | null;
  accessProfileLimits: GatewayAccessProfileLimits;
};

export class ApiKeyIdentityStore {
  private readonly cache = new Map<string, CachedApiKeyIdentity>();
  private readonly pendingLastUsed = new Map<string, Date>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly db: ProxyDbSession,
    private readonly options: ApiKeyIdentityStoreOptions = {}
  ) {}

  async resolve(secret: string, now = new Date()): Promise<ResolvedApiKeyIdentity | undefined> {
    const keyHash = hashApiKey(secret);
    const nowMs = now.getTime();
    const cached = this.cache.get(keyHash);
    if (cached && cached.expiresAtMs > nowMs) {
      if (cached.identity) this.recordLastUsed(cached.identity.apiKeyId, now);
      return cached.identity ? cloneIdentity(cached.identity) : undefined;
    }

    const [row] = await this.db
      .select({
        id: apiKeys.id,
        organizationId: apiKeys.organizationId,
        workspaceId: apiKeys.workspaceId,
        userId: apiKeys.userId,
        accessProfileId: apiKeys.accessProfileId,
        accessProfileStatus: accessProfiles.status,
        accessProfileLimits: accessProfiles.limits,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt
      })
      .from(apiKeys)
      .leftJoin(accessProfiles, and(
        eq(accessProfiles.organizationId, apiKeys.organizationId),
        eq(accessProfiles.workspaceId, apiKeys.workspaceId),
        eq(accessProfiles.id, apiKeys.accessProfileId)
      ))
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    if (!row) {
      this.cache.set(keyHash, { expiresAtMs: nowMs + this.cacheTtlMs() });
      return undefined;
    }
    if (row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= nowMs)) {
      this.cache.set(keyHash, { expiresAtMs: nowMs + this.cacheTtlMs() });
      return undefined;
    }

    const identity = {
      apiKeyId: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      userId: row.userId ?? undefined,
      accessProfileId: row.accessProfileId ?? null,
      accessProfileLimits: row.accessProfileStatus === "active"
        ? row.accessProfileLimits ?? {}
        : {}
    };
    this.cache.set(keyHash, { identity, expiresAtMs: nowMs + this.cacheTtlMs() });
    this.recordLastUsed(row.id, now);
    return cloneIdentity(identity);
  }

  clearCache() {
    this.cache.clear();
  }

  async flushLastUsed() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const pending = [...this.pendingLastUsed.entries()];
    this.pendingLastUsed.clear();
    let failed = false;
    for (const [apiKeyId, lastUsedAt] of pending) {
      try {
        await this.db
          .update(apiKeys)
          .set({ lastUsedAt })
          .where(eq(apiKeys.id, apiKeyId));
      } catch {
        failed = true;
        const current = this.pendingLastUsed.get(apiKeyId);
        if (!current || current.getTime() < lastUsedAt.getTime()) {
          this.pendingLastUsed.set(apiKeyId, lastUsedAt);
        }
      }
    }
    if (this.pendingLastUsed.size > 0) this.scheduleFlush();
    if (failed) throw new Error("Failed to flush API key last_used_at updates.");
  }

  private recordLastUsed(apiKeyId: string, lastUsedAt: Date) {
    const pending = this.pendingLastUsed.get(apiKeyId);
    if (!pending || pending.getTime() < lastUsedAt.getTime()) {
      this.pendingLastUsed.set(apiKeyId, lastUsedAt);
    }
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushLastUsed().catch(() => undefined);
    }, this.lastUsedFlushDelayMs());
    this.flushTimer.unref?.();
  }

  private cacheTtlMs() {
    return this.options.cacheTtlMs ?? defaultCacheTtlMs;
  }

  private lastUsedFlushDelayMs() {
    return this.options.lastUsedFlushDelayMs ?? defaultLastUsedFlushDelayMs;
  }
}

function cloneIdentity(identity: ResolvedApiKeyIdentity): ResolvedApiKeyIdentity {
  return { ...identity, accessProfileLimits: { ...identity.accessProfileLimits } };
}

export async function ensureOrganization(tx: ProxyTransaction, organizationId: string) {
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

export async function ensureUser(tx: ProxyTransaction, userId: string | undefined) {
  if (!userId) return;
  await tx
    .insert(users)
    .values({
      id: userId,
      externalId: userId
    })
    .onConflictDoNothing();
}

export async function ensureSession(tx: ProxyTransaction, input: {
  organizationId: string;
  workspaceId: string;
  surface: string | undefined;
  sessionId: string | undefined;
  requestId?: string;
  userId: string | undefined;
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
export function sessionRowId(workspaceId: string, surface: string, sessionId: string) {
  return `${workspaceId}:${surface}:${sessionId}`;
}

function organizationSlug(organizationId: string) {
  return organizationId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "local";
}
