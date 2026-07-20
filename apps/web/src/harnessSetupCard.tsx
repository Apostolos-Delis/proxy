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

export function HarnessSetupGuide({ secret, harnesses, model, standalone = true }: {
  secret: string | null;
  harnesses?: HarnessSetupSelection;
  model?: string;
  standalone?: boolean;
}) {
  const selected = harnesses && harnesses.length > 0 ? harnesses : defaultHarnessSetupSelection;
  const label = harnessSetupLabel(selected);
  return (
    <>
      {standalone ? (
        <WizardStepHead
          icon={<TerminalSquare />}
          title={`Route ${label} through the proxy`}
          sub="The harness authenticates with this API key and can use the logical models granted by its access profile."
        />
      ) : null}
      <ol className="setup-steps">
        {standalone ? (
          <li>
            <strong className="setup-step-title">Create an API key</strong>
            <p>
              Create a key for the workload.
              {secret ? null : <span className="faint"> Then replace {keyPlaceholder} below with the key secret.</span>}
            </p>
          </li>
        ) : null}
        <li>
          <strong className="setup-step-title">Run the installer</strong>
          <p>Paste this into your terminal, or give it to an agent running on your machine.</p>
          <Snippet text={buildSetupCommand({ apiBase, secret, harnesses: selected })} language="shell" />
          <div className="faint setup-explainer">
            It fetches the <a href={`${apiBase}/setup.sh`} target="_blank" rel="noreferrer">setup script</a> from
            the proxy, stores the key at <span className="code-pill">{tokenPathForHarnesses(selected)}</span>, and configures
            {" "}{label} to use the proxy. Safe to re-run.
          </div>
        </li>
        <li>
          <strong className="setup-step-title">Start routing traffic</strong>
          <p>{launchInstruction(selected, model)}</p>
        </li>
        {standalone ? (
          <li>
            <strong className="setup-step-title">Control access</strong>
            <p>Assign an access profile to control which logical models and operations the key can use.</p>
          </li>
        ) : null}
      </ol>
      {model ? (
        <details className="setup-manual">
          <summary><strong>Manual setup</strong><span>View the individual configuration steps</span></summary>
          <ol className="setup-steps">
            {buildManualSteps({ apiBase, secret, model, harnesses: selected }).map((step) => (
              <li key={step.title}>
                <span className="setup-manual-title">{step.title}.</span> {step.detail}
                <Snippet text={step.snippet} language={step.language} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </>
  );
}

function launchInstruction(harnesses: HarnessSetupSelection, model?: string) {
  if (harnesses.length === 1 && harnesses[0] === "claude-code") {
    return <>Open a new terminal and run <span className="code-pill">claude</span>.</>;
  }
  if (harnesses.length === 1 && harnesses[0] === "codex") {
    return <>Open a new terminal and run <span className="code-pill">codex</span>.</>;
  }
  if (harnesses.length === 1 && harnesses[0] === "opencode") {
    return <OpenCodeLaunch model={model} />;
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
        <> <OpenCodeLaunch model={model} /></>
      ) : null}
    </>
  );
}

function OpenCodeLaunch({ model }: { model?: string }) {
  return (
    <>
      Open opencode, run <span className="code-pill">/models</span>, and select{" "}
      {model ? (
        <span className="code-pill">prompt-chat/{model}</span>
      ) : (
        "a logical model granted to the key"
      )}.
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
