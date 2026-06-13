import { describe, expect, it } from "vitest";

import {
  assertSafeDefaultHeaders,
  ProviderRegistryError,
  validateProviderBaseUrl
} from "../src/persistence/providers.js";

describe("provider registry guards", () => {
  it("rejects auth-bearing default headers", () => {
    expectProviderRegistryCode(
      () => assertSafeDefaultHeaders({ authorization: "Bearer secret" }),
      "provider_default_header_forbidden"
    );
    expectProviderRegistryCode(
      () => assertSafeDefaultHeaders({ "x-api-key": "secret" }),
      "provider_default_header_forbidden"
    );
    expect(() => assertSafeDefaultHeaders({ "anthropic-version": "2023-06-01" })).not.toThrow();
  });

  it("rejects unsupported upstream URL schemes", async () => {
    await expect(validateProviderBaseUrl("file:///tmp/socket", {
      allowedPrivateUpstreamCidrs: []
    })).rejects.toThrow("provider_base_url_scheme_forbidden");
  });

  it("blocks metadata and link-local upstream addresses unconditionally", async () => {
    await expect(validateProviderBaseUrl("http://169.254.169.254/latest", {
      allowedPrivateUpstreamCidrs: ["169.254.0.0/16"]
    })).rejects.toThrow("provider_base_url_blocked");
  });

  it("requires an allowlist for private upstream addresses", async () => {
    await expect(validateProviderBaseUrl("http://10.1.2.3:8000/v1", {
      allowedPrivateUpstreamCidrs: []
    })).rejects.toThrow("provider_base_url_private");

    await expect(validateProviderBaseUrl("http://10.1.2.3:8000/v1", {
      allowedPrivateUpstreamCidrs: ["10.0.0.0/8"]
    })).resolves.toBeUndefined();
  });
});

function expectProviderRegistryCode(fn: () => void, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRegistryError);
    expect((error as ProviderRegistryError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ProviderRegistryError ${code}`);
}
