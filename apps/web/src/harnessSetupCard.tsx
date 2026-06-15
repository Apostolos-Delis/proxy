import { Check, Copy, TerminalSquare } from "lucide-react";
import { useMemo, useState } from "react";

import { apiBase } from "./graphql";
import {
  buildManualSteps,
  buildSetupCommand,
  harnessSetupLabel,
  keyPlaceholder,
  tokenPathForHarness,
  type HarnessSetupTarget,
  type SnippetLanguage
} from "./keys/setupSnippets";
import { highlightSnippet } from "./keys/snippetHighlight";
import { WizardStepHead } from "./keys/stepHead";

export function HarnessSetupGuide({ secret, harness, showKeyContextSteps = true }: {
  secret: string | null;
  harness?: HarnessSetupTarget;
  showKeyContextSteps?: boolean;
}) {
  const target = harness ?? "all";
  const label = harnessSetupLabel(target);
  return (
    <>
      <WizardStepHead
        icon={<TerminalSquare />}
        title={`Route ${label} through the proxy`}
        sub="The harness authenticates with this API key, and the proxy picks models from the routing config assigned to that key."
      />
      <ol className="setup-steps">
        {showKeyContextSteps ? (
          <li>
            Create an API key with the <span className="code-pill">proxy</span> scope.
            {secret ? null : <span className="faint"> Then replace {keyPlaceholder} below with the key secret.</span>}
          </li>
        ) : null}
        <li>
          Run this on your machine, or paste it into an agent and let it run it for you:
          <Snippet text={buildSetupCommand({ apiBase, secret, harness: target })} language="shell" />
          <div className="faint setup-explainer">
            It fetches the <a href={`${apiBase}/setup.sh`} target="_blank" rel="noreferrer">setup script</a> from
            the proxy, stores the key at <span className="code-pill">{tokenPathForHarness(target)}</span>, and configures
            {target === "all" ? " Claude Code and Codex" : ` ${label}`} to use the proxy. Safe to re-run.
          </div>
        </li>
        <li>
          {launchInstruction(target)}
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
          {buildManualSteps({ apiBase, secret, harness: target }).map((step) => (
            <li key={step.title}>
              <span className="setup-manual-title">{step.title}.</span> {step.detail}
              <Snippet text={step.snippet} language={step.language} />
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}

function launchInstruction(harness: HarnessSetupTarget) {
  if (harness === "claude-code") {
    return <>Open a new terminal and run <span className="code-pill">claude</span>.</>;
  }
  if (harness === "codex") {
    return <>Open a new terminal and run <span className="code-pill">codex</span>.</>;
  }
  if (harness === "opencode") {
    return <>Open opencode, run <span className="code-pill">/models</span>, and select <span className="code-pill">prompt-proxy-chat/router-auto</span>.</>;
  }
  return (
    <>
      Open a new terminal and run <span className="code-pill">claude</span> or <span className="code-pill">codex</span>.
    </>
  );
}

function Snippet({ text, language }: { text: string; language: SnippetLanguage }) {
  const [copied, setCopied] = useState(false);
  const nodes = useMemo(() => highlightSnippet(text, language), [text, language]);
  return (
    <div className="setup-snippet">
      <pre>{nodes}</pre>
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
