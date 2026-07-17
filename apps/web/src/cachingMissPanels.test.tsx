import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CacheHitRates } from "./cachingMissPanels";
import type { UsageGroup } from "./usageData";

describe("CacheHitRates", () => {
  it("renders provider-neutral model hit rates", () => {
    const html = renderToStaticMarkup(
      <CacheHitRates
        dimension="model"
        groups={[
          group("claude-opus", 100, 50),
          group("gpt-5.4", 100, 0)
        ]}
        lookups={{}}
      />
    );

    expect(html).toContain("Cache read ratio by model");
    expect(html).toContain("claude-opus");
    expect(html).toContain("50%");
    expect(html).toContain("Share of prompt input tokens served from cache.");
    expect(html).not.toContain("OpenAI");
  });
});

function group(key: string, inputTokens: number, cachedInputTokens: number): UsageGroup {
  return {
    key,
    requestCount: 1,
    failedRequests: 0,
    retriedRequests: 0,
    failureRate: 0,
    retryRate: 0,
    latency: { averageMs: null, p95Ms: null },
    usage: {
      inputTokens,
      cachedInputTokens,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: inputTokens
    },
    cost: { selected: 0, baseline: 0, savings: 0, classifier: 0 }
  };
}
