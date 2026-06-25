import { describe, expect, it } from "vitest";

import {
  applyDraft,
  draftError,
  draftFromConfig,
  effectiveEffortForTarget,
  effortOptionsForProvider,
  effortScaleForProvider,
  parseConfigJson,
  type RoutingConfigDocument
} from "./routingConfigEditor";

const baseConfig: RoutingConfigDocument = {
  schemaVersion: 3,
  displayName: "Default coding router",
  classifier: {
    providerId: "openai",
    model: "route-classifier",
    effort: "minimal",
    rules: "Keep auth/ on hard.",
    timeoutMs: 1500,
    maxAttempts: 2,
    allowRedactedExcerpt: false
  },
  routes: {
    fast: {
      description: "Simple tasks",
      openai: {
        deployments: [{
          provider: "openai",
          model: "gpt-fast",
          order: 1,
          weight: 1,
          timeoutMs: 60000,
          reasoning: { effort: "low" },
          text: { verbosity: "low" }
        }]
      },
      anthropic: {
        deployments: [{
          provider: "anthropic",
          model: "claude-fast",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          output_config: { effort: "minimal" },
          thinking: { type: "disabled" }
        }]
      }
    },
    balanced: {
      openai: {
        deployments: [{
          provider: "openai",
          model: "gpt-balanced",
          order: 1,
          weight: 1,
          timeoutMs: 60000,
          reasoning: { effort: "medium" }
        }]
      },
      anthropic: {
        deployments: [{
          provider: "anthropic",
          model: "claude-balanced",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          output_config: { effort: "medium" }
        }]
      }
    },
    hard: {
      openai: {
        deployments: [{
          provider: "openai",
          model: "gpt-hard",
          order: 1,
          weight: 1,
          timeoutMs: 60000,
          reasoning: { effort: "high" }
        }]
      },
      anthropic: {
        deployments: [{
          provider: "anthropic",
          model: "claude-hard",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          output_config: { effort: "high" }
        }]
      }
    },
    deep: {
      openai: {
        deployments: [{
          provider: "openai",
          model: "gpt-deep",
          order: 1,
          weight: 1,
          timeoutMs: 60000,
          reasoning: { effort: "xhigh" },
          maxOutputTokens: 20000
        }]
      },
      anthropic: {
        deployments: [{
          provider: "anthropic",
          model: "claude-deep",
          order: 0,
          weight: 1,
          timeoutMs: 60000,
          output_config: { effort: "max" },
          metadata: { lane: "deep" }
        }]
      }
    }
  },
  limits: { maxRoute: "deep", fallbackRoute: "hard" },
  session: { pinInitialRoute: true, allowUpgrade: true, allowDowngrade: false }
};

describe("draftFromConfig", () => {
  it("extracts routing rules and ordered targets", () => {
    const draft = draftFromConfig(baseConfig);

    expect(draft.classifierRules).toBe("Keep auth/ on hard.");
    expect(draft.maxEstimatedInputTokensEnabled).toBe(false);
    expect(draft.maxEstimatedInputTokens).toBe("");
    expect(draft.routes.fast.targets).toEqual([
      { providerId: "anthropic", model: "claude-fast", effort: "minimal", thinking: { type: "disabled" } },
      { providerId: "openai", model: "gpt-fast", effort: "low", verbosity: "low" }
    ]);
    expect(draft.routes.deep.targets[1]).toEqual({
      providerId: "openai",
      model: "gpt-deep",
      effort: "xhigh",
      maxOutputTokens: 20000
    });
  });

  it("uses an empty target list for missing route configs", () => {
    const config = {
      ...baseConfig,
      routes: { ...baseConfig.routes, fast: {} }
    };
    const draft = draftFromConfig(config);

    expect(draft.routes.fast.targets).toEqual([]);
  });

  it("extracts enabled request input caps", () => {
    const draft = draftFromConfig({
      ...baseConfig,
      limits: { ...baseConfig.limits, maxEstimatedInputTokens: 250000 }
    });

    expect(draft.maxEstimatedInputTokensEnabled).toBe(true);
    expect(draft.maxEstimatedInputTokens).toBe("250000");
  });
});

describe("applyDraft", () => {
  it("round-trips unchanged drafts", () => {
    expect(applyDraft(baseConfig, draftFromConfig(baseConfig))).toEqual(baseConfig);
  });

  it("updates target order and trims provider/model/effort values", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.fast.targets = [
      { providerId: " openai ", model: " gpt-fast-next ", effort: " low ", verbosity: "low" },
      { providerId: "anthropic", model: "claude-fast", effort: "minimal", thinking: { type: "disabled" } }
    ];
    const next = applyDraft(baseConfig, draft);

    expect(next.routes.fast.openai?.deployments?.[0]).toEqual({
      provider: "openai",
      model: "gpt-fast-next",
      order: 0,
      weight: 1,
      timeoutMs: 60000,
      reasoning: { effort: "low" },
      text: { verbosity: "low" }
    });
    expect(next.routes.fast.anthropic?.deployments?.[0]).toEqual({
      provider: "anthropic",
      model: "claude-fast",
      order: 1,
      weight: 1,
      timeoutMs: 60000,
      output_config: { effort: "minimal" },
      thinking: { type: "disabled" }
    });
    expect(next.routes.fast.description).toBe("Simple tasks");
  });

  it("drops completely blank target rows while preserving target metadata", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.deep.targets.push({ providerId: " ", model: " ", effort: " " });
    const next = applyDraft(baseConfig, draft);

    expect(next.routes.deep).toEqual(baseConfig.routes.deep);
  });

  it("updates the classifier rules while preserving other classifier settings", () => {
    const draft = draftFromConfig(baseConfig);
    draft.classifierRules = "  Route by area.  ";
    const next = applyDraft(baseConfig, draft);

    expect(next.classifier).toEqual({ ...baseConfig.classifier, rules: "Route by area." });
  });

  it("clears the classifier rules when blank", () => {
    const draft = draftFromConfig(baseConfig);
    draft.classifierRules = "   ";
    const next = applyDraft(baseConfig, draft);

    expect(next.classifier.rules).toBeUndefined();
    expect("rules" in next.classifier).toBe(false);
    expect(next.classifier.model).toBe("route-classifier");
  });

  it("writes an enabled request input cap", () => {
    const draft = draftFromConfig(baseConfig);
    draft.maxEstimatedInputTokensEnabled = true;
    draft.maxEstimatedInputTokens = "250000";
    const next = applyDraft(baseConfig, draft);

    expect(next.limits.maxEstimatedInputTokens).toBe(250000);
  });

  it("removes a disabled request input cap", () => {
    const cappedConfig = {
      ...baseConfig,
      limits: { ...baseConfig.limits, maxEstimatedInputTokens: 200000 }
    };
    const draft = draftFromConfig(cappedConfig);
    draft.maxEstimatedInputTokensEnabled = false;
    const next = applyDraft(cappedConfig, draft);

    expect(next.limits.maxEstimatedInputTokens).toBeUndefined();
    expect("maxEstimatedInputTokens" in next.limits).toBe(false);
  });

  it("does not mutate the base config", () => {
    const snapshot = structuredClone(baseConfig);
    const draft = draftFromConfig(baseConfig);
    draft.routes.deep.targets[0].model = "claude-other";
    draft.classifierRules = "";
    applyDraft(baseConfig, draft);

    expect(baseConfig).toEqual(snapshot);
  });
});

describe("draftError", () => {
  it("accepts drafts with at least one complete target per tier", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.fast.targets = draft.routes.fast.targets.slice(0, 1);

    expect(draftError(draft)).toBeUndefined();
  });

  it("rejects tiers with no targets", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.hard.targets = [];

    expect(draftError(draft)).toContain("hard");
  });

  it("rejects incomplete targets", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.hard.targets[0].model = " ";

    expect(draftError(draft)).toBe("hard target 1 needs both a provider and model.");
  });

  it("accepts blank routing rules", () => {
    const draft = draftFromConfig(baseConfig);
    draft.classifierRules = "   ";

    expect(draftError(draft)).toBeUndefined();
  });

  it("rejects invalid request input caps when enabled", () => {
    const draft = draftFromConfig(baseConfig);
    draft.maxEstimatedInputTokensEnabled = true;
    draft.maxEstimatedInputTokens = "0";

    expect(draftError(draft)).toBe("Request input cap must be a positive whole number.");
  });

  it("ignores request input cap text when disabled", () => {
    const draft = draftFromConfig(baseConfig);
    draft.maxEstimatedInputTokensEnabled = false;
    draft.maxEstimatedInputTokens = "not-a-number";

    expect(draftError(draft)).toBeUndefined();
  });
});

describe("effectiveEffortForTarget", () => {
  it("shows provider effort clamping without changing the draft", () => {
    const openaiEfforts = ["low", "medium", "high", "xhigh"];
    const anthropicEfforts = ["low", "medium", "high", "xhigh", "max", "ultracode"];

    expect(effectiveEffortForTarget({ providerId: "anthropic", model: "claude-opus-4-5", effort: "minimal", thinking: { type: "adaptive" } }, anthropicEfforts)).toBe("low");
    expect(effectiveEffortForTarget({ providerId: "openai", model: "gpt-hard", effort: "max" }, openaiEfforts)).toBe("xhigh");
    expect(effectiveEffortForTarget({ providerId: "anthropic", model: "claude-opus-4-5", effort: "ultracode", thinking: { type: "adaptive" } }, anthropicEfforts)).toBe("high");
    expect(effectiveEffortForTarget({ providerId: "anthropic", model: "claude-opus-4-8", effort: "high" }, anthropicEfforts)).toBe("");
    expect(effectiveEffortForTarget({ providerId: "anthropic", model: "claude-sonnet-4-5", effort: "high", thinking: { type: "adaptive" } }, anthropicEfforts)).toBe("");
  });

  it("uses Anthropic model effort support for Anthropic-compatible custom providers", () => {
    const efforts = ["low", "medium", "high", "xhigh", "max", "ultracode"];

    expect(effectiveEffortForTarget(
      { providerId: "custom-anthropic", model: "claude-opus-4-8", effort: "ultracode", thinking: { type: "adaptive" } },
      efforts,
      ["anthropic-messages"]
    )).toBe("xhigh");
  });
});

describe("effortScaleForProvider", () => {
  it("uses provider capabilities and preserves unsupported current values as menu options", () => {
    const provider = { capabilities: { efforts: ["low", "medium", "high", "xhigh"] } };

    expect(effortScaleForProvider(provider)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortOptionsForProvider(provider, "max")).toEqual(["max", "low", "medium", "high", "xhigh"]);
    expect(effortScaleForProvider({ capabilities: {} })).toEqual([]);
    expect(effortScaleForProvider({ capabilities: { efforts: [] } })).toEqual([]);
    expect(effortScaleForProvider(undefined)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max", "ultracode"]);
  });
});

describe("parseConfigJson", () => {
  it("parses object documents", () => {
    const result = parseConfigJson(JSON.stringify(baseConfig, null, 2));

    expect(result.error).toBeUndefined();
    expect(result.config).toEqual(baseConfig);
  });

  it("reports invalid JSON", () => {
    const result = parseConfigJson("{ not json");

    expect(result.config).toBeUndefined();
    expect(result.error).toContain("Invalid JSON");
  });

  it("rejects non-object documents", () => {
    expect(parseConfigJson("[1, 2]").error).toBe("Config JSON must be an object.");
    expect(parseConfigJson("null").error).toBe("Config JSON must be an object.");
  });
});
