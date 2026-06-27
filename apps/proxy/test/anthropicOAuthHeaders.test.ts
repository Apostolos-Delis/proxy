import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { ProviderRegistryEndpoint, ProviderRegistryEntry } from "../src/persistence/providers.js";
import { providerRequestHeaders } from "../src/providerAdapters/genericHttp.js";
import type { UpstreamCredential } from "../src/types.js";

const anthropicEndpoint: ProviderRegistryEndpoint = { dialect: "anthropic-messages", path: "/v1/messages" };

const anthropicProvider: ProviderRegistryEntry = {
  id: "provider_anthropic",
  organizationId: null,
  slug: "anthropic",
  baseUrl: "https://api.anthropic.com",
  adapterKind: "generic-http-json",
  adapterConfig: {},
  authStyle: "x-api-key",
  endpoints: [anthropicEndpoint],
  defaultHeaders: {},
  capabilities: {},
  forwardHarnessHeaders: true,
  enabled: true,
  builtin: true
};

const oauthCredential: UpstreamCredential = {
  provider: "anthropic",
  token: "oauth-token-xyz",
  providerAccountId: "acct_1",
  authType: "oauth"
};

const apiKeyCredential: UpstreamCredential = {
  provider: "anthropic",
  token: "sk-ant-api-key",
  providerAccountId: "acct_2",
  authType: "api_key"
};

function headersFor(input: {
  credential?: UpstreamCredential;
  subscriptionOAuthEnabled?: boolean;
  noOperatorKey?: boolean;
  incoming?: Record<string, string | undefined>;
}) {
  const config = {
    anthropicApiKey: input.noOperatorKey ? undefined : "operator-anthropic-key",
    subscriptionOAuthEnabled: input.subscriptionOAuthEnabled ?? true
  } as AppConfig;
  return providerRequestHeaders({
    config,
    provider: anthropicProvider,
    endpoint: anthropicEndpoint,
    surface: "anthropic-messages",
    body: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] },
    incoming: input.incoming ?? {},
    credential: input.credential
  });
}

describe("anthropic subscription OAuth headers", () => {
  it("injects the oauth beta flag for translated harnesses that send no anthropic-beta", () => {
    const headers = headersFor({ credential: oauthCredential });
    expect(headers.authorization).toBe("Bearer oauth-token-xyz");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("merges the oauth beta flag with Claude Code's existing anthropic-beta values", () => {
    const headers = headersFor({
      credential: oauthCredential,
      incoming: { "anthropic-beta": "claude-code-20250219,fine-grained-tool-streaming-2025-05-14" }
    });
    expect(headers["anthropic-beta"]).toBe(
      "claude-code-20250219,fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20"
    );
  });

  it("does not duplicate the oauth beta flag when it is already present", () => {
    const headers = headersFor({
      credential: oauthCredential,
      incoming: { "anthropic-beta": "oauth-2025-04-20" }
    });
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("trims surrounding whitespace when merging anthropic-beta values", () => {
    const headers = headersFor({
      credential: oauthCredential,
      incoming: { "anthropic-beta": " oauth-2025-04-20 , claude-code-20250219 " }
    });
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20,claude-code-20250219");
  });

  it("authenticates a subscription-only setup that has no operator API key configured", () => {
    const headers = headersFor({ credential: oauthCredential, noOperatorKey: true });
    expect(headers.authorization).toBe("Bearer oauth-token-xyz");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("leaves the api-key path untouched (no oauth beta flag)", () => {
    const headers = headersFor({ credential: apiKeyCredential });
    expect(headers["x-api-key"]).toBe("sk-ant-api-key");
    expect(headers.authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  it("does not add the oauth beta flag when subscription OAuth is disabled", () => {
    const headers = headersFor({ credential: oauthCredential, subscriptionOAuthEnabled: false });
    expect(headers["x-api-key"]).toBe("operator-anthropic-key");
    expect(headers.authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});
