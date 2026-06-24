import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    ...overrides
  };
}

describe("buildSetupScript", () => {
  it("reads the key from the argument or environment, never embedding a secret", () => {
    const script = buildSetupScript("https://proxy.example.com");
    expect(script).toContain('PP_TOKEN="${PROXY_TOKEN:-}"');
    expect(script).toContain('PP_HARNESSES="$PP_HARNESSES ${2:-}"');
    expect(script).toContain("read -r PP_TOKEN < /dev/tty");
    expect(script).toContain('"$PP_BASE_URL" "$PP_TOKEN_PATH" "$PP_OPENCODE_CONFIG_MARKER_FILE"');
    expect(script).not.toContain('"$PP_BASE_URL" "$PP_TOKEN" "$PP_OPENCODE_CONFIG_MARKER_FILE"');
    expect(script).not.toContain("const token = process.argv[4];");
  });

  it("targets the requested base URL for Claude Code and Codex", () => {
    const script = buildSetupScript("https://proxy.example.com");
    expect(script).toContain('PP_BASE_URL="https://proxy.example.com"');
    expect(script).toContain('base_url = "$PP_BASE_URL/v1"');
  });

  it("keeps the idempotency and permission guards", () => {
    const script = buildSetupScript("https://proxy.example.com");
    expect(script).toContain("pp_write_marked_block");
    expect(script).toContain("PP_CODEX_PROVIDER_BEGIN");
    expect(script).toContain("marker.json");
    expect(script).toContain('chmod 600 "$PP_TOKEN_PATH"');
  });

  it("escapes bash-special characters in the base URL", () => {
    const script = buildSetupScript("http://proxy/$path");
    expect(script).toContain('PP_BASE_URL="http://proxy/\\$path"');
  });

  it("does not derive per-request attribution identity", () => {
    const script = buildSetupScript("https://proxy.example.com");
    expect(script).not.toContain("PROXY_USER_ID");
    expect(script).not.toContain('settings.env.ANTHROPIC_CUSTOM_HEADERS = "x-proxy-user-id: "');
    expect(script).not.toContain("PP_CODEX_HEADERS");
  });

  it("selects and refreshes Proxy-owned Codex blocks for existing configs", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-"));
    try {
      const codexDir = join(home, ".codex");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, "config.toml"), `# Existing Codex config
# >>> prompt codex defaults >>>
model = "old-model"
model_provider = "proxy"
# <<< prompt codex defaults <<<

[features]
goals = true

# >>> prompt codex provider proxy >>>
[model_providers.proxy]
name = "Old Proxy"
base_url = "http://old/v1"
env_key = "OLD_PROXY_TOKEN"
# <<< prompt codex provider proxy <<<
`);
      writeFileSync(join(home, ".zshrc"), [
        "# >>> prompt codex PROXY_TOKEN >>>",
        'export PROXY_TOKEN="old-token"',
        "# <<< prompt codex PROXY_TOKEN <<<",
        ""
      ].join("\n"));

      const result = spawnSync("bash", ["-s", "--", "proxy-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: {
          ...process.env,
          HOME: home,
          PROXY_USER_ID: "dev@example.com",
          USER: "dev"
        }
      });

      expect(result.status).toBe(0);
      const config = readFileSync(join(codexDir, "config.toml"), "utf8");
      expect(config).toContain('model = "gpt-5.5"');
      expect(config).toContain('model_provider = "proxy"');
      expect(config).toContain("[features]");
      expect(config).toContain("goals = true");
      expect(config).toContain('base_url = "https://proxy.example.com/v1"');
      expect(config).toContain('env_key = "PROXY_TOKEN"');
      expect(config).toContain("supports_websockets = false");
      expect(config).toContain("# >>> prompt codex defaults >>>");
      expect(config).toContain("# >>> prompt codex provider proxy >>>");
      expect(config).not.toContain("http_headers");
      expect(config).not.toContain("http://old/v1");
      expect(config).not.toContain("OLD_PROXY_TOKEN");
      const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
      expect(zshrc).toContain("# >>> prompt codex PROXY_TOKEN >>>");
      expect(zshrc).toContain('export PROXY_TOKEN="$(cat ~/.proxy/token)"');
      expect(zshrc).not.toContain("old-token");

      const secondResult = spawnSync("bash", ["-s", "--", "proxy-token-2"], {
        input: buildSetupScript("https://proxy2.example.com"),
        env: { ...process.env, HOME: home, USER: "dev" }
      });
      expect(secondResult.status).toBe(0);
      const secondConfig = readFileSync(join(codexDir, "config.toml"), "utf8");
      expect(secondConfig).toContain('base_url = "https://proxy2.example.com/v1"');
      expect(secondConfig.match(/# >>> prompt codex provider proxy >>>/g)).toHaveLength(1);
      const secondZshrc = readFileSync(join(home, ".zshrc"), "utf8");
      expect(secondZshrc.match(/# >>> prompt codex PROXY_TOKEN >>>/g)).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports unmarked Codex blocks with matching names without clobbering them", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-unmarked-"));
    try {
      const codexDir = join(home, ".codex");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, "config.toml"), `model = "user-model"
model_provider = "proxy"

[model_providers.proxy]
name = "User Proxy"
base_url = "http://user-managed/v1"
env_key = "USER_TOKEN"
`);
      writeFileSync(join(home, ".zshrc"), 'export PROXY_TOKEN="user-token"\n');

      const result = spawnSync("bash", ["-s", "--", "proxy-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: { ...process.env, HOME: home, USER: "dev" }
      });

      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toContain("found unmarked PROXY_TOKEN");
      expect(result.stderr.toString()).toContain("found unmarked top-level model/model_provider");
      expect(result.stderr.toString()).toContain("found unmarked [model_providers.proxy]");
      const config = readFileSync(join(codexDir, "config.toml"), "utf8");
      expect(config).toContain('base_url = "http://user-managed/v1"');
      expect(config).not.toContain("https://proxy.example.com/v1");
      expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe('export PROXY_TOKEN="user-token"\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not select an unmarked Codex provider table when defaults are absent", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-provider-only-"));
    try {
      const codexDir = join(home, ".codex");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, "config.toml"), `  [model_providers.proxy_codex] # user-managed
name = "User Proxy"
base_url = "http://user-managed/v1"
env_key = "USER_TOKEN"
`);

      const result = spawnSync("bash", ["-s", "--", "--harness", "codex", "codex-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: { ...process.env, HOME: home, USER: "dev" }
      });

      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toContain("found unmarked [model_providers.proxy_codex]");
      const config = readFileSync(join(codexDir, "config.toml"), "utf8");
      expect(config).not.toContain('model_provider = "proxy_codex"');
      expect(config).toContain('base_url = "http://user-managed/v1"');
      expect(config).not.toContain("https://proxy.example.com/v1");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves symlinked Codex config and shell rc files", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-symlink-"));
    try {
      const managedDir = join(home, "dotfiles");
      const codexDir = join(home, ".codex");
      mkdirSync(managedDir, { recursive: true });
      mkdirSync(codexDir, { recursive: true });
      const managedCodexConfig = join(managedDir, "codex-config.toml");
      const managedZshrc = join(managedDir, "zshrc");
      writeFileSync(managedCodexConfig, `# Managed Codex config
# >>> prompt codex defaults >>>
model = "old-model"
model_provider = "proxy"
# <<< prompt codex defaults <<<

[features]
goals = true

# >>> prompt codex provider proxy >>>
[model_providers.proxy]
name = "Old Proxy"
base_url = "http://old/v1"
env_key = "OLD_PROXY_TOKEN"
# <<< prompt codex provider proxy <<<
`);
      writeFileSync(managedZshrc, [
        "# >>> prompt codex PROXY_TOKEN >>>",
        'export PROXY_TOKEN="old-token"',
        "# <<< prompt codex PROXY_TOKEN <<<",
        ""
      ].join("\n"));
      symlinkSync(managedCodexConfig, join(codexDir, "config.toml"));
      symlinkSync(managedZshrc, join(home, ".zshrc"));

      const result = spawnSync("bash", ["-s", "--", "proxy-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: { ...process.env, HOME: home, USER: "dev" }
      });

      expect(result.status).toBe(0);
      expect(lstatSync(join(codexDir, "config.toml")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(home, ".zshrc")).isSymbolicLink()).toBe(true);
      const config = readFileSync(managedCodexConfig, "utf8");
      expect(config).toContain('model = "gpt-5.5"');
      expect(config).toContain('model_provider = "proxy"');
      expect(config).toContain("[features]");
      expect(config).toContain("goals = true");
      expect(config).toContain('base_url = "https://proxy.example.com/v1"');
      expect(config).toContain("supports_websockets = false");
      expect(config).not.toContain("http://old/v1");
      const zshrc = readFileSync(managedZshrc, "utf8");
      expect(zshrc).toContain("# >>> prompt codex PROXY_TOKEN >>>");
      expect(zshrc).toContain('export PROXY_TOKEN="$(cat ~/.proxy/token)"');
      expect(zshrc).not.toContain("old-token");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("configures a Codex-specific key without changing Claude Code", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-codex-"));
    try {
      writeFileSync(join(home, ".zshrc"), [
        "# >>> prompt codex PROXY_CODEX_TOKEN >>>",
        'export PROXY_CODEX_TOKEN="old-token"',
        "# <<< prompt codex PROXY_CODEX_TOKEN <<<",
        ""
      ].join("\n"));

      const result = spawnSync("bash", ["-s", "--", "--harness", "codex", "codex-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: {
          ...process.env,
          HOME: home,
          PROXY_USER_ID: "codex@example.com",
          USER: "dev"
        }
      });

      expect(result.status).toBe(0);
      expect(readFileSync(join(home, ".proxy", "codex.token"), "utf8")).toBe("codex-token\n");
      const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      expect(config).toContain('model = "gpt-5.5"');
      expect(config).toContain('model_provider = "proxy_codex"');
      expect(config).toContain("[model_providers.proxy_codex]");
      expect(config).toContain('env_key = "PROXY_CODEX_TOKEN"');
      expect(config).toContain("supports_websockets = false");
      expect(config).not.toContain("http_headers");
      const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
      expect(zshrc).toContain("# >>> prompt codex PROXY_CODEX_TOKEN >>>");
      expect(zshrc).toContain('export PROXY_CODEX_TOKEN="$(cat ~/.proxy/codex.token)"');
      expect(zshrc).not.toContain("old-token");
      expect(spawnSync("test", ["!", "-e", join(home, ".claude", "settings.json")]).status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes Codex config under CODEX_HOME when set", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-codex-home-"));
    const codexHome = join(home, "custom-codex");
    try {
      const result = spawnSync("bash", ["-s", "--", "--harness", "codex", "codex-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: { ...process.env, HOME: home, CODEX_HOME: codexHome }
      });

      expect(result.status).toBe(0);
      expect(result.stdout.toString()).toContain(`codex: wrote ${codexHome}/config.toml`);
      const config = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('model = "gpt-5.5"');
      expect(config).toContain('model_provider = "proxy_codex"');
      expect(config).toContain('env_key = "PROXY_CODEX_TOKEN"');
      expect(config).toContain("supports_websockets = false");
      expect(spawnSync("test", ["!", "-e", join(home, ".codex", "config.toml")]).status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("configures a Claude Code-specific key without changing Codex", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-claude-"));
    try {
      const result = spawnSync("bash", ["-s", "--", "--harness=claude-code", "claude-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: {
          ...process.env,
          HOME: home,
          PROXY_USER_ID: "claude@example.com",
          USER: "dev"
        }
      });

      expect(result.status).toBe(0);
      expect(readFileSync(join(home, ".proxy", "claude-code.token"), "utf8")).toBe("claude-token\n");
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      expect(settings.apiKeyHelper).toBe("cat ~/.proxy/claude-code.token");
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://proxy.example.com");
      expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
      expect(spawnSync("test", ["!", "-e", join(home, ".codex", "config.toml")]).status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports unmarked Claude Code settings without clobbering them", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-claude-unmarked-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
        model: "user-claude-model",
        env: { ANTHROPIC_BASE_URL: "https://anthropic.example.com" },
        apiKeyHelper: "cat ~/.anthropic/key"
      }));

      const result = spawnSync("bash", ["-s", "--", "--harness=claude-code", "claude-token"], {
        input: buildSetupScript("https://proxy.example.com"),
        env: { ...process.env, HOME: home }
      });
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toContain("user-managed settings outside Proxy marker");
      expect(settings.model).toBe("user-claude-model");
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("https://anthropic.example.com");
      expect(settings.apiKeyHelper).toBe("cat ~/.anthropic/key");
      expect(settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("removes only the old Proxy identity header from Claude Code settings", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-claude-headers-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
        env: { ANTHROPIC_CUSTOM_HEADERS: "x-proxy-user-id: old@example.com" }
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
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-claude-headers-"));
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

  it("removes only the Proxy identity header from mixed Claude Code custom headers", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-claude-headers-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
        env: { ANTHROPIC_CUSTOM_HEADERS: "x-trace-id: keep, x-proxy-user-id: old@example.com, x-debug: yes" }
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
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-opencode-"));
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
      expect(readFileSync(join(home, ".proxy", "opencode.token"), "utf8")).toBe("open-token\n");
      const config = JSON.parse(readFileSync(join(xdgConfig, "opencode", "opencode.json"), "utf8"));
      expect(config.provider["prompt-chat"].npm).toBe("@ai-sdk/openai-compatible");
      expect(config.provider["prompt-chat"].options.baseURL).toBe("https://proxy.example.com/v1");
      expect(config.model).toBe("prompt-chat/router-auto");
      const auth = JSON.parse(readFileSync(join(xdgData, "opencode", "auth.json"), "utf8"));
      expect(auth["prompt-chat"]).toEqual({ type: "api", key: "open-token" });
      expect(spawnSync("test", ["!", "-e", join(home, ".codex", "config.toml")]).status).toBe(0);
      expect(spawnSync("test", ["!", "-e", join(home, ".claude", "settings.json")]).status).toBe(0);

      config.provider["other-provider"] = { npm: "other", name: "Other", options: { baseURL: "http://other" } };
      writeFileSync(join(xdgConfig, "opencode", "opencode.json"), JSON.stringify(config, null, 2));
      const secondResult = spawnSync("bash", ["-s", "--", "--harness", "opencode", "open-token-2"], {
        input: buildSetupScript("https://proxy2.example.com"),
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
          USER: "dev"
        }
      });
      expect(secondResult.status).toBe(0);
      const secondConfig = JSON.parse(readFileSync(join(xdgConfig, "opencode", "opencode.json"), "utf8"));
      expect(secondConfig.provider["other-provider"].options.baseURL).toBe("http://other");
      expect(secondConfig.provider["prompt-chat"].options.baseURL).toBe("https://proxy2.example.com/v1");
      const secondAuth = JSON.parse(readFileSync(join(xdgData, "opencode", "auth.json"), "utf8"));
      expect(secondAuth["prompt-chat"]).toEqual({ type: "api", key: "open-token-2" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports unmarked opencode provider and auth entries without clobbering them", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-opencode-unmarked-"));
    const xdgConfig = join(home, "xdg-config");
    const xdgData = join(home, "xdg-data");
    try {
      mkdirSync(join(xdgConfig, "opencode"), { recursive: true });
      mkdirSync(join(xdgData, "opencode"), { recursive: true });
      writeFileSync(join(xdgConfig, "opencode", "opencode.json"), JSON.stringify({
        provider: {
          "prompt-chat": {
            npm: "@ai-sdk/openai-compatible",
            name: "User Proxy",
            options: { baseURL: "http://user-managed/v1" },
            models: { "router-auto": { name: "User Router" } }
          }
        },
        model: "prompt-chat/router-auto"
      }));
      writeFileSync(join(xdgData, "opencode", "auth.json"), JSON.stringify({
        "prompt-chat": { type: "api", key: "user-token" }
      }));

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
      expect(result.stderr.toString()).toContain("user-managed entries outside Proxy markers");
      const config = JSON.parse(readFileSync(join(xdgConfig, "opencode", "opencode.json"), "utf8"));
      expect(config.provider["prompt-chat"].options.baseURL).toBe("http://user-managed/v1");
      const auth = JSON.parse(readFileSync(join(xdgData, "opencode", "auth.json"), "utf8"));
      expect(auth["prompt-chat"]).toEqual({ type: "api", key: "user-token" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("configures multiple selected harnesses with one shared key", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-multi-"));
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
      expect(readFileSync(join(home, ".proxy", "token"), "utf8")).toBe("multi-token\n");
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      expect(settings.apiKeyHelper).toBe("cat ~/.proxy/token");
      const codexConfig = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      expect(codexConfig).toContain('model_provider = "proxy"');
      expect(codexConfig).toContain('env_key = "PROXY_TOKEN"');
      const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
      expect(zshrc).toContain('export PROXY_TOKEN="$(cat ~/.proxy/token)"');
      const opencodeAuth = JSON.parse(readFileSync(join(xdgData, "opencode", "auth.json"), "utf8"));
      expect(opencodeAuth["prompt-chat"]).toEqual({ type: "api", key: "multi-token" });
      expect(result.stdout.toString()).toContain("Done. Open a new terminal and run one of: claude, codex");
      expect(result.stdout.toString()).not.toContain("run: claude codex");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an empty explicit harness instead of falling back to defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "proxy-setup-empty-harness-"));
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
