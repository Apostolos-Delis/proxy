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
    expect(script).toContain('PP_TOKEN="${PROMPT_PROXY_TOKEN:-}"');
    expect(script).toContain('PP_HARNESSES="$PP_HARNESSES ${2:-}"');
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
    expect(script).toContain('chmod 600 "$PP_TOKEN_PATH"');
  });

  it("escapes bash-special characters in the base URL", () => {
    const script = buildSetupScript("http://proxy/$path");
    expect(script).toContain('PP_BASE_URL="http://proxy/\\$path"');
  });

  it("does not derive per-request attribution identity", () => {
    const script = buildSetupScript("https://proxy.example.com");
    expect(script).not.toContain("PROMPT_PROXY_USER_ID");
    expect(script).not.toContain('settings.env.ANTHROPIC_CUSTOM_HEADERS = "x-prompt-proxy-user-id: "');
    expect(script).not.toContain("PP_CODEX_HEADERS");
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
      expect(config).not.toContain("http_headers");
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

  it("configures a Codex-specific key without changing Claude Code", () => {
    const home = mkdtempSync(join(tmpdir(), "prompt-proxy-setup-codex-"));
    try {
      writeFileSync(join(home, ".zshrc"), 'export PROMPT_PROXY_CODEX_TOKEN="old-token"\n');

      const result = spawnSync("bash", ["-s", "--", "--harness", "codex", "codex-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: {
          ...process.env,
          HOME: home,
          PROMPT_PROXY_USER_ID: "codex@example.com",
          USER: "dev"
        }
      });

      expect(result.status).toBe(0);
      expect(readFileSync(join(home, ".prompt-proxy", "codex.token"), "utf8")).toBe("codex-token\n");
      const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      expect(config).toContain('model_provider = "prompt_proxy_codex"');
      expect(config).toContain("[model_providers.prompt_proxy_codex]");
      expect(config).toContain('env_key = "PROMPT_PROXY_CODEX_TOKEN"');
      expect(config).not.toContain("http_headers");
      const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
      expect(zshrc).toContain('export PROMPT_PROXY_CODEX_TOKEN="$(cat ~/.prompt-proxy/codex.token)"');
      expect(zshrc).not.toContain("old-token");
      expect(spawnSync("test", ["!", "-e", join(home, ".claude", "settings.json")]).status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("configures a Claude Code-specific key without changing Codex", () => {
    const home = mkdtempSync(join(tmpdir(), "prompt-proxy-setup-claude-"));
    try {
      const result = spawnSync("bash", ["-s", "--", "--harness=claude-code", "claude-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: {
          ...process.env,
          HOME: home,
          PROMPT_PROXY_USER_ID: "claude@example.com",
          USER: "dev"
        }
      });

      expect(result.status).toBe(0);
      expect(readFileSync(join(home, ".prompt-proxy", "claude-code.token"), "utf8")).toBe("claude-token\n");
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      expect(settings.apiKeyHelper).toBe("cat ~/.prompt-proxy/claude-code.token");
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://proxy.example.com");
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      expect(spawnSync("test", ["!", "-e", join(home, ".codex", "config.toml")]).status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removes only the old Prompt Proxy identity header from Claude Code settings", () => {
    const home = mkdtempSync(join(tmpdir(), "prompt-proxy-setup-claude-headers-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
        env: { ANTHROPIC_CUSTOM_HEADERS: "x-prompt-proxy-user-id: old@example.com" }
      }));

      const result = spawnSync("bash", ["-s", "--", "--harness=claude-code", "claude-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: { ...process.env, HOME: home }
      });
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

      expect(result.status).toBe(0);
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves unrelated Claude Code custom headers", () => {
    const home = mkdtempSync(join(tmpdir(), "prompt-proxy-setup-claude-headers-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
        env: { ANTHROPIC_CUSTOM_HEADERS: "x-trace-id: keep" }
      }));

      const result = spawnSync("bash", ["-s", "--", "--harness=claude-code", "claude-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: { ...process.env, HOME: home }
      });
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

      expect(result.status).toBe(0);
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-trace-id: keep");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removes only the Prompt Proxy identity header from mixed Claude Code custom headers", () => {
    const home = mkdtempSync(join(tmpdir(), "prompt-proxy-setup-claude-headers-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
        env: { ANTHROPIC_CUSTOM_HEADERS: "x-trace-id: keep, x-prompt-proxy-user-id: old@example.com, x-debug: yes" }
      }));

      const result = spawnSync("bash", ["-s", "--", "--harness=claude-code", "claude-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: { ...process.env, HOME: home }
      });
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

      expect(result.status).toBe(0);
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-trace-id: keep, x-debug: yes");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("configures opencode global config and credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "prompt-proxy-setup-opencode-"));
    const xdgConfig = join(home, "xdg-config");
    const xdgData = join(home, "xdg-data");
    try {
      const result = spawnSync("bash", ["-s", "--", "--harness", "opencode", "open-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
          USER: "dev"
        }
      });

      expect(result.status).toBe(0);
      expect(readFileSync(join(home, ".prompt-proxy", "opencode.token"), "utf8")).toBe("open-token\n");
      const config = JSON.parse(readFileSync(join(xdgConfig, "opencode", "opencode.json"), "utf8"));
      expect(config.provider["prompt-proxy-chat"].npm).toBe("@ai-sdk/openai-compatible");
      expect(config.provider["prompt-proxy-chat"].options.baseURL).toBe("https://proxy.example.com/v1");
      expect(config.model).toBe("prompt-proxy-chat/router-auto");
      const auth = JSON.parse(readFileSync(join(xdgData, "opencode", "auth.json"), "utf8"));
      expect(auth["prompt-proxy-chat"]).toEqual({ type: "api", key: "open-token" });
      expect(spawnSync("test", ["!", "-e", join(home, ".codex", "config.toml")]).status).toBe(0);
      expect(spawnSync("test", ["!", "-e", join(home, ".claude", "settings.json")]).status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("configures multiple selected harnesses with one shared key", () => {
    const home = mkdtempSync(join(tmpdir(), "prompt-proxy-setup-multi-"));
    const xdgConfig = join(home, "xdg-config");
    const xdgData = join(home, "xdg-data");
    try {
      const result = spawnSync("bash", ["-s", "--", "--harness", "claude-code", "--harness", "codex", "--harness", "opencode", "multi-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
          USER: "dev"
        }
      });

      expect(result.status).toBe(0);
      expect(readFileSync(join(home, ".prompt-proxy", "token"), "utf8")).toBe("multi-token\n");
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      expect(settings.apiKeyHelper).toBe("cat ~/.prompt-proxy/token");
      const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      expect(codexConfig).toContain('model_provider = "prompt_proxy"');
      expect(codexConfig).toContain('env_key = "PROMPT_PROXY_TOKEN"');
      const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
      expect(zshrc).toContain('export PROMPT_PROXY_TOKEN="$(cat ~/.prompt-proxy/token)"');
      const opencodeAuth = JSON.parse(readFileSync(join(xdgData, "opencode", "auth.json"), "utf8"));
      expect(opencodeAuth["prompt-proxy-chat"]).toEqual({ type: "api", key: "multi-token" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an empty explicit harness instead of falling back to defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "prompt-proxy-setup-empty-harness-"));
    try {
      const result = spawnSync("bash", ["-s", "--", "--harness=", "token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: { ...process.env, HOME: home }
      });

      expect(result.status).toBe(1);
      expect(result.stderr.toString()).toContain("Pick at least one harness");
      expect(spawnSync("test", ["!", "-e", join(home, ".claude", "settings.json")]).status).toBe(0);
      expect(spawnSync("test", ["!", "-e", join(home, ".codex", "config.toml")]).status).toBe(0);
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
