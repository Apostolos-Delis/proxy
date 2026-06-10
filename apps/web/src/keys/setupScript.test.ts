import { describe, expect, it } from "vitest";

import { buildSetupScript, keyPlaceholder } from "./setupScript";

const apiBase = "http://127.0.0.1:8787";

describe("buildSetupScript", () => {
  it("embeds the secret in the token heredoc", () => {
    const script = buildSetupScript({ apiBase, secret: "pp_abc123" });
    expect(script).toContain("<<'PP_TOKEN_EOF'\npp_abc123\nPP_TOKEN_EOF");
  });

  it("falls back to the placeholder when there is no secret", () => {
    const script = buildSetupScript({ apiBase, secret: null });
    expect(script).toContain(`\n${keyPlaceholder}\nPP_TOKEN_EOF`);
  });

  it("passes the api base to the settings merge and the codex provider", () => {
    const script = buildSetupScript({ apiBase, secret: "pp_abc123" });
    expect(script).toContain(`' "${apiBase}"`);
    expect(script).toContain(`base_url = "${apiBase}/v1"`);
  });

  it("keeps the idempotency and permission guards", () => {
    const script = buildSetupScript({ apiBase, secret: "pp_abc123" });
    expect(script).toContain('grep -q "PROMPT_PROXY_TOKEN"');
    expect(script).toContain('grep -qF "[model_providers.prompt_proxy]"');
    expect(script).toContain('chmod 600 "$HOME/.prompt-proxy/token"');
  });

  it("runs in a child shell so set -e never leaks into the user's session", () => {
    const script = buildSetupScript({ apiBase, secret: "pp_abc123" });
    expect(script.startsWith("bash -s <<'PP_SETUP_EOF'")).toBe(true);
    expect(script.endsWith("PP_SETUP_EOF")).toBe(true);
  });

  it("escapes bash-special characters in the api base", () => {
    const script = buildSetupScript({ apiBase: "http://proxy/$path", secret: "pp_abc123" });
    expect(script).toContain('"http://proxy/\\$path"');
  });

  it("rejects inputs that collide with the heredoc delimiters", () => {
    expect(() => buildSetupScript({ apiBase, secret: "x\nPP_TOKEN_EOF\ny" })).toThrow(/delimiter/);
  });
});
