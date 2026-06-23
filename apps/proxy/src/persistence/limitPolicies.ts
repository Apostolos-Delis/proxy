import { and, eq } from "drizzle-orm";

import {
  apiKeyLimitPolicies,
  workspaceLimitPolicies,
  type PromptProxyDbSession
} from "@prompt-proxy/db";
import {
  apiKeyLimitPolicySchema,
  workspaceLimitPolicySchema,
  type ApiKeyLimitPolicy,
  type LimitBudgetPolicy,
  type LimitPolicy,
  type WorkspaceLimitPolicy
} from "@prompt-proxy/schema";

export type ResolvedLimitPolicy = {
  organizationId: string;
  workspaceId: string;
  apiKeyId?: string;
  workspacePolicy?: WorkspaceLimitPolicy;
  apiKeyPolicy?: ApiKeyLimitPolicy;
  effectivePolicy?: LimitPolicy;
};

export class LimitPolicyResolutionError extends Error {
  statusCode = 500;
}

export class LimitPolicyResolver {
  constructor(private readonly db: PromptProxyDbSession) {}

  async resolve(input: {
    organizationId: string;
    workspaceId: string;
    apiKeyId?: string;
  }): Promise<ResolvedLimitPolicy> {
    const [workspaceRow, apiKeyRow] = await Promise.all([
      this.workspacePolicy(input.organizationId, input.workspaceId),
      input.apiKeyId ? this.apiKeyPolicy(input.organizationId, input.workspaceId, input.apiKeyId) : undefined
    ]);
    const workspacePolicy = workspaceRow ? parseWorkspacePolicy(workspaceRow.policy) : undefined;
    const apiKeyPolicy = apiKeyRow ? parseApiKeyPolicy(apiKeyRow.policy) : undefined;

    return {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      apiKeyId: input.apiKeyId,
      workspacePolicy,
      apiKeyPolicy,
      effectivePolicy: effectiveLimitPolicy(workspacePolicy, apiKeyPolicy)
    };
  }

  private async workspacePolicy(organizationId: string, workspaceId: string) {
    const [row] = await this.db
      .select({ policy: workspaceLimitPolicies.policy })
      .from(workspaceLimitPolicies)
      .where(and(
        eq(workspaceLimitPolicies.organizationId, organizationId),
        eq(workspaceLimitPolicies.workspaceId, workspaceId)
      ))
      .limit(1);
    return row;
  }

  private async apiKeyPolicy(organizationId: string, workspaceId: string, apiKeyId: string) {
    const [row] = await this.db
      .select({ policy: apiKeyLimitPolicies.policy })
      .from(apiKeyLimitPolicies)
      .where(and(
        eq(apiKeyLimitPolicies.organizationId, organizationId),
        eq(apiKeyLimitPolicies.workspaceId, workspaceId),
        eq(apiKeyLimitPolicies.apiKeyId, apiKeyId)
      ))
      .limit(1);
    return row;
  }
}

export function effectiveLimitPolicy(
  workspacePolicy: WorkspaceLimitPolicy | undefined,
  apiKeyPolicy: ApiKeyLimitPolicy | undefined
): LimitPolicy | undefined {
  const budget = effectiveBudgetPolicy(workspacePolicy?.budget, apiKeyPolicy?.budget);
  const policy: LimitPolicy = {
    ...optionalNumber("requestsPerMinute", stricterNumber(
      workspacePolicy?.requestsPerMinute,
      apiKeyPolicy?.requestsPerMinute
    )),
    ...optionalNumber("tokensPerMinute", stricterNumber(
      workspacePolicy?.tokensPerMinute,
      apiKeyPolicy?.tokensPerMinute
    )),
    ...optionalNumber("parallelRequests", stricterNumber(
      workspacePolicy?.parallelRequests,
      apiKeyPolicy?.parallelRequests
    )),
    ...(budget ? { budget } : {})
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function effectiveBudgetPolicy(
  workspaceBudget: LimitBudgetPolicy | undefined,
  apiKeyBudget: LimitBudgetPolicy | undefined
): LimitBudgetPolicy | undefined {
  const resetTimeUtc = workspaceBudget && apiKeyBudget
    ? undefined
    : apiKeyBudget?.resetTimeUtc ?? workspaceBudget?.resetTimeUtc;
  const budget: LimitBudgetPolicy = {
    ...optionalNumber("dailyUsd", stricterNumber(workspaceBudget?.dailyUsd, apiKeyBudget?.dailyUsd)),
    ...optionalNumber("weeklyUsd", stricterNumber(workspaceBudget?.weeklyUsd, apiKeyBudget?.weeklyUsd)),
    ...optionalNumber("monthlyUsd", stricterNumber(workspaceBudget?.monthlyUsd, apiKeyBudget?.monthlyUsd)),
    ...optionalNumber("warningThreshold", stricterNumber(
      workspaceBudget?.warningThreshold,
      apiKeyBudget?.warningThreshold
    )),
    ...(resetTimeUtc ? { resetTimeUtc } : {})
  };
  return budget.dailyUsd !== undefined || budget.weeklyUsd !== undefined || budget.monthlyUsd !== undefined
    ? budget
    : undefined;
}

function stricterNumber(workspaceValue: number | undefined, apiKeyValue: number | undefined) {
  if (workspaceValue === undefined) return apiKeyValue;
  if (apiKeyValue === undefined) return workspaceValue;
  return Math.min(workspaceValue, apiKeyValue);
}

function optionalNumber<Key extends keyof LimitPolicy | keyof LimitBudgetPolicy>(key: Key, value: number | undefined) {
  return value === undefined ? {} : { [key]: value };
}

function parseWorkspacePolicy(value: unknown) {
  const parsed = workspaceLimitPolicySchema.safeParse(value);
  if (!parsed.success) throw policyError("workspace_limit_policy_invalid", parsed.error.issues);
  return parsed.data;
}

function parseApiKeyPolicy(value: unknown) {
  const parsed = apiKeyLimitPolicySchema.safeParse(value);
  if (!parsed.success) throw policyError("api_key_limit_policy_invalid", parsed.error.issues);
  return parsed.data;
}

function policyError(message: string, issues: { path: PropertyKey[] }[]) {
  const paths = issues.map((issue) => issue.path.join(".") || "policy").join(",");
  return new LimitPolicyResolutionError(`${message}:${paths}`);
}
