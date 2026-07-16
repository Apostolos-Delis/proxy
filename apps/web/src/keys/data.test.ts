import { describe, expect, it } from "vitest";

import { accessProfileSummaries, logicalModelOptions, setupModelForSlugs } from "./data";

const logicalModels = [
  {
    id: "economy-model",
    slug: "economy-auto",
    name: "Economy Auto",
    description: "Cheapest routing",
    resolutionKind: "router",
    enabled: true
  },
  {
    id: "frontier-model",
    slug: "chat-frontier",
    name: "Chat Frontier",
    description: null,
    resolutionKind: "direct",
    enabled: false
  }
];

describe("access profile setup summaries", () => {
  it("excludes profiles that cannot list the model used by generated setup", () => {
    const profiles = accessProfileSummaries({
      gatewayAccessProfiles: [
        {
          id: "generate-only",
          slug: "generate-only",
          name: "Generate only",
          description: null,
          enabled: true
        },
        {
          id: "setup-ready",
          slug: "setup-ready",
          name: "Setup ready",
          description: null,
          enabled: true
        }
      ],
      gatewayModelGrants: [
        {
          accessProfileId: "generate-only",
          logicalModelId: "economy-model",
          allowedOperations: ["text.generate"],
          enabled: true
        },
        {
          accessProfileId: "setup-ready",
          logicalModelId: "economy-model",
          allowedOperations: ["text.generate", "model.list"],
          enabled: true
        }
      ],
      gatewayLogicalModels: logicalModels
    });

    expect(profiles).toEqual([{
      id: "setup-ready",
      slug: "setup-ready",
      name: "Setup ready",
      description: null,
      setupModel: "economy-auto"
    }]);
  });
});

describe("logicalModelOptions", () => {
  it("returns enabled models sorted by slug", () => {
    const options = logicalModelOptions({
      gatewayAccessProfiles: [],
      gatewayModelGrants: [],
      gatewayLogicalModels: logicalModels
    });
    expect(options).toEqual([{
      id: "economy-model",
      slug: "economy-auto",
      name: "Economy Auto",
      description: "Cheapest routing",
      kind: "router"
    }]);
  });

  it("omits models without a statically available route", () => {
    const options = logicalModelOptions({
      gatewayAccessProfiles: [],
      gatewayModelGrants: [],
      gatewayLogicalModels: logicalModels
    }, new Set());
    expect(options).toEqual([]);
  });
});

describe("setupModelForSlugs", () => {
  it("prefers the well-known setup models, then falls back to the first grant", () => {
    expect(setupModelForSlugs(["fable", "coding-auto"])).toBe("coding-auto");
    expect(setupModelForSlugs(["chat-frontier", "chat-auto"])).toBe("chat-frontier");
    expect(setupModelForSlugs([])).toBeNull();
  });
});
