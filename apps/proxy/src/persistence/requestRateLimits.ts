import { and, eq, gte, sql } from "drizzle-orm";

import {
  requests,
  type PromptProxyDbSession,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";

import { LimitPolicyResolver } from "./limitPolicies.js";

const REQUEST_RATE_WINDOW_MS = 60_000;

export type RequestRateLimitResult =
  | { status: "disabled" }
  | {
      status: "rejected";
      scope: "workspace" | "api_key";
      reason: "request_rate_limit";
      current: number;
      limit: number;
      resetAt: string;
    };

export class RequestRateLimitStore {
  constructor(private readonly db: PromptProxyTransactionalDatabase) {}

  async check(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string;
    now?: Date;
  }): Promise<RequestRateLimitResult> {
    const now = input.now ?? new Date();
    const windowStart = new Date(now.getTime() - REQUEST_RATE_WINDOW_MS);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`lock table requests in exclusive mode`);
      const policies = await new LimitPolicyResolver(tx).resolve({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        apiKeyId: input.apiKeyId
      });
      const workspaceLimit = policies.workspacePolicy?.requestsPerMinute;
      const apiKeyLimit = policies.apiKeyPolicy?.requestsPerMinute;
      if (workspaceLimit === undefined && apiKeyLimit === undefined) {
        return { status: "disabled" as const };
      }

      if (workspaceLimit !== undefined) {
        const usage = await requestRateUsage(tx, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          windowStart
        });
        if (usage.current > workspaceLimit) {
          return rejected("workspace", usage.current, workspaceLimit, usage.resetAt ?? now);
        }
      }
      if (apiKeyLimit !== undefined && input.apiKeyId) {
        const usage = await requestRateUsage(tx, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          apiKeyId: input.apiKeyId,
          windowStart
        });
        if (usage.current > apiKeyLimit) {
          return rejected("api_key", usage.current, apiKeyLimit, usage.resetAt ?? now);
        }
      }
      return { status: "disabled" as const };
    });
  }
}

async function requestRateUsage(
  db: PromptProxyDbSession,
  input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string;
    windowStart: Date;
  }
) {
  const [row] = await db
    .select({
      count: sql<number>`count(*)`,
      firstAt: sql<Date | string | null>`min(${requests.createdAt})`
    })
    .from(requests)
    .where(and(
      eq(requests.organizationId, input.organizationId),
      eq(requests.workspaceId, input.workspaceId),
      gte(requests.createdAt, input.windowStart),
      input.apiKeyId ? eq(requests.apiKeyId, input.apiKeyId) : undefined
    ));
  return {
    current: Number(row?.count ?? 0),
    resetAt: row?.firstAt
      ? new Date(new Date(row.firstAt).getTime() + REQUEST_RATE_WINDOW_MS)
      : undefined
  };
}

function rejected(
  scope: "workspace" | "api_key",
  current: number,
  limit: number,
  resetAt: Date
): RequestRateLimitResult {
  return {
    status: "rejected",
    scope,
    reason: "request_rate_limit",
    current,
    limit,
    resetAt: resetAt.toISOString()
  };
}
