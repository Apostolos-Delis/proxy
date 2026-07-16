import { describe, expect, it } from "vitest";

import { providerModelCatalogSchema } from "./index.js";

const entry = {
  provider: "anthropic",
  upstreamModelId: "claude-example",
  canonical: {
    key: "claude-example",
    slug: "claude-example",
    name: "Claude Example",
    vendor: "anthropic",
    family: "claude-example",
    capabilities: { contextWindow: 200_000 }
  },
  dialects: ["anthropic-messages"],
  capabilities: {},
  pricing: { inputCostPerMtok: 1, outputCostPerMtok: 5 },
  metadataSourceId: "provider-docs",
  pricingSourceId: "provider-docs"
} as const;

describe("provider model catalog", () => {
  it("accepts entries with explicit metadata and pricing provenance", () => {
    const result = providerModelCatalogSchema.parse({
      sources: {
        "provider-docs": {
          type: "provider-documentation",
          locator: "https://provider.test/models/claude-example",
          verifiedAt: "2026-07-16T00:00:00.000Z"
        }
      },
      entries: [entry]
    });

    expect(result.entries[0]?.canonical.slug).toBe("claude-example");
  });

  it("rejects unknown sources and duplicate provider model entries", () => {
    const result = providerModelCatalogSchema.safeParse({
      sources: {},
      entries: [entry, entry]
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "Unknown model catalog source provider-docs.",
      "Duplicate provider model catalog entry anthropic:claude-example:."
    ]));
  });

  it("rejects conflicting canonical metadata across providers", () => {
    const result = providerModelCatalogSchema.safeParse({
      sources: {
        "provider-docs": {
          type: "provider-documentation",
          locator: "https://provider.test/models/claude-example"
        }
      },
      entries: [
        entry,
        {
          ...entry,
          provider: "amazon-bedrock",
          upstreamModelId: "anthropic.claude-example",
          dialects: ["bedrock-converse"],
          canonical: {
            ...entry.canonical,
            capabilities: { contextWindow: 100_000 }
          }
        }
      ]
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "Conflicting canonical model metadata for anthropic:claude-example."
    );
  });
});
