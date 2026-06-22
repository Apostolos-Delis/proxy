import { describe, expect, it } from "vitest";

import { AdminAuthService } from "../src/adminAuth.js";
import { loadConfig } from "../src/config.js";

const productionSecrets = {
  PROMPT_PROXY_TOKEN: "prod-proxy-token",
  OPENAI_API_KEY: "prod-openai-key",
  ANTHROPIC_API_KEY: "prod-anthropic-key"
};

describe("security-sensitive config defaults", () => {
  it("disables debug endpoints when DATABASE_URL is configured unless explicitly enabled", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/prompt_proxy",
      ...productionSecrets
    });

    expect(config.debugEndpointsEnabled).toBe(false);
  });

  it("disables local-only debug and proxy token fallbacks in production", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      ...productionSecrets
    });

    expect(config.debugEndpointsEnabled).toBe(false);
    expect(config.allowDevProxyTokenFallback).toBe(false);
    expect(config.adminGraphiqlEnabled).toBe(false);
  });

  it("rejects the default proxy token in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/prompt_proxy",
      OPENAI_API_KEY: "prod-openai-key",
      ANTHROPIC_API_KEY: "prod-anthropic-key"
    })).toThrow("PROMPT_PROXY_TOKEN must be changed in production.");
  });

  it("rejects default upstream provider keys in production", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      PROMPT_PROXY_TOKEN: "prod-proxy-token",
      ANTHROPIC_API_KEY: "prod-anthropic-key"
    })).toThrow("OPENAI_API_KEY must be set in production.");

    expect(() => loadConfig({
      NODE_ENV: "production",
      PROMPT_PROXY_TOKEN: "prod-proxy-token",
      OPENAI_API_KEY: "prod-openai-key"
    })).toThrow("ANTHROPIC_API_KEY must be set in production.");
  });

  it("rejects dev login with DATABASE_URL and the default password", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/prompt_proxy",
      ...productionSecrets,
      ADMIN_DEV_LOGIN_ENABLED: "true"
    })).toThrow("ADMIN_DEV_LOGIN_PASSWORD must be changed before enabling dev login with DATABASE_URL.");
  });

  it("marks admin session cookies secure for HTTPS console URLs", () => {
    const config = loadConfig({
      ADMIN_CONSOLE_URL: "https://console.example.com"
    });
    const auth = new AdminAuthService(config);

    expect(auth.sessionCookie("session-token", new Date("2030-01-01T00:00:00Z"))).toContain("; Secure;");
    expect(auth.clearCookie()).toContain("; Secure;");
  });
});
