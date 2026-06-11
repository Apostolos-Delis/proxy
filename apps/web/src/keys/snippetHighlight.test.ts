import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { buildManualSteps, buildSetupCommand } from "./setupSnippets";
import { highlightSnippet } from "./snippetHighlight";

function tokens(nodes: ReactNode[]) {
  return nodes.map((node) => {
    if (isValidElement<{ className: string; children: string }>(node)) {
      return { className: node.props.className, text: node.props.children };
    }
    return { className: undefined, text: String(node) };
  });
}

function plainText(nodes: ReactNode[]) {
  return tokens(nodes).map((token) => token.text).join("");
}

const apiBase = "http://127.0.0.1:8787";

describe("highlightSnippet", () => {
  it("renders every snippet without losing characters", () => {
    for (const secret of ["pp_abc123", `pp_a'b"c`, "''", "", null]) {
      const command = buildSetupCommand({ apiBase, secret });
      expect(plainText(highlightSnippet(command, "shell"))).toBe(command);
      for (const step of buildManualSteps({ apiBase, secret })) {
        expect(plainText(highlightSnippet(step.snippet, step.language))).toBe(step.snippet);
      }
    }
  });

  it("keeps a quote-escaped secret as a single string token", () => {
    const marked = tokens(highlightSnippet(buildSetupCommand({ apiBase, secret: "a'b" }), "shell"));
    expect(marked).toContainEqual({ className: "json-string", text: `'a'\\''b'` });
  });

  it("marks shell commands, flags, and strings", () => {
    const marked = tokens(highlightSnippet("curl -fsSL http://x/setup.sh | bash -s -- 'pp_abc'", "shell"));
    expect(marked).toContainEqual({ className: "json-key", text: "curl" });
    expect(marked).toContainEqual({ className: "json-key", text: "bash" });
    expect(marked).toContainEqual({ className: "json-literal", text: "-fsSL" });
    expect(marked).toContainEqual({ className: "json-string", text: "'pp_abc'" });
    expect(marked).toContainEqual({ className: undefined, text: "http://x/setup.sh" });
  });

  it("marks shell assignments after export", () => {
    const marked = tokens(highlightSnippet(`export PROMPT_PROXY_TOKEN="$(cat ~/.prompt-proxy/token)"`, "shell"));
    expect(marked).toContainEqual({ className: "json-key", text: "export" });
    expect(marked).toContainEqual({ className: "json-key", text: "PROMPT_PROXY_TOKEN=" });
    expect(marked).toContainEqual({ className: "json-string", text: `"$(cat ~/.prompt-proxy/token)"` });
  });

  it("resets the command position after each line", () => {
    const marked = tokens(highlightSnippet("mkdir -p ~/.prompt-proxy\nchmod 600 ~/.prompt-proxy/token", "shell"));
    expect(marked).toContainEqual({ className: "json-key", text: "mkdir" });
    expect(marked).toContainEqual({ className: "json-key", text: "chmod" });
    expect(marked).toContainEqual({ className: "json-number", text: "600" });
  });

  it("marks toml tables, keys, and values", () => {
    const marked = tokens(highlightSnippet('[model_providers.prompt_proxy]\nname = "Prompt Proxy"\nsupports_websockets = true', "toml"));
    expect(marked).toContainEqual({ className: "json-literal", text: "[model_providers.prompt_proxy]" });
    expect(marked).toContainEqual({ className: "json-key", text: "name" });
    expect(marked).toContainEqual({ className: "json-string", text: '"Prompt Proxy"' });
    expect(marked).toContainEqual({ className: "json-literal", text: "true" });
  });
});
