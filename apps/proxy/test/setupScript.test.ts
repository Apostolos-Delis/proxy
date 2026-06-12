import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(script).toContain("grep -Eq");
    expect(script).toContain('tmp_config="$(mktemp)"');
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

  it("selects and refreshes the Codex prompt_proxy provider for existing configs", () => {
    const home = mkdtempSync(join(tmpdir(), "prompt-proxy-setup-"));
    try {
      const codexDir = join(home, ".codex");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, "config.toml"), `# Existing Codex config
model = "gpt-5.5"

[features]
goals = true

[model_providers.prompt_proxy]
name = "Old Proxy"
base_url = "http://old-proxy/v1"
env_key = "OLD_PROMPT_PROXY_TOKEN"
`);
      writeFileSync(join(home, ".zshrc"), 'export PROMPT_PROXY_TOKEN="old-token"\n');

      const result = spawnSync("bash", ["-s", "--", "proxy-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: {
          ...process.env,
          HOME: home,
          PROMPT_PROXY_USER_ID: "dev@example.com",
          USER: "dev"
        }
      });

      expect(result.status).toBe(0);
      const config = readFileSync(join(codexDir, "config.toml"), "utf8");
      expect(config).toContain('model = "router-auto"');
      expect(config).toContain('model_provider = "prompt_proxy"');
      expect(config).toContain("[features]");
      expect(config).toContain("goals = true");
      expect(config).toContain('base_url = "https://proxy.example.com/v1"');
      expect(config).toContain('env_key = "PROMPT_PROXY_TOKEN"');
      expect(config).toContain('http_headers = { "x-prompt-proxy-user-id" = "dev@example.com" }');
      expect(config).not.toContain('model = "gpt-5.5"');
      expect(config).not.toContain("http://old-proxy/v1");
      expect(config).not.toContain("OLD_PROMPT_PROXY_TOKEN");
      const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
      expect(zshrc).toContain('export PROMPT_PROXY_TOKEN="$(cat ~/.prompt-proxy/token)"');
      expect(zshrc).not.toContain("old-token");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
