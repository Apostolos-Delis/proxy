import { ANTHROPIC_PROVIDER_CACHING_CAPABILITIES } from "@proxy/schema";
import { describe, expect, it } from "vitest";

import {
  rewriteSurfaceRequestWithPromptCachePlan,
  rewriteTokenCountRequestWithPromptCachePlan
} from "../src/adapters.js";
import type { PromptCachePlan, PromptCachePlanSettings } from "../src/promptCachePlan.js";
import type { RouteDecision, Surface } from "../src/types.js";

const largeText = "x".repeat(8192);

function anthropicDecision(surface: Surface = "anthropic-messages"): RouteDecision {
  return {
    outcome: "forward",
    finalRoute: "hard",
    selectedModel: "claude-opus-4-8",
    surface,
    provider: "anthropic",
    deployment: {
      key: "test-anthropic",
      provider: "anthropic",
      model: "claude-opus-4-8",
      order: 0,
      weight: 1,
      timeoutMs: 60000
    },
    providerSettings: {
      provider: "anthropic",
      model: "claude-opus-4-8",
      dialect: "anthropic-messages",
      deployment: {
        key: "test-anthropic",
        provider: "anthropic",
        model: "claude-opus-4-8",
        order: 0,
        weight: 1,
        timeoutMs: 60000
      },
      anthropic: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        order: 0,
        weight: 1,
        timeoutMs: 60000
      }
    },
    guardrailActions: [],
    reasonCodes: [],
    policyVersion: "test"
  };
}

type GoldenCase = {
  name: string;
  surface?: Surface;
  body: unknown;
  settings: PromptCachePlanSettings;
  expectedPlan: PromptCachePlan;
  expectedForwardedBody: unknown;
  expectedTokenCountBody?: unknown;
};

const multiTurnMessages = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "follow-up" }
];

const translatedMultiTurnMessages = [
  { role: "user", content: [{ type: "text", text: "first question" }] },
  { role: "assistant", content: [{ type: "text", text: "first answer" }] },
  { role: "user", content: [{ type: "text", text: "follow-up" }] }
];

const largeMultiTurnMessages = [
  { role: "user", content: "first question" },
  { role: "assistant", content: largeText },
  { role: "user", content: "follow-up" }
];

const goldenCases: GoldenCase[] = [
  {
    name: "client system breakpoint upgrades to ttl:1h",
    body: {
      model: "claude-router-hard",
      max_tokens: 256,
      system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral" } }],
      messages: multiTurnMessages
    },
    settings: { automaticCaching: true, cacheTtlUpgrade: true },
    expectedPlan: {
      mode: "explicit",
      provider: "anthropic",
      dialect: "anthropic-messages",
      breakpointStrategy: "preserve_client",
      appliedControls: ["client_breakpoints_preserved", "ttl_1h"],
      skippedControls: []
    },
    expectedForwardedBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: multiTurnMessages
    },
    expectedTokenCountBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: multiTurnMessages
    }
  },
  {
    name: "nested tool-result breakpoint upgrades without duplicate markers",
    body: {
      model: "claude-router-hard",
      max_tokens: 256,
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: largeText },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "output", cache_control: { type: "ephemeral" } }]
            }
          ]
        }
      ]
    },
    settings: { automaticCaching: true, cacheTtlUpgrade: true },
    expectedPlan: {
      mode: "explicit",
      provider: "anthropic",
      dialect: "anthropic-messages",
      breakpointStrategy: "preserve_client",
      appliedControls: ["client_breakpoints_preserved", "ttl_1h"],
      skippedControls: []
    },
    expectedForwardedBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: largeText },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "output", cache_control: { type: "ephemeral", ttl: "1h" } }]
            }
          ]
        }
      ]
    },
    expectedTokenCountBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: largeText },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "output", cache_control: { type: "ephemeral", ttl: "1h" } }]
            }
          ]
        }
      ]
    }
  },
  {
    name: "tool-definition breakpoint preserves longer-TTL ordering",
    body: {
      model: "claude-router-hard",
      max_tokens: 256,
      tools: [
        { name: "get_weather", input_schema: { type: "object" } },
        { name: "get_time", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }
      ],
      system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral" } }],
      messages: multiTurnMessages
    },
    settings: { automaticCaching: true, cacheTtlUpgrade: true },
    expectedPlan: {
      mode: "explicit",
      provider: "anthropic",
      dialect: "anthropic-messages",
      breakpointStrategy: "preserve_client",
      appliedControls: ["client_breakpoints_preserved", "ttl_1h"],
      skippedControls: []
    },
    expectedForwardedBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      tools: [
        { name: "get_weather", input_schema: { type: "object" } },
        { name: "get_time", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }
      ],
      system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: multiTurnMessages
    },
    expectedTokenCountBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      tools: [
        { name: "get_weather", input_schema: { type: "object" } },
        { name: "get_time", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }
      ],
      system: [{ type: "text", text: largeText, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: multiTurnMessages
    }
  },
  {
    name: "disabled settings leave multi-turn requests unmodified",
    body: {
      model: "claude-router-hard",
      max_tokens: 256,
      messages: multiTurnMessages
    },
    settings: { automaticCaching: false, cacheTtlUpgrade: false },
    expectedPlan: {
      mode: "observe",
      provider: "anthropic",
      dialect: "anthropic-messages",
      appliedControls: [],
      skippedControls: [{ control: "top_level_auto_breakpoint", reason: "setting_disabled" }]
    },
    expectedForwardedBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      messages: multiTurnMessages
    }
  },
  {
    name: "small automatic request gets default top-level breakpoint only",
    body: {
      model: "claude-router-hard",
      max_tokens: 256,
      messages: multiTurnMessages
    },
    settings: { automaticCaching: true, cacheTtlUpgrade: true },
    expectedPlan: {
      mode: "explicit",
      provider: "anthropic",
      dialect: "anthropic-messages",
      breakpointStrategy: "top_level_auto",
      appliedControls: ["top_level_auto_breakpoint"],
      skippedControls: [{ control: "ttl_1h", reason: "not_eligible" }]
    },
    expectedForwardedBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      messages: multiTurnMessages,
      cache_control: { type: "ephemeral" }
    }
  },
  {
    name: "one-shot requests skip automatic caching and ttl upgrade",
    body: {
      model: "claude-router-hard",
      max_tokens: 256,
      messages: [{ role: "user", content: largeText }]
    },
    settings: { automaticCaching: true, cacheTtlUpgrade: true },
    expectedPlan: {
      mode: "observe",
      provider: "anthropic",
      dialect: "anthropic-messages",
      appliedControls: [],
      skippedControls: [
        { control: "top_level_auto_breakpoint", reason: "not_multi_turn_or_no_cacheable_target" },
        { control: "ttl_1h", reason: "not_eligible" }
      ]
    },
    expectedForwardedBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      messages: [{ role: "user", content: largeText }]
    }
  },
  {
    name: "large automatic multi-turn request upgrades the injected breakpoint",
    body: {
      model: "claude-router-hard",
      max_tokens: 256,
      messages: largeMultiTurnMessages
    },
    settings: { automaticCaching: true, cacheTtlUpgrade: true },
    expectedPlan: {
      mode: "explicit",
      provider: "anthropic",
      dialect: "anthropic-messages",
      breakpointStrategy: "top_level_auto",
      appliedControls: ["top_level_auto_breakpoint", "ttl_1h"],
      skippedControls: []
    },
    expectedForwardedBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      messages: largeMultiTurnMessages,
      cache_control: { type: "ephemeral", ttl: "1h" }
    }
  },
  {
    name: "translated OpenAI cache fields are dropped and reported",
    surface: "openai-chat",
    body: {
      model: "router-hard",
      max_completion_tokens: 256,
      prompt_cache_key: "raw-cache-key",
      prompt_cache_retention: "24h",
      messages: multiTurnMessages
    },
    settings: { automaticCaching: true, cacheTtlUpgrade: true },
    expectedPlan: {
      mode: "explicit",
      provider: "anthropic",
      dialect: "anthropic-messages",
      breakpointStrategy: "top_level_auto",
      appliedControls: ["top_level_auto_breakpoint"],
      skippedControls: [
        { control: "ttl_1h", reason: "not_eligible" },
        { control: "cache_key_preserved", reason: "translated_request" },
        { control: "retention_preserved", reason: "translated_request" },
        { control: "cross_dialect_cache_fields", reason: "translated_request" }
      ]
    },
    expectedForwardedBody: {
      model: "claude-opus-4-8",
      max_tokens: 256,
      messages: translatedMultiTurnMessages,
      tool_choice: undefined,
      cache_control: { type: "ephemeral" }
    }
  }
];

describe("Anthropic prompt-cache plan goldens", () => {
  for (const fixture of goldenCases) {
    it(fixture.name, () => {
      const decision = anthropicDecision(fixture.surface ?? "anthropic-messages");
      const rewritten = rewriteSurfaceRequestWithPromptCachePlan(fixture.body, decision, undefined, {
        context: { surface: fixture.surface ?? "anthropic-messages" },
        capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
        settings: fixture.settings
      });

      expect(rewritten.promptCachePlan).toEqual(fixture.expectedPlan);
      expect(rewritten.body).toEqual(fixture.expectedForwardedBody);

      if (fixture.expectedTokenCountBody) {
        const count = rewriteTokenCountRequestWithPromptCachePlan(fixture.body, decision, undefined, {
          context: { surface: fixture.surface ?? "anthropic-messages" },
          capabilities: ANTHROPIC_PROVIDER_CACHING_CAPABILITIES,
          settings: fixture.settings
        });
        expect(count.promptCachePlan).toEqual(fixture.expectedPlan);
        expect(count.body).toEqual(fixture.expectedTokenCountBody);
      }
    });
  }
});
