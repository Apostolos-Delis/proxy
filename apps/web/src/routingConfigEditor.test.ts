import { describe, expect, it } from "vitest";

import {
  applyDraft,
  draftError,
  draftFromConfig,
  effectiveEffortForTarget,
  parseConfigJson,
  type RoutingConfigDocument
} from "./routingConfigEditor";

const baseConfig: RoutingConfigDocument = {
  schemaVersion: 2,
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
      targets: [
        { providerId: "anthropic", model: "claude-fast", effort: "minimal", thinking: { type: "disabled" } },
        { providerId: "openai", model: "gpt-fast", effort: "low", verbosity: "low" }
      ]
    },
    balanced: {
      targets: [
        { providerId: "anthropic", model: "claude-balanced", effort: "medium" },
        { providerId: "openai", model: "gpt-balanced", effort: "medium" }
      ]
    },
    hard: {
      targets: [
        { providerId: "anthropic", model: "claude-hard", effort: "high" },
        { providerId: "openai", model: "gpt-hard", effort: "high" }
      ]
    },
    deep: {
      targets: [
        { providerId: "anthropic", model: "claude-deep", effort: "max", metadata: { lane: "deep" } },
        { providerId: "openai", model: "gpt-deep", effort: "xhigh", maxOutputTokens: 20000 }
      ]
    }
  },
  limits: { maxRoute: "deep", fallbackRoute: "hard" },
  session: { pinInitialRoute: true, allowUpgrade: true, allowDowngrade: false }
};

describe("draftFromConfig", () => {
  it("extracts routing rules and ordered targets", () => {
    const draft = draftFromConfig(baseConfig);

    expect(draft.classifierRules).toBe("Keep auth/ on hard.");
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
      routes: { ...baseConfig.routes, fast: { targets: [] } }
    };
    const draft = draftFromConfig(config);

    expect(draft.routes.fast.targets).toEqual([]);
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

    expect(next.routes.fast.targets).toEqual([
      { providerId: "openai", model: "gpt-fast-next", effort: "low", verbosity: "low" },
      { providerId: "anthropic", model: "claude-fast", effort: "minimal", thinking: { type: "disabled" } }
    ]);
    expect(next.routes.fast.description).toBe("Simple tasks");
  });

  it("drops completely blank target rows while preserving target metadata", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.deep.targets.push({ providerId: " ", model: " ", effort: " " });
    const next = applyDraft(baseConfig, draft);

    expect(next.routes.deep.targets).toEqual(baseConfig.routes.deep.targets);
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
});

describe("effectiveEffortForTarget", () => {
  it("shows Anthropic effort clamping without changing the draft", () => {
    expect(effectiveEffortForTarget({ providerId: "anthropic", effort: "minimal" })).toBe("low");
    expect(effectiveEffortForTarget({ providerId: "openai", effort: "minimal" })).toBe("minimal");
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
