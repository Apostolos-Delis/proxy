import type { Provider } from "./types.js";

export type TrafficLimitConfig = {
  windowMs: number;
  globalConcurrent?: number;
  organizationConcurrent?: number;
  workspaceConcurrent?: number;
  apiKeyConcurrent?: number;
  userConcurrent?: number;
  providerModelConcurrent?: number;
  globalRpm?: number;
  organizationRpm?: number;
  workspaceRpm?: number;
  apiKeyRpm?: number;
  userRpm?: number;
  providerModelRpm?: number;
  globalTpm?: number;
  organizationTpm?: number;
  workspaceTpm?: number;
  apiKeyTpm?: number;
  userTpm?: number;
  providerModelTpm?: number;
};

export type TrafficLimitInput = {
  organizationId: string;
  workspaceId: string;
  apiKeyId?: string;
  userId?: string;
  provider?: Provider;
  model?: string;
  estimatedTokens: number;
};

export type TrafficLimitStage = "request" | "provider_model";

export type TrafficLimitLease = {
  release: () => void;
};

export type TrafficLimitDenied = {
  allowed: false;
  error: string;
  scope: string;
  limit: number;
  current: number;
  retryAfterSeconds?: number;
};

type TrafficLimitAllowed = {
  allowed: true;
  lease: TrafficLimitLease;
};

type RateBucket = {
  windowStartedAt: number;
  requests: number;
  tokens: number;
};

type ConcurrencyCheck = {
  kind: "concurrency";
  scope: string;
  key: string;
  limit: number;
};

type RateCheck = {
  kind: "rpm" | "tpm";
  scope: string;
  key: string;
  limit: number;
};

type LimitCheck = ConcurrencyCheck | RateCheck;

export class TrafficLimitStore {
  private readonly concurrency = new Map<string, number>();
  private readonly rates = new Map<string, RateBucket>();
  private nextRateCleanupAt = 0;

  constructor(
    private readonly config: TrafficLimitConfig,
    private readonly nowMs = () => Date.now()
  ) {}

  acquire(input: TrafficLimitInput, stage: TrafficLimitStage = "request"): TrafficLimitAllowed | TrafficLimitDenied {
    const now = this.nowMs();
    this.cleanupExpiredRateBuckets(now);
    const checks = limitChecks(this.config, input, stage);
    const tokens = Math.max(0, Math.ceil(input.estimatedTokens));

    for (const check of checks) {
      if (check.kind === "concurrency") {
        const current = this.concurrency.get(check.key) ?? 0;
        if (current >= check.limit) {
          return denied(check, current);
        }
        continue;
      }

      const bucket = this.rateBucket(check.key, now);
      const current = check.kind === "rpm" ? bucket.requests : bucket.tokens;
      const next = current + (check.kind === "rpm" ? 1 : tokens);
      if (next > check.limit) {
        return denied(check, current, retryAfterSeconds(bucket, this.config.windowMs, now));
      }
    }

    const acquiredConcurrency: string[] = [];
    for (const check of checks) {
      if (check.kind !== "concurrency") continue;
      this.concurrency.set(check.key, (this.concurrency.get(check.key) ?? 0) + 1);
      acquiredConcurrency.push(check.key);
    }
    for (const check of checks) {
      if (check.kind === "concurrency") continue;
      const bucket = this.rateBucket(check.key, now);
      if (check.kind === "rpm") bucket.requests += 1;
      else bucket.tokens += tokens;
    }

    let released = false;
    return {
      allowed: true,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          for (const key of acquiredConcurrency) {
            const next = (this.concurrency.get(key) ?? 1) - 1;
            if (next > 0) this.concurrency.set(key, next);
            else this.concurrency.delete(key);
          }
        }
      }
    };
  }

  private rateBucket(key: string, now: number) {
    const existing = this.rates.get(key);
    if (existing && now - existing.windowStartedAt < this.config.windowMs) return existing;
    const next = { windowStartedAt: now, requests: 0, tokens: 0 };
    this.rates.set(key, next);
    return next;
  }

  private cleanupExpiredRateBuckets(now: number) {
    if (now < this.nextRateCleanupAt) return;
    for (const [key, bucket] of this.rates.entries()) {
      if (now - bucket.windowStartedAt >= this.config.windowMs) this.rates.delete(key);
    }
    this.nextRateCleanupAt = now + this.config.windowMs;
  }
}

function limitChecks(config: TrafficLimitConfig, input: TrafficLimitInput, stage: TrafficLimitStage): LimitCheck[] {
  const scopeKeys = scopedKeys(input);
  const requestChecks = [
    concurrencyCheck("global", scopeKeys.global, config.globalConcurrent),
    concurrencyCheck("organization", scopeKeys.organization, config.organizationConcurrent),
    concurrencyCheck("workspace", scopeKeys.workspace, config.workspaceConcurrent),
    concurrencyCheck("api_key", scopeKeys.apiKey, config.apiKeyConcurrent),
    concurrencyCheck("user", scopeKeys.user, config.userConcurrent),
    rateCheck("rpm", "global", scopeKeys.global, config.globalRpm),
    rateCheck("rpm", "organization", scopeKeys.organization, config.organizationRpm),
    rateCheck("rpm", "workspace", scopeKeys.workspace, config.workspaceRpm),
    rateCheck("rpm", "api_key", scopeKeys.apiKey, config.apiKeyRpm),
    rateCheck("rpm", "user", scopeKeys.user, config.userRpm),
    rateCheck("tpm", "global", scopeKeys.global, config.globalTpm),
    rateCheck("tpm", "organization", scopeKeys.organization, config.organizationTpm),
    rateCheck("tpm", "workspace", scopeKeys.workspace, config.workspaceTpm),
    rateCheck("tpm", "api_key", scopeKeys.apiKey, config.apiKeyTpm),
    rateCheck("tpm", "user", scopeKeys.user, config.userTpm)
  ];
  const providerModelChecks = [
    concurrencyCheck("provider_model", scopeKeys.providerModel, config.providerModelConcurrent),
    rateCheck("rpm", "provider_model", scopeKeys.providerModel, config.providerModelRpm),
    rateCheck("tpm", "provider_model", scopeKeys.providerModel, config.providerModelTpm)
  ];
  const checks = stage === "request" ? requestChecks : providerModelChecks;
  return checks.filter((check): check is LimitCheck => check !== undefined);
}

function scopedKeys(input: TrafficLimitInput) {
  return {
    global: "global",
    organization: `organization:${input.organizationId}`,
    workspace: `workspace:${input.organizationId}:${input.workspaceId}`,
    apiKey: input.apiKeyId ? `api_key:${input.organizationId}:${input.apiKeyId}` : undefined,
    user: input.userId ? `user:${input.organizationId}:${input.userId}` : undefined,
    providerModel: input.provider && input.model ? `provider_model:${input.provider}:${input.model}` : undefined
  };
}

function concurrencyCheck(scope: string, key: string | undefined, limit: number | undefined): ConcurrencyCheck | undefined {
  if (!key || limit === undefined) return undefined;
  return { kind: "concurrency", scope, key: `concurrency:${key}`, limit };
}

function rateCheck(
  kind: "rpm" | "tpm",
  scope: string,
  key: string | undefined,
  limit: number | undefined
): RateCheck | undefined {
  if (!key || limit === undefined) return undefined;
  return { kind, scope, key: `${kind}:${key}`, limit };
}

function denied(
  check: LimitCheck,
  current: number,
  retryAfterSeconds?: number
): TrafficLimitDenied {
  return {
    allowed: false,
    error: `traffic_limit_exceeded:${check.scope}:${check.kind}`,
    scope: check.scope,
    limit: check.limit,
    current,
    retryAfterSeconds
  };
}

function retryAfterSeconds(bucket: RateBucket, windowMs: number, now: number) {
  return Math.max(1, Math.ceil((bucket.windowStartedAt + windowMs - now) / 1000));
}
