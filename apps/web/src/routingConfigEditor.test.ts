import { describe, expect, it } from "vitest";

import type { RoutingConfigDocument } from "./api";
import { applyDraft, draftError, draftFromConfig } from "./routingConfigEditor";

const baseConfig: RoutingConfigDocument = {
  schemaVersion: 1,
  displayName: "Default coding router",
  systemPrompt: "Follow proxy policy.",
  classifier: {
    provider: "openai",
    model: "route-classifier",
    instructions: "Classify.",
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
  it("extracts the prompts and tier models", () => {
    const draft = draftFromConfig(baseConfig);

    expect(draft.systemPrompt).toBe("Follow proxy policy.");
    expect(draft.classifierInstructions).toBe("Classify.");
    expect(draft.routes.fast).toEqual({ openaiModel: "gpt-fast", anthropicModel: "claude-fast" });
    expect(draft.routes.deep).toEqual({ openaiModel: "gpt-deep", anthropicModel: "claude-deep" });
  });

  it("uses empty strings for missing provider blocks and prompts", () => {
    const { systemPrompt: _ignored, ...withoutPrompt } = baseConfig;
    const config = {
      ...withoutPrompt,
      routes: { ...baseConfig.routes, fast: { openai: { model: "gpt-fast" } } }
    };
    const draft = draftFromConfig(config);

    expect(draft.systemPrompt).toBe("");
    expect(draft.routes.fast).toEqual({ openaiModel: "gpt-fast", anthropicModel: "" });
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

  it("drops a provider block when its model is cleared", () => {
    const draft = draftFromConfig(baseConfig);
    draft.routes.fast.anthropicModel = "";
    const next = applyDraft(baseConfig, draft);

    expect(next.routes.fast.anthropic).toBeUndefined();
    expect("anthropic" in next.routes.fast).toBe(false);
    expect(next.routes.fast.openai?.model).toBe("gpt-fast");
  });

  it("updates the classifier instructions while preserving other classifier settings", () => {
    const draft = draftFromConfig(baseConfig);
    draft.classifierInstructions = "  Route by area.  ";
    const next = applyDraft(baseConfig, draft);

    expect(next.classifier).toEqual({ ...baseConfig.classifier, instructions: "Route by area." });
  });

  it("sets and clears the system prompt", () => {
    const draft = draftFromConfig(baseConfig);
    draft.systemPrompt = "  New policy.  ";
    expect(applyDraft(baseConfig, draft).systemPrompt).toBe("New policy.");

    draft.systemPrompt = "   ";
    const cleared = applyDraft(baseConfig, draft);
    expect(cleared.systemPrompt).toBeUndefined();
    expect("systemPrompt" in cleared).toBe(false);
  });

  it("does not mutate the base config", () => {
    const snapshot = structuredClone(baseConfig);
    const draft = draftFromConfig(baseConfig);
    draft.routes.deep.openaiModel = "gpt-other";
    draft.systemPrompt = "";
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

  it("rejects blank routing rules", () => {
    const draft = draftFromConfig(baseConfig);
    draft.classifierInstructions = "   ";

    expect(draftError(draft)).toContain("Routing rules");
  });
});
