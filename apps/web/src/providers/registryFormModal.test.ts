import { describe, expect, it } from "vitest";

import type { ProviderInput, ProviderRegistrySummary } from "./data";
import { providerFormStateFromProvider, providerUpdateInput } from "./registryFormModal";

describe("providerUpdateInput", () => {
  it("does not pass create-only fields to the update mutation", () => {
    const input: ProviderInput = {
      slug: "coreweave",
      displayName: "Coreweave",
      baseUrl: "https://www.coreweave.com",
      authStyle: "bearer",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      defaultHeaders: {},
      capabilities: {},
      forwardHarnessHeaders: false,
      enabled: false
    };

    const result = providerUpdateInput(input, "provider_1");

    expect(Object.prototype.hasOwnProperty.call(result, "slug")).toBe(false);
    expect(result).toEqual({
      providerId: "provider_1",
      displayName: "Coreweave",
      baseUrl: "https://www.coreweave.com",
      authStyle: "bearer",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      defaultHeaders: {},
      capabilities: {},
      forwardHarnessHeaders: false,
      enabled: false
    });
  });
});

describe("providerFormStateFromProvider", () => {
  it("defaults disabled provider edits to enabled so saving restores them", () => {
    const form = providerFormStateFromProvider(provider({ enabled: false }));

    expect(form.enabled).toBe(true);
  });
});

function provider(overrides: Partial<ProviderRegistrySummary> = {}): ProviderRegistrySummary {
  return {
    id: "provider_1",
    organizationId: "org_1",
    slug: "coreweave",
    displayName: "Coreweave",
    baseUrl: "https://www.coreweave.com",
    authStyle: "bearer",
    endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
    defaultHeaders: {},
    capabilities: {},
    forwardHarnessHeaders: false,
    enabled: true,
    builtin: false,
    ...overrides
  };
}
