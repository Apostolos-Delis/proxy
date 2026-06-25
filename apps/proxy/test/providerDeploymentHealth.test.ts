import { describe, expect, it } from "vitest";

import { ProviderDeploymentHealthStore, type ProviderDeploymentFailureReason } from "../src/providerDeploymentHealth.js";

const deployment = {
  key: "deployment:test",
  provider: "openai" as const,
  model: "gpt-test",
  order: 0,
  weight: 1,
  timeoutMs: 60000
};

describe("ProviderDeploymentHealthStore", () => {
  it("tracks cooldown for provider failure reasons and expires it", () => {
    const store = new ProviderDeploymentHealthStore(1000);
    const reasons: ProviderDeploymentFailureReason[] = [
      "rate_limited",
      "server_error",
      "timeout",
      "connection_error"
    ];

    for (const reason of reasons) {
      store.recordFailure(deployment, reason, 100);

      expect(store.isCoolingDown(deployment, 500)).toBe(true);
      expect(store.snapshot(500)[0]).toEqual(expect.objectContaining({
        key: deployment.key,
        lastFailureReason: reason
      }));
      expect(store.isCoolingDown(deployment, 1200)).toBe(false);
    }
  });

  it("clears cooldown on success", () => {
    const store = new ProviderDeploymentHealthStore(1000);

    store.recordFailure(deployment, "rate_limited", 100);
    store.recordSuccess(deployment);

    expect(store.isCoolingDown(deployment, 500)).toBe(false);
  });
});
