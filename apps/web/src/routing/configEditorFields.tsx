import { ScrollText, Split } from "lucide-react";
import type { ReactNode } from "react";

import type { RoutingConfigDocument } from "../routingConfigEditor";
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
import { ModelSelect, type ModelProvider } from "./modelSelect";

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
        tag="shapes model responses"
        helper="Prepended to the harness system prompt on every request proxied through this config. It steers how the selected model answers and has no effect on routing. Leave empty to forward harness prompts unchanged."
        value={draft.systemPrompt}
        rows={4}
        placeholder={SYSTEM_PROMPT_PLACEHOLDER}
        onChange={(systemPrompt) => onChange({ ...draft, systemPrompt })}
      />
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
            <TierModelField
              provider="openai"
              model={draft.routes[route].openaiModel}
              effort={draft.routes[route].openaiEffort}
              efforts={OPENAI_EFFORTS}
              onModelChange={(model) => setRouteField(route, "openaiModel", model)}
              onEffortChange={(effort) => setRouteField(route, "openaiEffort", effort)}
            />
            <TierModelField
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

function TierModelField({ provider, model, effort, efforts, onModelChange, onEffortChange }: {
  provider: ModelProvider;
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
      <ModelSelect provider={provider} value={model} onChange={onModelChange} />
    </div>
  );
}
