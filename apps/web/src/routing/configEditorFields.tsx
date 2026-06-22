import { Gauge, Split } from "lucide-react";
import type { ReactNode } from "react";

import type { ConfigEditorDraft } from "../routingConfigEditor";

export { RouteTargetsEditor } from "./routeTargetsEditor";

const ROUTING_RULES_PLACEHOLDER =
  "Routine refactors, formatting, and doc updates route fast. auth/ and payments/ need deeper reasoning, keep them on hard or deep.";

export function RoutingRulesEditor({ draft, onChange }: {
  draft: ConfigEditorDraft;
  onChange: (draft: ConfigEditorDraft) => void;
}) {
  return (
    <div className="prompt-editors">
      <PromptEditor
        icon={<Split />}
        title="Routing rules"
        tag="guides tier selection"
        helper="Optional additions to the built-in classifier prompt that picks fast, balanced, hard, or deep. The proxy already handles common cases; add organization-specific rules like codebase areas that need deeper reasoning or workflows that can stay fast."
        value={draft.classifierRules}
        rows={6}
        placeholder={ROUTING_RULES_PLACEHOLDER}
        onChange={(classifierRules) => onChange({ ...draft, classifierRules })}
      />
    </div>
  );
}

export function RequestBudgetEditor({ draft, onChange }: {
  draft: ConfigEditorDraft;
  onChange: (draft: ConfigEditorDraft) => void;
}) {
  const enabled = draft.maxEstimatedInputTokensEnabled;
  return (
    <section className="request-budget-editor">
      <div className="prompt-editor-title">
        <Gauge />
        <strong>Request budget</strong>
        <span className="code-pill">{enabled ? "cap enabled" : "uncapped"}</span>
      </div>
      <p className="prompt-editor-helper">
        Optional guardrail on the full request envelope. Leave it off for long-lived coding sessions; enable it only when a key should reject oversized history before provider spend.
      </p>
      <div className="request-budget-controls">
        <label className="request-budget-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            aria-checked={enabled}
            onChange={(event) => onChange({
              ...draft,
              maxEstimatedInputTokensEnabled: event.target.checked,
              maxEstimatedInputTokens: event.target.checked && !draft.maxEstimatedInputTokens
                ? "200000"
                : draft.maxEstimatedInputTokens
            })}
          />
          <span>
            <strong>Reject requests above a token cap</strong>
            <small>{enabled ? "Requests over this estimate return 429 before routing." : "Large sessions are allowed through normal model routing."}</small>
          </span>
        </label>
        <label className="routing-create-field request-budget-limit">
          <span>Estimated input token limit</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            disabled={!enabled}
            value={draft.maxEstimatedInputTokens}
            placeholder="200000"
            onChange={(event) => onChange({ ...draft, maxEstimatedInputTokens: event.target.value })}
          />
        </label>
      </div>
    </section>
  );
}

function PromptEditor({ icon, title, tag, helper, value, rows, placeholder, onChange }: {
  icon: ReactNode;
  title: string;
  tag: string;
  helper: string;
  value: string;
  rows: number;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <section className="prompt-editor">
      <div className="prompt-editor-title">
        {icon}
        <strong>{title}</strong>
        <span className="code-pill">{tag}</span>
      </div>
      <p className="prompt-editor-helper">{helper}</p>
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </section>
  );
}
