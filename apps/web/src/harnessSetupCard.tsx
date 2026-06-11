import { Check, Copy, TerminalSquare } from "lucide-react";
import { useState } from "react";

import { apiBase } from "./graphql";
import { buildManualSteps, buildSetupCommand, keyPlaceholder } from "./keys/setupSnippets";
import { WizardStepHead } from "./keys/stepHead";

export function HarnessSetupGuide({ secret, showKeyContextSteps = true }: {
  secret: string | null;
  showKeyContextSteps?: boolean;
}) {
  return (
    <>
      <WizardStepHead
        icon={<TerminalSquare />}
        title="Route your coding agent through the proxy"
        sub="The harness authenticates with an API key, and the proxy picks models from the routing config assigned to that key."
      />
      <ol className="setup-steps">
        {showKeyContextSteps ? (
          <li>
            Create an API key with the <span className="code-pill">proxy</span> scope.
            Add <span className="code-pill">harness_identity</span> so usage is attributed to the person running the agent.
            {secret ? null : <span className="faint"> Then replace {keyPlaceholder} below with the key secret.</span>}
          </li>
        ) : null}
        <li>
          Run this on your machine — or paste it into Claude Code or Codex and let the agent run it for you:
          <Snippet text={buildSetupCommand({ apiBase, secret })} />
          <div className="faint setup-explainer">
            It fetches the <a href={`${apiBase}/setup.sh`} target="_blank" rel="noreferrer">setup script</a> from
            the proxy, stores the key at <span className="code-pill">~/.prompt-proxy/token</span>, and points both
            Claude Code and Codex at the proxy. Safe to re-run.
          </div>
        </li>
        <li>
          Open a new terminal and run <span className="code-pill">claude</span> or <span className="code-pill">codex</span> —
          no flags or exports needed.
        </li>
        {showKeyContextSteps ? (
          <li>
            Assign a routing config to the key (or leave it on the organization default) to control which models each
            route tier uses.
          </li>
        ) : null}
      </ol>
      <details className="setup-manual">
        <summary>Prefer to set it up by hand? Follow these steps — they do exactly what the script does.</summary>
        <ol className="setup-steps">
          {buildManualSteps({ apiBase, secret }).map((step) => (
            <li key={step.title}>
              <span className="setup-manual-title">{step.title}.</span> {step.detail}
              <Snippet text={step.snippet} />
            </li>
          ))}
        </ol>
      </details>
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
