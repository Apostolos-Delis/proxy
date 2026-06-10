import { describe, expect, it } from "vitest";

import { applyDraft, draftError, draftFromConfig, parseConfigJson, type RoutingConfigDocument } from "./routingConfigEditor";

const baseConfig: RoutingConfigDocument = {
  schemaVersion: 1,
  displayName: "Default coding router",
  classifier: {
    provider: "openai",
    model: "route-classifier",
    rules: "Keep auth/ on hard.",
    timeoutMs: 1500,
    maxAttempts: 2,
    allowRedactedExcerpt: false
  },
  routes: {
    fast: {
      description: "Simple tasks",
      openai: { model: "gpt-fast", reasoning: { effort: "low" }, text: { verbosity: "low" } },
      anthropic: { model: "claude-fast", thinking: { type: "disabled" } }
    },
    balanced: {
      openai: { model: "gpt-balanced", reasoning: { effort: "medium" } },
      anthropic: { model: "claude-balanced" }
    },
    hard: {
      openai: { model: "gpt-hard", reasoning: { effort: "high" } },
      anthropic: { model: "claude-hard" }
    },
    deep: {
      openai: { model: "gpt-deep", reasoning: { effort: "xhigh" } },
      anthropic: { model: "claude-deep" }
    }
  },
  limits: { maxRoute: "deep", fallbackRoute: "hard" },
  session: { pinInitialRoute: true, allowUpgrade: true, allowDowngrade: false }
};

describe("draftFromConfig", () => {
  it("extracts the routing rules, tier models, and efforts", () => {
    const draft = draftFromConfig(baseConfig);

    expect(draft.classifierRules).toBe("Keep auth/ on hard.");
    expect(draft.routes.fast).toEqual({
      openaiModel: "gpt-fast",
      openaiEffort: "low",
      anthropicModel: "claude-fast",
      anthropicEffort: ""
    });
    expect(draft.routes.deep).toEqual({
      openaiModel: "gpt-deep",
      openaiEffort: "xhigh",
      anthropicModel: "claude-deep",
      anthropicEffort: ""
    });
  });

  it("uses empty strings for missing provider blocks", () => {
    const config = {
      ...baseConfig,
      routes: { ...baseConfig.routes, fast: { openai: { model: "gpt-fast" } } }
    };
    const draft = draftFromConfig(config);

    expect(draft.routes.fast).toEqual({
      openaiModel: "gpt-fast",
      openaiEffort: "",
      anthropicModel: "",
      anthropicEffort: ""
    });
  });
});

describe("applyDraft", () => {
  it("round-trips unchanged drafts", () => {
    expect(applyDraft(baseConfig, draftFromConfig(baseConfig))).toEqual(baseConfig);
  });

  it("updates models while preserving other provider settings", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.fast.openaiModel = " gpt-fast-next ";
    const next = applyDraft(baseConfig, draft);

    expect(next.routes.fast.openai).toEqual({
      model: "gpt-fast-next",
      reasoning: { effort: "low" },
      text: { verbosity: "low" }
    });
    expect(next.routes.fast.anthropic).toEqual(baseConfig.routes.fast.anthropic);
    expect(next.routes.fast.description).toBe("Simple tasks");
  });

  it("sets efforts, creating the effort container when missing", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.fast.openaiEffort = "xhigh";
    draft.routes.fast.anthropicEffort = "max";
    const next = applyDraft(baseConfig, draft);

    expect(next.routes.fast.openai?.reasoning).toEqual({ effort: "xhigh" });
    expect(next.routes.fast.anthropic).toEqual({
      model: "claude-fast",
      thinking: { type: "disabled" },
      output_config: { effort: "max" }
    });
  });

  it("clears efforts and drops empty containers while keeping other settings", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.fast.openaiEffort = "";
    const next = applyDraft(baseConfig, draft);

    expect(next.routes.fast.openai).toEqual({
      model: "gpt-fast",
      text: { verbosity: "low" }
    });
    expect("reasoning" in (next.routes.fast.openai ?? {})).toBe(false);
  });

  it("drops a provider block when its model is cleared", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.fast.anthropicModel = "";
    const next = applyDraft(baseConfig, draft);

    expect(next.routes.fast.anthropic).toBeUndefined();
    expect("anthropic" in next.routes.fast).toBe(false);
    expect(next.routes.fast.openai?.model).toBe("gpt-fast");
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
    draft.routes.deep.openaiModel = "gpt-other";
    draft.classifierRules = "";
    applyDraft(baseConfig, draft);

    expect(baseConfig).toEqual(snapshot);
  });
});

describe("draftError", () => {
  it("accepts drafts with at least one model per tier", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.fast.openaiModel = "";

    expect(draftError(draft)).toBeUndefined();
  });

  it("rejects tiers with no models", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.hard.openaiModel = " ";
    draft.routes.hard.anthropicModel = "";

    expect(draftError(draft)).toContain("hard");
  });

  it("accepts blank routing rules", () => {
    const draft = draftFromConfig(baseConfig);
    draft.classifierRules = "   ";

    expect(draftError(draft)).toBeUndefined();
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
