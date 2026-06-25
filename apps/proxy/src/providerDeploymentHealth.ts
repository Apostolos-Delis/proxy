import type { SelectedDeployment } from "@proxy/schema";

export type ProviderDeploymentFailureReason =
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "connection_error";

export type ProviderDeploymentHealthEntry = {
  key: string;
  provider: SelectedDeployment["provider"];
  model: string;
  failures: number;
  lastFailureReason: ProviderDeploymentFailureReason;
  lastFailureAt: number;
  cooldownUntil: number;
};

const defaultCooldownMs = 30_000;
const defaultMaxEntries = 10_000;

export class ProviderDeploymentHealthStore {
  private readonly entries = new Map<string, ProviderDeploymentHealthEntry>();

  constructor(
    private readonly cooldownMs = defaultCooldownMs,
    private readonly maxEntries = defaultMaxEntries
  ) {}

  isCoolingDown(deployment: SelectedDeployment, now = Date.now()) {
    const entry = this.entries.get(deployment.key);
    if (!entry) return false;
    if (entry.cooldownUntil <= now) {
      this.entries.delete(deployment.key);
      return false;
    }
    this.entries.delete(deployment.key);
    this.entries.set(deployment.key, entry);
    return true;
  }

  recordFailure(
    deployment: SelectedDeployment | undefined,
    reason: ProviderDeploymentFailureReason,
    now = Date.now()
  ) {
    if (!deployment) return;
    const existing = this.entries.get(deployment.key);
    if (existing) this.entries.delete(deployment.key);
    this.entries.set(deployment.key, {
      key: deployment.key,
      provider: deployment.provider,
      model: deployment.model,
      failures: (existing?.failures ?? 0) + 1,
      lastFailureReason: reason,
      lastFailureAt: now,
      cooldownUntil: now + this.cooldownMs
    });
    this.trim();
  }

  recordSuccess(deployment: SelectedDeployment | undefined) {
    if (!deployment) return;
    this.entries.delete(deployment.key);
  }

  snapshot(now = Date.now()) {
    return [...this.entries.values()]
      .filter((entry) => entry.cooldownUntil > now)
      .map((entry) => ({ ...entry }));
  }

  private trim() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
