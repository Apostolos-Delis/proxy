import { Split } from "lucide-react";
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
import { ModelSelect, type ModelProvider } from "./modelSelect";
import { EffortMeter, TierGauge } from "./tierViz";

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
    <div className="tier-table">
      <div className="tier-table-header">
        <span>TIER</span>
        <span>OPENAI</span>
        <span>ANTHROPIC</span>
      </div>
      {editorRouteOrder.map((route) => {
        const tier = baseConfig.routes[route];
        return (
          <div key={route} className="tier-table-row">
            <div className="tier-table-tier">
              <TierGauge route={route} />
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
    // responsive.css renders attr(data-provider) as the cell label once the
    // table header collapses on narrow screens.
    <div className="tier-model" data-provider={provider}>
      <ModelSelect provider={provider} value={model} onChange={onModelChange} />
      <div className="tier-model-effort">
        <EffortMeter effort={effort} label={false} />
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
    </div>
  );
}
