import { describe, expect, it } from "vitest";

import { AdminAuthService } from "../src/adminAuth.js";
import { loadConfig } from "../src/config.js";

describe("security-sensitive config defaults", () => {
  it("disables debug endpoints when DATABASE_URL is configured unless explicitly enabled", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/prompt_proxy",
      PROMPT_PROXY_TOKEN: "prod-proxy-token"
    });

    expect(config.debugEndpointsEnabled).toBe(false);
  });

  it("disables local-only debug and proxy token fallbacks in production", () => {
    const config = loadConfig({
      NODE_ENV: "production"
    });

    expect(config.debugEndpointsEnabled).toBe(false);
    expect(config.allowDevProxyTokenFallback).toBe(false);
    expect(config.adminGraphiqlEnabled).toBe(false);
  });

  it("rejects debug endpoints with DATABASE_URL and the default proxy token", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/prompt_proxy",
      DEBUG_ENDPOINTS_ENABLED: "true"
    })).toThrow("PROMPT_PROXY_TOKEN must be set before enabling debug endpoints in production.");
  });

  it("rejects dev login with DATABASE_URL and the default password", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://user:pass@localhost:5432/prompt_proxy",
      PROMPT_PROXY_TOKEN: "prod-proxy-token",
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
