import { Check, Copy, TerminalSquare } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { apiBase } from "./graphql";
import {
  buildManualSteps,
  buildSetupCommand,
  defaultHarnessSetupSelection,
  harnessSetupLabel,
  keyPlaceholder,
  tokenPathForHarnesses,
  type HarnessSetupSelection,
  type SnippetLanguage
} from "./keys/setupSnippets";
import { highlightSnippet } from "./keys/snippetHighlight";
import { WizardStepHead } from "./keys/stepHead";

export function HarnessSetupGuide({ secret, harnesses, showKeyContextSteps = true }: {
  secret: string | null;
  harnesses?: HarnessSetupSelection;
  showKeyContextSteps?: boolean;
}) {
  const selected = harnesses && harnesses.length > 0 ? harnesses : defaultHarnessSetupSelection;
  const label = harnessSetupLabel(selected);
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
            Create an API key.
            {secret ? null : <span className="faint"> Then replace {keyPlaceholder} below with the key secret.</span>}
          </li>
        ) : null}
        <li>
          Run this on your machine, or paste it into an agent and let it run it for you:
          <Snippet text={buildSetupCommand({ apiBase, secret, harnesses: selected })} language="shell" />
          <div className="faint setup-explainer">
            It fetches the <a href={`${apiBase}/setup.sh`} target="_blank" rel="noreferrer">setup script</a> from
            the proxy, stores the key at <span className="code-pill">{tokenPathForHarnesses(selected)}</span>, and configures
            {" "}{label} to use the proxy. Safe to re-run.
          </div>
        </li>
        <li>
          {launchInstruction(selected)}
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
          {buildManualSteps({ apiBase, secret, harnesses: selected }).map((step) => (
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

function launchInstruction(harnesses: HarnessSetupSelection) {
  if (harnesses.length === 1 && harnesses[0] === "claude-code") {
    return <>Open a new terminal and run <span className="code-pill">claude</span>.</>;
  }
  if (harnesses.length === 1 && harnesses[0] === "codex") {
    return <>Open a new terminal and run <span className="code-pill">codex</span>.</>;
  }
  if (harnesses.length === 1 && harnesses[0] === "opencode") {
    return <>Open opencode, run <span className="code-pill">/models</span>, and select <span className="code-pill">prompt-chat/router-auto</span>.</>;
  }
  const terminalCommands: string[] = [];
  if (harnesses.includes("claude-code")) terminalCommands.push("claude");
  if (harnesses.includes("codex")) terminalCommands.push("codex");
  return (
    <>
      {terminalCommands.length > 0 ? (
        <>
          Open a new terminal and run{" "}
          {terminalCommands.map((command, index) => (
            <Fragment key={command}>
              {index > 0 ? " or " : null}
              <span className="code-pill">{command}</span>
            </Fragment>
          ))}
          .
        </>
      ) : null}
      {harnesses.includes("opencode") ? (
        <> Open opencode, run <span className="code-pill">/models</span>, and select <span className="code-pill">prompt-chat/router-auto</span>.</>
      ) : null}
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
