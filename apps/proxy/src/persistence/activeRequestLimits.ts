import { and, eq, lte, sql } from "drizzle-orm";

import {
  activeRequestLimits,
  type PromptProxyDbSession,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";

import { createId } from "../util.js";
import { LimitPolicyResolver } from "./limitPolicies.js";

const ACTIVE_REQUEST_LIMIT_TTL_MS = 6 * 60 * 60 * 1000;

export type ActiveRequestLimitReservation =
  | { status: "disabled" }
  | {
      status: "rejected";
      scope: "workspace" | "api_key";
      reason: "parallel_request_limit";
      current: number;
      limit: number;
      resetAt: string;
    }
  | {
      status: "reserved";
      id: string;
      expiresAt: Date;
      release: () => Promise<void>;
    };

export class ActiveRequestLimitStore {
  constructor(
    private readonly db: PromptProxyTransactionalDatabase,
    private readonly readDb: PromptProxyDbSession
  ) {}

  async reserve(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string;
    requestId: string;
    now?: Date;
  }): Promise<ActiveRequestLimitReservation> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + ACTIVE_REQUEST_LIMIT_TTL_MS);
    const reserved = await this.db.transaction(async (tx) => {
      await tx.execute(sql`lock table active_request_limits in exclusive mode`);
      await tx
        .delete(activeRequestLimits)
        .where(lte(activeRequestLimits.expiresAt, now));

      const policies = await new LimitPolicyResolver(tx).resolve({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        apiKeyId: input.apiKeyId
      });
      const workspaceLimit = policies.workspacePolicy?.parallelRequests;
      const apiKeyLimit = policies.apiKeyPolicy?.parallelRequests;
      if (workspaceLimit === undefined && apiKeyLimit === undefined) {
        return { status: "disabled" as const };
      }

      if (workspaceLimit !== undefined) {
        const usage = await activeRequestUsage(tx, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId
        });
        if (usage.current >= workspaceLimit) {
          return rejected("workspace", usage.current, workspaceLimit, usage.resetAt ?? expiresAt);
        }
      }
      if (apiKeyLimit !== undefined) {
        const usage = await activeRequestUsage(tx, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          apiKeyId: input.apiKeyId
        });
        if (usage.current >= apiKeyLimit) {
          return rejected("api_key", usage.current, apiKeyLimit, usage.resetAt ?? expiresAt);
        }
      }

      const id = createId("active_request_limit");
      await tx.insert(activeRequestLimits).values({
        id,
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
        requestId: input.requestId,
        startedAt: now,
        expiresAt
      });
      return { status: "reserved" as const, id, expiresAt };
    });

    if (reserved.status !== "reserved") return reserved;
    return {
      ...reserved,
      release: () => this.release(reserved.id)
    };
  }

  async release(id: string) {
    await this.readDb
      .delete(activeRequestLimits)
      .where(eq(activeRequestLimits.id, id));
  }
}

async function activeRequestUsage(
  db: PromptProxyDbSession,
  input: { organizationId: string; workspaceId: string; apiKeyId?: string }
) {
  const [row] = await db
    .select({
      count: sql<number>`count(*)`,
      resetAt: sql<Date | string | null>`min(${activeRequestLimits.expiresAt})`
    })
    .from(activeRequestLimits)
    .where(and(
      eq(activeRequestLimits.organizationId, input.organizationId),
      eq(activeRequestLimits.workspaceId, input.workspaceId),
      input.apiKeyId ? eq(activeRequestLimits.apiKeyId, input.apiKeyId) : undefined
    ));
  return {
    current: Number(row?.count ?? 0),
    resetAt: row?.resetAt ? new Date(row.resetAt) : undefined
  };
}

function rejected(
  scope: "workspace" | "api_key",
  current: number,
  limit: number,
  expiresAt: Date
): ActiveRequestLimitReservation {
  return {
    status: "rejected",
    scope,
    reason: "parallel_request_limit",
    current,
    limit,
    resetAt: expiresAt.toISOString()
  };
}
