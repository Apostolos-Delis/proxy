import { describe, expect, it } from "vitest";

import { routingConfigSchema, type RoutingConfig } from "./index.js";

const validConfig = {
  schemaVersion: 1,
  displayName: "Default coding router",
  description: "Routes coding-agent traffic by complexity.",
  classifier: {
    provider: "openai",
    model: "gpt-5-nano-2025-08-07",
    instructions: "Classify coding-agent requests into route tiers.",
    timeoutMs: 1500,
    maxAttempts: 2,
    allowRedactedExcerpt: true,
    structuredOutput: {
      mode: "json_schema",
      schemaName: "routing_classifier"
    }
  },
  routes: {
    fast: {
      description: "Simple shell/status/read-only tasks",
      openai: {
        model: "gpt-5-nano-2025-08-07",
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
        metadata: {
          surface: "responses"
        }
      },
      anthropic: {
        model: "claude-haiku-4-5",
        thinking: { type: "disabled" },
        output_config: { effort: "low" }
      }
    },
    balanced: {
      description: "Default coding tasks",
      openai: {
        model: "gpt-5.4",
        reasoning: { effort: "medium" },
        text: { verbosity: "low" }
      },
      anthropic: {
        model: "claude-sonnet-4-5",
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "medium" }
      }
    },
    hard: {
      description: "Debugging, multi-file edits, migrations",
      openai: {
        model: "gpt-5.5",
        reasoning: { effort: "high" },
        text: { verbosity: "medium" }
      },
      anthropic: {
        model: "claude-sonnet-4-5",
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "high" }
      }
    },
    deep: {
      description: "Architecture, system design, security, storage design",
      openai: {
        model: "gpt-5.5-pro",
        reasoning: { effort: "xhigh" },
        text: { verbosity: "medium" }
      },
      anthropic: {
        model: "claude-opus-4-5",
        thinking: { type: "adaptive", display: "omitted" },
        output_config: { effort: "xhigh" }
      }
    }
  },
  limits: {
    maxRoute: "deep",
    fallbackRoute: "hard",
    maxEstimatedInputTokens: 200000,
    routeEstimatedInputLimits: {
      fast: 12000,
      balanced: 64000,
      hard: 200000,
      deep: 400000
    }
  },
  session: {
    pinInitialRoute: true,
    allowUpgrade: true,
    allowDowngrade: false
  }
} satisfies RoutingConfig;

describe("routingConfigSchema", () => {
  it("accepts a default OpenAI and Anthropic routing config", () => {
    expect(routingConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  it("rejects unknown top-level fields", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      promptRewrite: {
        enabled: false
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([]);
  });

  it("rejects invalid classifier settings with useful paths", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        timeoutMs: 0
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["classifier", "timeoutMs"]);
  });

  it("rejects expensive classifier retry settings before runtime", () => {
    const timeoutResult = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        timeoutMs: 30001
      }
    });
    const attemptResult = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        maxAttempts: 6
      }
    });

    expect(timeoutResult.success).toBe(false);
    expect(timeoutResult.error?.issues[0]?.path).toEqual(["classifier", "timeoutMs"]);
    expect(attemptResult.success).toBe(false);
    expect(attemptResult.error?.issues[0]?.path).toEqual(["classifier", "maxAttempts"]);
  });

  it("rejects whitespace-only classifier and provider strings", () => {
    const classifierResult = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        model: "   "
      }
    });
    const providerResult = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        fast: {
          ...validConfig.routes.fast,
          openai: {
            ...validConfig.routes.fast.openai,
            model: "\t"
          }
        }
      }
    });

    expect(classifierResult.success).toBe(false);
    expect(classifierResult.error?.issues[0]?.path).toEqual(["classifier", "model"]);
    expect(providerResult.success).toBe(false);
    expect(providerResult.error?.issues[0]?.path).toEqual(["routes", "fast", "openai", "model"]);
  });

  it("rejects model identifiers with surrounding whitespace", () => {
    const classifierResult = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        model: " gpt-5-nano-2025-08-07 "
      }
    });
    const providerResult = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        deep: {
          ...validConfig.routes.deep,
          anthropic: {
            ...validConfig.routes.deep.anthropic,
            model: "\tclaude-opus-4-5\n"
          }
        }
      }
    });

    expect(classifierResult.success).toBe(false);
    expect(classifierResult.error?.issues[0]?.path).toEqual(["classifier", "model"]);
    expect(providerResult.success).toBe(false);
    expect(providerResult.error?.issues[0]?.path).toEqual(["routes", "deep", "anthropic", "model"]);
  });

  it("rejects structured-output schema identifiers with surrounding whitespace", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      classifier: {
        ...validConfig.classifier,
        structuredOutput: {
          ...validConfig.classifier.structuredOutput,
          schemaName: " routing_classifier "
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["classifier", "structuredOutput", "schemaName"]);
  });

  it("rejects invalid provider blocks before runtime", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        hard: {
          ...validConfig.routes.hard,
          openai: {
            ...validConfig.routes.hard.openai,
            reasoning: { effort: "maximum" }
          }
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["routes", "hard", "openai", "reasoning", "effort"]);
  });

  it("requires each route to define at least one provider", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      routes: {
        ...validConfig.routes,
        fast: {
          description: "No provider"
        }
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["routes", "fast", "openai"]);
  });

  it("accepts partial route estimated input limits", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      limits: {
        ...validConfig.limits,
        routeEstimatedInputLimits: {
          fast: 12000
        }
      }
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown route estimated input limit keys", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      limits: {
        ...validConfig.limits,
        routeEstimatedInputLimits: {
          fast: 12000,
          turbo: 1
        }
      }
    });

    expect(result.success).toBe(false);
  });

  it("rejects fallback routes above the configured max route", () => {
    const result = routingConfigSchema.safeParse({
      ...validConfig,
      limits: {
        ...validConfig.limits,
        maxRoute: "balanced",
        fallbackRoute: "hard"
      }
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["limits", "fallbackRoute"]);
  });
});
