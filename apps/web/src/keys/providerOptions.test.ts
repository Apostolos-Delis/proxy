import { describe, expect, it } from "vitest";

import type { ProviderAccountSummary, ProviderName } from "../providers/data";
import { providerCredentialHint, providerIdsForRoutingConfig, providerOptionsForAccounts } from "./providerOptions";

function account(provider: ProviderName, overrides: Partial<ProviderAccountSummary> = {}): ProviderAccountSummary {
  return {
    id: `acct_${provider}`,
    organizationId: "org_1",
    provider,
    name: `${provider} credential`,
    authType: "api_key",
    status: "active",
    baseUrl: null,
    secretHint: "sk-...1234",
    ownerUserId: null,
    boundKeyCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    health: null,
    ...overrides
  };
}

describe("providerIdsForRoutingConfig", () => {
  it("returns each provider used by route targets in first-seen order", () => {
    expect(providerIdsForRoutingConfig({
      routes: [
        {
          targets: [
            { providerId: "openai" },
            { providerId: "anthropic" },
            { providerId: "openai" }
          ]
        },
        {
          targets: [
            { providerId: "acme-vllm" },
            { providerId: "   " }
          ]
        }
      ]
    })).toEqual(["openai", "anthropic", "acme-vllm"]);
  });
});

describe("providerCredentialHint", () => {
  it("labels API key and subscription credentials consistently", () => {
    expect(providerCredentialHint(account("openai"))).toBe("API key / sk-...1234");
    expect(providerCredentialHint(account("anthropic", { authType: "oauth", secretHint: null }))).toBe("subscription");
  });
});

describe("providerOptionsForAccounts", () => {
  it("prioritizes providers from the selected routing config", () => {
    expect(providerOptionsForAccounts(
      [account("acme-vllm")],
      { anthropic: null, openai: null },
      ["openai", "anthropic"]
    )).toEqual([
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic (Claude)" },
      { value: "acme-vllm", label: "acme-vllm" }
    ]);
  });

  it("keeps bound providers visible even if the selected config no longer uses them", () => {
    expect(providerOptionsForAccounts(
      [],
      { anthropic: "acct_anthropic", openai: null },
      ["openai"]
    )).toEqual([
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic (Claude)" }
    ]);
  });

  it("falls back to builtin providers when no routing config providers are known", () => {
    expect(providerOptionsForAccounts([], { anthropic: null, openai: null })).toEqual([
      { value: "anthropic", label: "Anthropic (Claude)" },
      { value: "openai", label: "OpenAI" }
    ]);
  });
});
