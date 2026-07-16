import { describe, expect, it } from "vitest";

import { buildManualSteps, buildSetupCommand, keyPlaceholder } from "./setupSnippets";

const apiBase = "http://127.0.0.1:8787";
const model = "economy-auto";

describe("buildSetupCommand", () => {
  it("fetches the hosted script and passes the secret as the argument", () => {
    expect(buildSetupCommand({ apiBase, secret: "pp_abc123" })).toBe(
      "curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness claude-code --harness codex 'pp_abc123'"
    );
  });

  it("falls back to the placeholder when there is no secret", () => {
    expect(buildSetupCommand({ apiBase, secret: null })).toContain(`--harness claude-code --harness codex '${keyPlaceholder}'`);
  });

  it("single-quote-escapes secrets so they cannot break out of the argument", () => {
    expect(buildSetupCommand({ apiBase, secret: "a'b" })).toContain(`--harness claude-code --harness codex 'a'\\''b'`);
  });

  it("passes selected harnesses through to the hosted script", () => {
    expect(buildSetupCommand({ apiBase, secret: "pp_codex", harnesses: ["codex", "opencode"] })).toBe(
      "curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness codex --harness opencode 'pp_codex'"
    );
  });

  it("passes a single selected harness through to the hosted script", () => {
    expect(buildSetupCommand({ apiBase, secret: "pp_codex", harnesses: ["codex"] })).toBe(
      "curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- --harness codex 'pp_codex'"
    );
  });
});

describe("buildManualSteps", () => {
  const steps = buildManualSteps({ apiBase, secret: "pp_abc123", model });

  it("mirrors the four things the hosted script does", () => {
    expect(steps.map((step) => step.title)).toEqual([
      "Store the key",
      "Point Claude Code at the proxy",
      "Export the key for Codex",
      "Register the Codex provider"
    ]);
  });

  it("stores the secret with restricted permissions", () => {
    expect(steps[0].snippet).toContain("printf '%s\\n' 'pp_abc123' > ~/.proxy/token");
    expect(steps[0].snippet).toContain("chmod 600 ~/.proxy/token");
  });

  it("renders valid Claude Code settings JSON pointing at the proxy", () => {
    const settings = JSON.parse(steps[1].snippet);
    expect(settings).toEqual({
      model,
      env: {
        ANTHROPIC_BASE_URL: apiBase,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
      },
      apiKeyHelper: "cat ~/.proxy/token"
    });
  });

  it("wires Codex through the shell export and provider table", () => {
    expect(steps[2].snippet).toContain(`export PROXY_TOKEN="$(cat ~/.proxy/token)"`);
    expect(steps[2].snippet).toContain("# >>> prompt codex PROXY_TOKEN >>>");
    expect(steps[3].snippet).toContain("[model_providers.proxy]");
    expect(steps[3].snippet).toContain("# >>> prompt codex defaults >>>");
    expect(steps[3].snippet).toContain("# >>> prompt codex provider proxy >>>");
    expect(steps[3].snippet).toContain(`base_url = "${apiBase}/v1"`);
    expect(steps[3].snippet).toContain(`env_key = "PROXY_TOKEN"`);
    expect(steps[3].snippet).toContain(`model = "${model}"`);
  });

  it("does not stamp per-request identity headers", () => {
    expect(steps[1].snippet).not.toContain("x-proxy-user-id");
    expect(steps[3].snippet).not.toContain("x-proxy-user-id");
  });

  it("uses the placeholder when there is no secret", () => {
    const placeholderSteps = buildManualSteps({ apiBase, secret: null, model });
    expect(placeholderSteps[0].snippet).toContain(keyPlaceholder);
  });

  it("builds Codex-specific steps with a separate token and provider", () => {
    const codexSteps = buildManualSteps({ apiBase, secret: "pp_codex", model, harnesses: ["codex"] });
    expect(codexSteps.map((step) => step.title)).toEqual([
      "Store the key",
      "Export the key for Codex",
      "Register the Codex provider"
    ]);
    expect(codexSteps[0].snippet).toContain("~/.proxy/codex.token");
    expect(codexSteps[1].snippet).toContain(`export PROXY_CODEX_TOKEN="$(cat ~/.proxy/codex.token)"`);
    expect(codexSteps[1].snippet).toContain("# >>> prompt codex PROXY_CODEX_TOKEN >>>");
    expect(codexSteps[2].snippet).toContain("[model_providers.proxy_codex]");
    expect(codexSteps[2].snippet).toContain(`env_key = "PROXY_CODEX_TOKEN"`);
  });

  it("builds Claude Code-specific steps with a separate token", () => {
    const claudeSteps = buildManualSteps({ apiBase, secret: "pp_claude", model, harnesses: ["claude-code"] });
    expect(claudeSteps.map((step) => step.title)).toEqual([
      "Store the key",
      "Point Claude Code at the proxy"
    ]);
    const settings = JSON.parse(claudeSteps[1].snippet);
    expect(claudeSteps[0].snippet).toContain("~/.proxy/claude-code.token");
    expect(settings.apiKeyHelper).toBe("cat ~/.proxy/claude-code.token");
    expect(settings.model).toBe(model);
  });

  it("builds opencode steps with a custom provider config", () => {
    const opencodeSteps = buildManualSteps({ apiBase, secret: "pp_open", model, harnesses: ["opencode"] });
    expect(opencodeSteps.map((step) => step.title)).toEqual([
      "Store the key",
      "Register the opencode provider",
      "Connect opencode credentials"
    ]);
    const config = JSON.parse(opencodeSteps[1].snippet);
    expect(config.provider["prompt-chat"].npm).toBe("@ai-sdk/openai-compatible");
    expect(config.provider["prompt-chat"].options.baseURL).toBe(`${apiBase}/v1`);
    expect(config.provider["prompt-chat"].models).toEqual({
      [model]: { name: model }
    });
    expect(config.model).toBe(`prompt-chat/${model}`);
    expect(config.small_model).toBe(`prompt-chat/${model}`);
    expect(opencodeSteps[2].snippet).toContain("prompt-chat");
    expect(opencodeSteps[2].snippet).toContain("pp_open");
  });

  it("uses the shared token path when multiple harnesses are selected", () => {
    const multiSteps = buildManualSteps({
      apiBase,
      secret: "pp_multi",
      model,
      harnesses: ["codex", "opencode"]
    });
    expect(multiSteps[0].snippet).toContain("~/.proxy/token");
    expect(multiSteps[1].snippet).toContain(`export PROXY_TOKEN="$(cat ~/.proxy/token)"`);
    expect(multiSteps[2].snippet).toContain("[model_providers.proxy]");
    expect(multiSteps[2].snippet).toContain(`env_key = "PROXY_TOKEN"`);
  });
});
