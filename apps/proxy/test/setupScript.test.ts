import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { buildSetupScript } from "../src/setupScript.js";

function testEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    EVENT_STORE_PATH: "",
    PROMPT_PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    ...overrides
  };
}

describe("buildSetupScript", () => {
  it("reads the key from the argument or environment, never embedding a secret", () => {
    const script = buildSetupScript("https://proxy.example.com");
    expect(script).toContain('PP_TOKEN="${1:-${PROMPT_PROXY_TOKEN:-}}"');
    expect(script).toContain("read -r PP_TOKEN < /dev/tty");
  });

  it("targets the requested base URL for Claude Code and Codex", () => {
    const script = buildSetupScript("https://proxy.example.com");
    expect(script).toContain('PP_BASE_URL="https://proxy.example.com"');
    expect(script).toContain('base_url = "$PP_BASE_URL/v1"');
  });

  it("keeps the idempotency and permission guards", () => {
    const script = buildSetupScript("https://proxy.example.com");
    expect(script).toContain('grep -q "PROMPT_PROXY_TOKEN"');
    expect(script).toContain('grep -qF "[model_providers.prompt_proxy]"');
    expect(script).toContain('chmod 600 "$HOME/.prompt-proxy/token"');
  });

  it("escapes bash-special characters in the base URL", () => {
    const script = buildSetupScript("http://proxy/$path");
    expect(script).toContain('PP_BASE_URL="http://proxy/\\$path"');
  });

  it("derives the attribution identity from git email then $USER, overridable", () => {
    const script = buildSetupScript("https://proxy.example.com");
    expect(script).toContain('PP_USER_ID="${PROMPT_PROXY_USER_ID:-}"');
    expect(script).toContain('PP_USER_ID="$(git config --get user.email 2>/dev/null || true)"');
    expect(script).toContain('PP_USER_ID="${USER:-}"');
  });

  it("stamps x-prompt-proxy-user-id into both Claude Code and Codex config", () => {
    const script = buildSetupScript("https://proxy.example.com");
    // Claude Code via ANTHROPIC_CUSTOM_HEADERS, only when an id was resolved.
    expect(script).toContain('settings.env.ANTHROPIC_CUSTOM_HEADERS = "x-prompt-proxy-user-id: " + process.argv[2]');
    expect(script).toContain('" "$PP_USER_ID"');
    // Codex via the provider http_headers map.
    expect(script).toContain('PP_CODEX_HEADERS="http_headers = { \\"x-prompt-proxy-user-id\\" = \\"$PP_USER_ID\\" }"');
    expect(script).toContain("$PP_CODEX_HEADERS");
  });

  it("is valid bash", () => {
    const result = spawnSync("bash", ["-n"], { input: buildSetupScript("https://proxy.example.com") });
    expect(result.status).toBe(0);
  });
});

describe("GET /setup.sh", () => {
  it("serves the script for the requesting host without auth", async () => {
    const app = buildServer(loadConfig(testEnv()));
    const response = await app.inject({
      method: "GET",
      url: "/setup.sh",
      headers: { host: "127.0.0.1:8787" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain('PP_BASE_URL="http://127.0.0.1:8787"');
    await app.close();
  });

  it("honors forwarded proto and host from a reverse proxy", async () => {
    const app = buildServer(loadConfig(testEnv()));
    const response = await app.inject({
      method: "GET",
      url: "/setup.sh",
      headers: {
        host: "10.0.0.5:8787",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "proxy.example.com"
      }
    });
    expect(response.body).toContain('PP_BASE_URL="https://proxy.example.com"');
    await app.close();
  });
});
