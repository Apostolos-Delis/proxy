import { describe, expect, it } from "vitest";

import {
  bustCauseLabels,
  bustCauses,
  bustsByModel,
  cacheSavings,
  openAICacheGroupLabel,
  promptCacheControlRows,
  type PromptCachePlanReport
} from "./cachingData";
import type { UsageGroup } from "./usageData";

function modelGroup(key: string, usage: Partial<UsageGroup["usage"]>): Pick<UsageGroup, "key" | "usage"> {
  return {
    key,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      ...usage
    }
  };
}

describe("bustsByModel", () => {
  it("rolls busts up per model with token-weighted cause splits, largest first", () => {
    const rows = bustsByModel([
      { model: "claude-opus", cause: "ttl_expiry", droppedCacheReadTokens: 1000 },
      { model: "claude-opus", cause: "model_switch", droppedCacheReadTokens: 3000 },
      { model: "gpt-5.5", cause: "unknown", droppedCacheReadTokens: 9000 }
    ]);
    expect(rows.map((row) => row.model)).toEqual(["gpt-5.5", "claude-opus"]);
    expect(rows[1]).toEqual({
      model: "claude-opus",
      busts: 2,
      droppedTokens: 4000,
      tokensByCause: { ttl_expiry: 1000, model_switch: 3000 }
    });
  });

  it("is empty for no busts", () => {
    expect(bustsByModel([])).toEqual([]);
  });
});

describe("bust causes", () => {
  it("exposes labels and chart keys for controllable churn causes", () => {
    expect(bustCauseLabels).toMatchObject({
      org_prompt_edit: "Org prompt edit",
      tool_schema_churn: "Tool schema churn",
      translator_change: "Translator change",
      compression_policy_change: "Compression policy change",
      route_config_change: "Route config change"
    });
    expect(bustCauses.map((cause) => cause.key)).toEqual([
      "ttl_expiry",
      "model_switch",
      "provider_switch",
      "org_prompt_edit",
      "tool_schema_churn",
      "translator_change",
      "compression_policy_change",
      "route_config_change",
      "unknown"
    ]);
  });
});

describe("cacheSavings", () => {
  const rates = [
    { model: "claude-opus", inputCostPerMtok: 10, cacheReadCostPerMtok: 1, cacheWriteCostPerMtok: 12.5 },
    { model: "bare-model", inputCostPerMtok: 4, cacheReadCostPerMtok: null, cacheWriteCostPerMtok: null },
    { model: "unpriced-model", inputCostPerMtok: null, cacheReadCostPerMtok: null, cacheWriteCostPerMtok: null }
  ];

  it("values reads at the read discount net of the write surcharge", () => {
    const savings = cacheSavings(
      [modelGroup("claude-opus", { inputTokens: 3_000_000, cachedInputTokens: 2_000_000, cacheCreationInputTokens: 400_000 })],
      rates
    );
    // reads: 2M × ($10 − $1)/M = $18; writes: 0.4M × ($12.5 − $10)/M = $1
    expect(savings.gross).toBeCloseTo(18);
    expect(savings.writePremium).toBeCloseTo(1);
    expect(savings.net).toBeCloseTo(17);
    expect(savings.unpricedCachedTokens).toBe(0);
  });

  it("falls back to the default multipliers when cache rates are unset", () => {
    const savings = cacheSavings(
      [modelGroup("bare-model", { cachedInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 })],
      rates
    );
    // reads: 1M × ($4 − $0.4)/M = $3.6; writes: 1M × ($5 − $4)/M = $1
    expect(savings.gross).toBeCloseTo(3.6);
    expect(savings.writePremium).toBeCloseTo(1);
  });

  it("reports cached tokens it cannot value instead of booking them at $0", () => {
    const savings = cacheSavings(
      [
        modelGroup("unpriced-model", { cachedInputTokens: 500_000 }),
        modelGroup("never-seen-model", { cachedInputTokens: 250_000 })
      ],
      rates
    );
    expect(savings.gross).toBe(0);
    expect(savings.unpricedCachedTokens).toBe(750_000);
  });
});

describe("promptCacheControlRows", () => {
  it("sorts control rows by volume with a stable label tiebreak", () => {
    const report = {
      totalPlans: 4,
      sampled: false,
      plans: [],
      controls: [
        promptCacheControl({ provider: "openai", model: "gpt", control: "retention_preserved", count: 1 }),
        promptCacheControl({ provider: "anthropic", model: "claude", control: "top_level_auto_breakpoint", status: "skipped", reason: "setting_disabled", count: 3 }),
        promptCacheControl({ provider: "openai", model: "gpt", control: "implicit_prefix_caching", count: 3 })
      ]
    } satisfies PromptCachePlanReport;

    expect(promptCacheControlRows(report).map((row) => row.control)).toEqual([
      "top_level_auto_breakpoint",
      "implicit_prefix_caching",
      "retention_preserved"
    ]);
    expect(promptCacheControlRows(report, 2)).toHaveLength(2);
  });
});

describe("openAICacheGroupLabel", () => {
  it("uses a short hash label for prompt cache keys and session fallback labels otherwise", () => {
    expect(openAICacheGroupLabel({
      cacheGroupSource: "prompt_cache_key",
      cacheGroupKey: "sha256:1234567890abcdef"
    })).toBe("Key 1234567890ab");
    expect(openAICacheGroupLabel({
      cacheGroupSource: "session",
      cacheGroupKey: "session_abc"
    })).toBe("Session session_abc");
  });
});

function promptCacheControl(overrides: Partial<PromptCachePlanReport["controls"][number]> = {}) {
  return {
    provider: "openai",
    model: "gpt-5.5",
    mode: "implicit",
    control: "implicit_prefix_caching",
    status: "applied",
    reason: "none",
    count: 1,
    ...overrides
  };
}
