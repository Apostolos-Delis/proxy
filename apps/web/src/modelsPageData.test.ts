import { describe, expect, it } from "vitest";

import type { GatewayModelsQuery } from "./gql/graphql";
import {
  composeRouterInstructions,
  createModelBlocker,
  deploymentOptions,
  logicalModelCreateInput,
  logicalModelSummaries,
  routerDefaults,
  slugify
} from "./modelsPageData";

const data: GatewayModelsQuery = {
  gatewayLogicalModels: [
    {
      id: "lm-router",
      slug: "chat-auto",
      name: "Chat Auto",
      description: "Complexity routed",
      resolutionKind: "router",
      routerConfig: { classifierDeploymentId: "dep-nano", instructions: "policy", timeoutMs: 4000, maxAttempts: 2 },
      enabled: true
    },
    {
      id: "lm-direct",
      slug: "chat-frontier",
      name: "Chat Frontier",
      description: null,
      resolutionKind: "direct",
      routerConfig: {},
      enabled: true
    }
  ],
  gatewayLogicalModelTargets: [
    { id: "t-opus", logicalModelId: "lm-router", deploymentId: "dep-opus", priority: 0, enabled: true },
    { id: "t-terra", logicalModelId: "lm-router", deploymentId: "dep-terra", priority: 1, enabled: false },
    { id: "t-fable", logicalModelId: "lm-direct", deploymentId: "dep-fable", priority: 0, enabled: true }
  ],
  gatewayModelDeployments: [
    { id: "dep-opus", name: "Opus", upstreamModelId: "claude-opus-4-8", providerConnectionId: "conn-a" },
    { id: "dep-terra", name: "Terra", upstreamModelId: "gpt-5.6-terra", providerConnectionId: "conn-o" },
    { id: "dep-fable", name: "Fable", upstreamModelId: "claude-fable-5", providerConnectionId: "conn-a" },
    { id: "dep-nano", name: "Nano", upstreamModelId: "gpt-5.4-mini", providerConnectionId: "conn-o" }
  ],
  gatewayProviderConnections: [
    { id: "conn-a", name: "Anthropic", provider: "anthropic" },
    { id: "conn-o", name: "OpenAI", provider: "openai" }
  ],
  gatewayWireBindings: [
    { deploymentId: "dep-opus", apiWireId: "anthropic-messages", enabled: true },
    { deploymentId: "dep-terra", apiWireId: "openai-responses", enabled: true },
    { deploymentId: "dep-fable", apiWireId: "anthropic-messages", enabled: true },
    { deploymentId: "dep-nano", apiWireId: "openai-responses", enabled: true },
    { deploymentId: "dep-fable", apiWireId: "openai-chat", enabled: false }
  ],
  gatewayAccessProfiles: [
    { id: "profile-a", name: "Engineers", enabled: true },
    { id: "profile-off", name: "Disabled", enabled: false }
  ],
  gatewayModelGrants: [
    { accessProfileId: "profile-a", logicalModelId: "lm-router", enabled: true },
    { accessProfileId: "profile-off", logicalModelId: "lm-router", enabled: true },
    { accessProfileId: "profile-a", logicalModelId: "lm-direct", enabled: false }
  ],
  gatewayModelReadiness: {
    deployments: [
      { deploymentId: "dep-opus", available: true, classifierCapable: false, reasonCodes: [], classifierReasonCodes: ["classifier_wire_unavailable"] },
      { deploymentId: "dep-terra", available: true, classifierCapable: true, reasonCodes: [], classifierReasonCodes: [] },
      { deploymentId: "dep-fable", available: true, classifierCapable: false, reasonCodes: [], classifierReasonCodes: ["classifier_wire_unavailable"] },
      { deploymentId: "dep-nano", available: true, classifierCapable: true, reasonCodes: [], classifierReasonCodes: [] }
    ],
    logicalModels: [
      { logicalModelId: "lm-router", available: true, reasonCodes: [] },
      { logicalModelId: "lm-direct", available: true, reasonCodes: [] }
    ]
  }
};

describe("logicalModelSummaries", () => {
  it("joins targets, wires, classifier, and granting profiles per model", () => {
    const [auto, frontier] = logicalModelSummaries(data);
    expect(auto).toMatchObject({
      slug: "chat-auto",
      kind: "router",
      available: true,
      classifierDeployment: "Nano",
      routingPolicy: "policy",
      profiles: ["Engineers"]
    });
    expect(auto!.targets.map((target) => target.upstreamModelId)).toEqual(["claude-opus-4-8", "gpt-5.6-terra"]);
    // Disabled targets and disabled bindings stay out of the wire union.
    expect(auto!.wires).toEqual(["anthropic-messages"]);
    expect(frontier).toMatchObject({
      slug: "chat-frontier",
      kind: "direct",
      available: true,
      classifierDeployment: null,
      profiles: []
    });
    expect(frontier!.wires).toEqual(["anthropic-messages"]);
  });

  it("uses server readiness and preserves its reason codes", () => {
    const unavailableData = {
      ...data,
      gatewayLogicalModels: [
        ...data.gatewayLogicalModels,
        {
          id: "lm-empty",
          slug: "empty-auto",
          name: "Empty Auto",
          description: null,
          resolutionKind: "router",
          routerConfig: data.gatewayLogicalModels[0]!.routerConfig,
          enabled: true
        }
      ],
      gatewayModelReadiness: {
        deployments: data.gatewayModelReadiness.deployments.map((deployment) => (
          deployment.deploymentId === "dep-fable"
            ? { ...deployment, available: false, reasonCodes: ["canonical_model_disabled"] }
            : deployment
        )),
        logicalModels: [
          ...data.gatewayModelReadiness.logicalModels.map((model) => (
            model.logicalModelId === "lm-direct"
              ? { ...model, available: false, reasonCodes: ["target_unavailable"] }
              : model
          )),
          { logicalModelId: "lm-empty", available: false, reasonCodes: ["target_unavailable"] }
        ]
      }
    };
    const summaries = logicalModelSummaries(unavailableData);
    expect(summaries.find((model) => model.slug === "chat-frontier")).toMatchObject({
      available: false,
      reasonCodes: ["target_unavailable"],
      targets: [{ available: false, reasonCodes: ["canonical_model_disabled"] }]
    });
    expect(summaries.find((model) => model.slug === "empty-auto")?.available).toBe(false);
  });

  it("shows classifier instructions without parsing or truncating free-form text", () => {
    const instructions = "Consider these constraints:\nTargets:\nThis line is operator-authored.";
    const instructionData = {
      ...data,
      gatewayLogicalModels: data.gatewayLogicalModels.map((model) => (
        model.id === "lm-router"
          ? { ...model, routerConfig: { ...model.routerConfig as object, instructions } }
          : model
      ))
    };
    expect(logicalModelSummaries(instructionData)[0]?.routingPolicy).toBe(instructions);
  });
});

describe("deploymentOptions", () => {
  it("marks only responses-capable generic deployments as classifier hosts", () => {
    const options = deploymentOptions(data);
    const capable = Object.fromEntries(options.map((option) => [option.label, option.classifierCapable]));
    expect(capable).toEqual({ Fable: false, Nano: true, Opus: false, Terra: true });
  });

  it("omits deployments the server marks text-ineligible", () => {
    const unavailableDeployment = {
      ...data,
      gatewayModelReadiness: {
        ...data.gatewayModelReadiness,
        deployments: data.gatewayModelReadiness.deployments.map((deployment) => (
          deployment.deploymentId === "dep-fable"
            ? { ...deployment, available: false, reasonCodes: ["text_modality_unavailable"] }
            : deployment
        ))
      }
    };
    expect(deploymentOptions(unavailableDeployment).map((option) => option.label)).not.toContain("Fable");
  });
});

describe("routerDefaults", () => {
  it("copies classifier tuning from an existing router model", () => {
    expect(routerDefaults(data)).toEqual({ classifierDeploymentId: "dep-nano", timeoutMs: 4000, maxAttempts: 2 });
  });

  it("falls back when no router exists", () => {
    expect(routerDefaults({ ...data, gatewayLogicalModels: [] })).toEqual({
      classifierDeploymentId: null,
      timeoutMs: 4000,
      maxAttempts: 2
    });
  });
});

describe("composeRouterInstructions", () => {
  it("appends the target legend after the policy", () => {
    const instructions = composeRouterInstructions("Prefer cheap models.", [
      { targetId: "t-1", label: "Terra (gpt-5.6-terra · openai)" }
    ]);
    expect(instructions).toContain("Prefer cheap models.");
    expect(instructions).toContain("- t-1: Terra (gpt-5.6-terra · openai)");
  });

  it("rejects instructions over the server limit after adding the target legend", () => {
    expect(() => composeRouterInstructions("x".repeat(20_000), [
      { targetId: "t-1", label: "Terra" }
    ])).toThrow(/20,000/);
  });
});

describe("logicalModelCreateInput", () => {
  it("creates an active router and all targets in one mutation input", () => {
    const input = logicalModelCreateInput({
      slug: "chat-auto",
      name: "Chat Auto",
      description: "Complexity routed",
      kind: "router",
      deploymentIds: ["dep-opus", "dep-terra"],
      policy: "Use Terra for simple work and Opus for complex work.",
      classifierDeploymentId: "dep-nano"
    }, { classifierDeploymentId: "dep-nano", timeoutMs: 4_000, maxAttempts: 2 }, deploymentOptions(data), [
      "logical_target_00000000-0000-4000-8000-000000000001",
      "logical_target_00000000-0000-4000-8000-000000000002"
    ]);

    expect(input).toMatchObject({
      enabled: true,
      resolutionKind: "router",
      initialTargets: [
        { deploymentId: "dep-opus", priority: 0, enabled: true },
        { deploymentId: "dep-terra", priority: 1, enabled: true }
      ],
      routerConfig: {
        classifierDeploymentId: "dep-nano",
        timeoutMs: 4_000,
        maxAttempts: 2
      }
    });
    expect(input.resolutionKind).toBe("router");
    if (input.resolutionKind !== "router") throw new Error("expected router input");
    expect(input.routerConfig.instructions).toContain("logical_target_00000000-0000-4000-8000-000000000001");
    expect(input.routerConfig.instructions).toContain("gpt-5.6-terra");
  });
});

describe("createModelBlocker", () => {
  const base = {
    slug: "chat-auto",
    name: "Chat Auto",
    description: "",
    kind: "router" as const,
    deploymentIds: ["a", "b"],
    policy: "route",
    classifierDeploymentId: "dep-nano"
  };

  it("accepts a complete router draft", () => {
    expect(createModelBlocker(base)).toBeNull();
  });

  it("requires two router targets and a classifier", () => {
    expect(createModelBlocker({ ...base, deploymentIds: ["a"] })).toMatch(/two deployments/);
    expect(createModelBlocker({
      ...base,
      deploymentIds: Array.from({ length: 65 }, (_, index) => `deployment-${index}`)
    })).toMatch(/no more than 64/);
    expect(createModelBlocker({ ...base, classifierDeploymentId: "" })).toMatch(/classifier/);
  });

  it("requires exactly one direct deployment and a valid slug", () => {
    expect(createModelBlocker({ ...base, kind: "direct", deploymentIds: [] })).toMatch(/exactly one/);
    expect(createModelBlocker({ ...base, slug: "Bad Slug" })).toMatch(/Slug/);
  });
});

describe("slugify", () => {
  it("derives an API-safe slug from a display name", () => {
    expect(slugify("Chat Frontier v2!")).toBe("chat-frontier-v2");
    expect(slugify(`${"x".repeat(127)} y`).length).toBe(127);
  });
});
