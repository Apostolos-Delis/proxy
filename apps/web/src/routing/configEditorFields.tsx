import { ScrollText, Split } from "lucide-react";
import type { ReactNode } from "react";

import type { RoutingConfigDocument } from "../api";
import { MenuSelect } from "../table/MenuSelect";
import {
  ANTHROPIC_EFFORTS,
  editorRouteOrder,
  OPENAI_EFFORTS,
  type ConfigEditorDraft,
  type EditorRouteName,
  type RouteTierDraft
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
  const setRouteField = (route: EditorRouteName, field: keyof RouteTierDraft, value: string) => {
    onChange({
      ...draft,
      routes: {
        ...draft.routes,
        [route]: { ...draft.routes[route], [field]: value }
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
              model={draft.routes[route].openaiModel}
              effort={draft.routes[route].openaiEffort}
              efforts={OPENAI_EFFORTS}
              onModelChange={(model) => setRouteField(route, "openaiModel", model)}
              onEffortChange={(effort) => setRouteField(route, "openaiEffort", effort)}
            />
            <TierModelInput
              provider="anthropic"
              model={draft.routes[route].anthropicModel}
              effort={draft.routes[route].anthropicEffort}
              efforts={ANTHROPIC_EFFORTS}
              onModelChange={(model) => setRouteField(route, "anthropicModel", model)}
              onEffortChange={(effort) => setRouteField(route, "anthropicEffort", effort)}
            />
          </div>
        );
      })}
    </div>
  );
}

function TierModelInput({ provider, model, effort, efforts, onModelChange, onEffortChange }: {
  provider: string;
  model: string;
  effort: string;
  efforts: readonly string[];
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}) {
  return (
    <div className="tier-model">
      <div className="tier-model-provider">
        {provider}
        <MenuSelect
          className="tier-effort"
          value={effort}
          ariaLabel={`${provider} effort`}
          options={[
            { value: "", label: "default effort" },
            ...efforts.map((option) => ({ value: option, label: `effort ${option}` }))
          ]}
          onChange={onEffortChange}
        />
      </div>
      <input
        value={model}
        placeholder="none"
        spellCheck={false}
        onChange={(event) => onModelChange(event.target.value)}
      />
    </div>
  );
}
