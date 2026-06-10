import { Check, Copy, TerminalSquare } from "lucide-react";
import { useState } from "react";

import { apiBase } from "./api";
import { GlassCard, Segmented } from "./ui";

type Harness = "claude-code" | "codex";

const harnessOptions = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" }
] as const;

const keyPlaceholder = "<your-api-key>";

export function HarnessSetupCard({ secret }: { secret: string | null }) {
  const [harness, setHarness] = useState<Harness>("claude-code");
  const key = secret ?? keyPlaceholder;
  return (
    <GlassCard className="harness-setup">
      <div className="card-head">
        <div>
          <div className="card-title"><TerminalSquare />Route your coding agent through the proxy</div>
          <div className="faint">
            The harness authenticates with an API key, and the proxy picks models from the routing config assigned to that key.
          </div>
        </div>
        <Segmented options={harnessOptions} value={harness} onChange={setHarness} />
      </div>
      <ol className="setup-steps">
        <li>
          Create an API key above with the <span className="code-pill">proxy</span> scope.
          Add <span className="code-pill">harness_identity</span> so usage is attributed to the person running the agent.
          {secret ? null : <span className="faint"> Then replace {keyPlaceholder} below with the key secret.</span>}
        </li>
        {harness === "claude-code" ? <ClaudeCodeSteps apiKey={key} /> : <CodexSteps apiKey={key} />}
        <li>
          Assign a routing config to the key (or leave it on the organization default) to control which models each
          route tier uses.
        </li>
      </ol>
    </GlassCard>
  );
}

function ClaudeCodeSteps({ apiKey }: { apiKey: string }) {
  const snippet = [
    `export ANTHROPIC_BASE_URL=${apiBase}`,
    `export ANTHROPIC_API_KEY=${apiKey}`,
    "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
    "claude --model claude-router-auto"
  ].join("\n");
  return (
    <li>
      Point Claude Code at the proxy and launch it with the router model:
      <Snippet text={snippet} />
    </li>
  );
}

function CodexSteps({ apiKey }: { apiKey: string }) {
  const profileSnippet = [
    "model = \"router-auto\"",
    "model_provider = \"prompt_proxy\"",
    "",
    "[model_providers.prompt_proxy]",
    "name = \"Prompt Proxy\"",
    `base_url = "${apiBase}/v1"`,
    "env_key = \"PROMPT_PROXY_TOKEN\"",
    "wire_api = \"responses\"",
    "supports_websockets = true"
  ].join("\n");
  const launchSnippet = [
    `export PROMPT_PROXY_TOKEN=${apiKey}`,
    "codex"
  ].join("\n");
  return (
    <>
      <li>
        Add the Prompt Proxy provider to <span className="code-pill">~/.codex/config.toml</span>:
        <Snippet text={profileSnippet} />
      </li>
      <li>
        Export the key and launch Codex:
        <Snippet text={launchSnippet} />
      </li>
    </>
  );
}

function Snippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setup-snippet">
      <pre>{text}</pre>
      <button
        className="btn btn-sm snippet-copy"
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
        }}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
