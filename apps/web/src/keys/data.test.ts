import { describe, expect, it } from "vitest";

import { accessProfileSummaries } from "./data";

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
      gatewayLogicalModels: [
        { id: "economy-model", slug: "economy-auto", enabled: true }
      ]
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
