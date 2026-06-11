import { describe, expect, it } from "vitest";

import { buildManualSteps, buildSetupCommand, keyPlaceholder } from "./setupSnippets";

const apiBase = "http://127.0.0.1:8787";

describe("buildSetupCommand", () => {
  it("fetches the hosted script and passes the secret as the argument", () => {
    expect(buildSetupCommand({ apiBase, secret: "pp_abc123" })).toBe(
      "curl -fsSL http://127.0.0.1:8787/setup.sh | bash -s -- 'pp_abc123'"
    );
  });

  it("falls back to the placeholder when there is no secret", () => {
    expect(buildSetupCommand({ apiBase, secret: null })).toContain(`-- '${keyPlaceholder}'`);
  });

  it("single-quote-escapes secrets so they cannot break out of the argument", () => {
    expect(buildSetupCommand({ apiBase, secret: "a'b" })).toContain(`-- 'a'\\''b'`);
  });
});

describe("buildManualSteps", () => {
  const steps = buildManualSteps({ apiBase, secret: "pp_abc123" });

  it("mirrors the four things the hosted script does", () => {
    expect(steps.map((step) => step.title)).toEqual([
      "Store the key",
      "Point Claude Code at the proxy",
      "Export the key for Codex",
      "Register the Codex provider"
    ]);
  });

  it("stores the secret with restricted permissions", () => {
    expect(steps[0].snippet).toContain("printf '%s\\n' 'pp_abc123' > ~/.prompt-proxy/token");
    expect(steps[0].snippet).toContain("chmod 600 ~/.prompt-proxy/token");
  });

  it("renders valid Claude Code settings JSON pointing at the proxy", () => {
    const settings = JSON.parse(steps[1].snippet);
    expect(settings).toEqual({
      model: "claude-router-auto",
      env: {
        ANTHROPIC_BASE_URL: apiBase,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        ANTHROPIC_CUSTOM_HEADERS: "x-prompt-proxy-user-id: <your-email>"
      },
      apiKeyHelper: "cat ~/.prompt-proxy/token"
    });
  });

  it("wires Codex through the shell export and provider table", () => {
    expect(steps[2].snippet).toBe(`export PROMPT_PROXY_TOKEN="$(cat ~/.prompt-proxy/token)"`);
    expect(steps[3].snippet).toContain("[model_providers.prompt_proxy]");
    expect(steps[3].snippet).toContain(`base_url = "${apiBase}/v1"`);
    expect(steps[3].snippet).toContain(`env_key = "PROMPT_PROXY_TOKEN"`);
    expect(steps[3].snippet).toContain(`http_headers = { "x-prompt-proxy-user-id" = "<your-email>" }`);
  });

  it("stamps the identity header so traffic is attributed, not Unknown user", () => {
    expect(steps[1].snippet).toContain("x-prompt-proxy-user-id");
    expect(steps[3].snippet).toContain("x-prompt-proxy-user-id");
  });

  it("uses the placeholder when there is no secret", () => {
    const placeholderSteps = buildManualSteps({ apiBase, secret: null });
    expect(placeholderSteps[0].snippet).toContain(keyPlaceholder);
  });
});
