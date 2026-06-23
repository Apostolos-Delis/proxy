import { and, eq, gte, sql } from "drizzle-orm";

import {
  requests,
  type PromptProxyDbSession,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";

import { LimitPolicyResolver } from "./limitPolicies.js";

const TOKEN_RATE_WINDOW_MS = 60_000;

export type TokenRateLimitResult =
  | { status: "disabled" }
  | {
      status: "rejected";
      scope: "workspace" | "api_key";
      reason: "token_rate_limit";
      current: number;
      limit: number;
      resetAt: string;
    };

export class TokenRateLimitStore {
  constructor(private readonly db: PromptProxyTransactionalDatabase) {}

  async check(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string;
    requestId: string;
    estimatedTokens: number;
    now?: Date;
  }): Promise<TokenRateLimitResult> {
    const now = input.now ?? new Date();
    const windowStart = new Date(now.getTime() - TOKEN_RATE_WINDOW_MS);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`lock table requests in exclusive mode`);
      await tx
        .update(requests)
        .set({
          metadata: sql`${requests.metadata} || jsonb_build_object('tokenRateEstimate', ${input.estimatedTokens}::int)`
        })
        .where(eq(requests.id, input.requestId));
      const policies = await new LimitPolicyResolver(tx).resolve({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        apiKeyId: input.apiKeyId
      });
      const workspaceLimit = policies.workspacePolicy?.tokensPerMinute;
      const apiKeyLimit = policies.apiKeyPolicy?.tokensPerMinute;
      if (workspaceLimit === undefined && apiKeyLimit === undefined) {
        return { status: "disabled" as const };
      }

      if (workspaceLimit !== undefined) {
        const usage = await tokenRateUsage(tx, {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          windowStart
        });
        if (usage.current > workspaceLimit) {
          return rejected("workspace", usage.current, workspaceLimit, usage.resetAt ?? now);
        }
      }
      if (apiKeyLimit !== undefined && input.apiKeyId) {
        const usage = await tokenRateUsage(tx, {
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

async function tokenRateUsage(
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
      tokens: sql<number>`coalesce(sum(coalesce((${requests.metadata}->>'tokenRateEstimate')::int, ${requests.estimatedInputTokens}, 0)), 0)`,
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
    current: Number(row?.tokens ?? 0),
    resetAt: row?.firstAt
      ? new Date(new Date(row.firstAt).getTime() + TOKEN_RATE_WINDOW_MS)
      : undefined
  };
}

function rejected(
  scope: "workspace" | "api_key",
  current: number,
  limit: number,
  resetAt: Date
): TokenRateLimitResult {
  return {
    status: "rejected",
    scope,
    reason: "token_rate_limit",
    current,
    limit,
    resetAt: resetAt.toISOString()
  };
}
