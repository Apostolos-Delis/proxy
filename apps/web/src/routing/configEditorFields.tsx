import { ScrollText, Split } from "lucide-react";
import type { ReactNode } from "react";

import type { RoutingConfigDocument } from "../api";
import {
  editorRouteOrder,
  effortHint,
  type ConfigEditorDraft,
  type EditorRouteName
} from "../routingConfigEditor";
import { RouteBadge } from "../ui";

const SYSTEM_PROMPT_PLACEHOLDER =
  "You are assisting through the organization's prompt proxy. Never reveal credentials, API keys, or other secrets.";

const ROUTING_RULES_PLACEHOLDER =
  "Routine refactors, formatting, and doc updates route fast. auth/ and payments/ need deeper reasoning, keep them on hard or deep.";

export function PromptEditors({ draft, onChange }: {
  draft: ConfigEditorDraft;
  onChange: (draft: ConfigEditorDraft) => void;
}) {
  return (
    <div className="prompt-editors">
      <PromptEditor
        icon={<ScrollText />}
        title="System prompt"
        tag="prepended to every request"
        helper="Injected ahead of the harness system prompt for every request routed through this config. Leave empty to forward harness prompts unchanged."
        value={draft.systemPrompt}
        rows={4}
        placeholder={SYSTEM_PROMPT_PLACEHOLDER}
        onChange={(systemPrompt) => onChange({ ...draft, systemPrompt })}
      />
      <PromptEditor
        icon={<Split />}
        title="Routing rules"
        tag="guides tier selection"
        helper="Instructions the classifier follows when picking fast, balanced, hard, or deep. Describe workflow patterns, codebase areas, and model preferences."
        value={draft.classifierInstructions}
        rows={6}
        placeholder={ROUTING_RULES_PLACEHOLDER}
        onChange={(classifierInstructions) => onChange({ ...draft, classifierInstructions })}
      />
    </div>
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

export function RouteMatrixEditor({ draft, baseConfig, onChange }: {
  draft: ConfigEditorDraft;
  baseConfig: RoutingConfigDocument;
  onChange: (draft: ConfigEditorDraft) => void;
}) {
  const setRouteModel = (route: EditorRouteName, provider: "openaiModel" | "anthropicModel", model: string) => {
    onChange({
      ...draft,
      routes: {
        ...draft.routes,
        [route]: { ...draft.routes[route], [provider]: model }
      }
    });
  };
  return (
    <div className="tier-editor">
      {editorRouteOrder.map((route) => {
        const tier = baseConfig.routes[route];
        return (
          <div key={route} className="tier-editor-row">
            <div className="tier-editor-head">
              <RouteBadge route={route} />
              <span className="faint">{tier?.description ?? "No description"}</span>
            </div>
            <TierModelInput
              provider="openai"
              value={draft.routes[route].openaiModel}
              hint={effortHint(tier?.openai)}
              onChange={(model) => setRouteModel(route, "openaiModel", model)}
            />
            <TierModelInput
              provider="anthropic"
              value={draft.routes[route].anthropicModel}
              hint={effortHint(tier?.anthropic)}
              onChange={(model) => setRouteModel(route, "anthropicModel", model)}
            />
          </div>
        );
      })}
    </div>
  );
}

function TierModelInput({ provider, value, hint, onChange }: {
  provider: string;
  value: string;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="tier-model">
      <span className="tier-model-provider">
        {provider}
        {hint ? <em>{hint}</em> : null}
      </span>
      <input
        value={value}
        placeholder="none"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
