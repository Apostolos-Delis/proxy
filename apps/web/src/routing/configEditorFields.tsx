import { ArrowDown, ArrowUp, Gauge, Plus, Split, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  TRANSLATION_COMPATIBILITY_DIALECTS,
  translationCompatibilityForDialects,
  type TranslationDialect,
  type TranslationCompatibilityResult
} from "@prompt-proxy/schema/translationCompatibility";

import type {
  ConfigEditorDraft,
  EditorRouteName,
  RouteTargetDraft,
  RoutingConfigDocument,
  RoutingEditorCatalog
} from "../routingConfigEditor";
import {
  editorRouteOrder,
  effectiveEffortForTarget,
  effortScaleForProvider,
  effortOptionsForProvider,
  emptyRouteTarget
} from "../routingConfigEditor";
import { MenuSelect } from "../table/MenuSelect";
import { ModelSelect, type ModelOption } from "./modelSelect";
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

export function RouteTargetsEditor({ draft, baseConfig, catalog, onChange }: {
  draft: ConfigEditorDraft;
  baseConfig: RoutingConfigDocument;
  catalog: RoutingEditorCatalog;
  onChange: (draft: ConfigEditorDraft) => void;
}) {
  const setRouteTargets = (route: EditorRouteName, targets: RouteTargetDraft[]) => {
    onChange({
      ...draft,
      routes: {
        ...draft.routes,
        [route]: { targets }
      }
    });
  };
  const updateTarget = (route: EditorRouteName, index: number, target: RouteTargetDraft) => {
    setRouteTargets(route, draft.routes[route].targets.map((current, currentIndex) =>
      currentIndex === index ? target : current
    ));
  };
  const moveTarget = (route: EditorRouteName, index: number, direction: -1 | 1) => {
    const targets = [...draft.routes[route].targets];
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= targets.length) return;
    [targets[index], targets[nextIndex]] = [targets[nextIndex], targets[index]];
    setRouteTargets(route, targets);
  };
  const addTarget = (route: EditorRouteName) => {
    const target = defaultTarget(catalog);
    setRouteTargets(route, [...draft.routes[route].targets, target]);
  };

  return (
    <div className="tier-table">
      <div className="tier-table-header">
        <span>TIER</span>
        <span>TARGETS</span>
      </div>
      {editorRouteOrder.map((route) => (
        <div key={route} className="tier-table-row">
          <div className="tier-table-tier">
            <TierGauge route={route} />
            <span className="faint">{baseConfig.routes[route]?.description ?? "No description"}</span>
          </div>
          <div className="route-target-list">
            {draft.routes[route].targets.map((target, index) => (
              <RouteTargetEditor
                key={index}
                route={route}
                index={index}
                target={target}
                targetCount={draft.routes[route].targets.length}
                catalog={catalog}
                onChange={(next) => updateTarget(route, index, next)}
                onMove={(direction) => moveTarget(route, index, direction)}
                onRemove={() => setRouteTargets(route, draft.routes[route].targets.filter((_, current) => current !== index))}
              />
            ))}
            <button className="btn btn-sm route-target-add" type="button" onClick={() => addTarget(route)}>
              <Plus />{draft.routes[route].targets.length === 0 ? "Add target" : "Add alternate"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function RouteTargetEditor({ route, index, target, targetCount, catalog, onChange, onMove, onRemove }: {
  route: EditorRouteName;
  index: number;
  target: RouteTargetDraft;
  targetCount: number;
  catalog: RoutingEditorCatalog;
  onChange: (target: RouteTargetDraft) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const provider = catalog.providers.find((candidate) => candidate.slug === target.providerId);
  const providerLabel = provider?.displayName ?? target.providerId;
  const supportedEfforts = effortScaleForProvider(provider);
  const targetDialects = provider ? providerDialects(provider) : [];
  const effortOptions = effortOptionsForProvider(provider, target.effort);
  const effectiveEffort = effectiveEffortForTarget(target, supportedEfforts, targetDialects);
  const configuredEffort = target.effort.trim();
  const effortChanged = Boolean(configuredEffort) && configuredEffort !== effectiveEffort;
  const effortMeterValue = effortChanged ? effectiveEffort : target.effort;
  return (
    <div className="route-target" data-provider={target.providerId || "target"}>
      <div className="route-target-rank">#{index + 1}</div>
      <div className="route-target-fields">
        <MenuSelect
          className="tier-provider"
          value={target.providerId}
          ariaLabel={`${route} target ${index + 1} provider`}
          options={providerOptions(catalog, target)}
          onChange={(providerId) => onChange({ ...target, providerId, model: modelForProvider(catalog, providerId) })}
        />
        <ModelSelect
          value={target.model}
          providerLabel={providerLabel || "provider"}
          options={modelOptions(catalog, target)}
          onChange={(model) => onChange({ ...target, model })}
        />
        <div className="tier-model-effort">
          <EffortMeter effort={effortMeterValue} label={false} />
          <MenuSelect
            className="tier-effort"
            value={target.effort}
            ariaLabel={`${route} target ${index + 1} effort`}
            options={[
              { value: "", label: "default effort" },
              ...effortOptions.map((option) => ({ value: option, label: `effort ${option}` }))
            ]}
            onChange={(effort) => onChange({ ...target, effort })}
          />
        </div>
      </div>
      <div className="route-target-actions">
        <button className="btn btn-ghost btn-icon" type="button" aria-label="Move target up" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp />
        </button>
        <button className="btn btn-ghost btn-icon" type="button" aria-label="Move target down" disabled={index === targetCount - 1} onClick={() => onMove(1)}>
          <ArrowDown />
        </button>
        <button className="btn btn-ghost btn-icon" type="button" aria-label="Remove target" onClick={onRemove}>
          <Trash2 />
        </button>
      </div>
      <TargetNotes target={target} catalog={catalog} effortChanged={Boolean(effortChanged)} effectiveEffort={effectiveEffort} />
    </div>
  );
}

function TargetNotes({ target, catalog, effortChanged, effectiveEffort }: {
  target: RouteTargetDraft;
  catalog: RoutingEditorCatalog;
  effortChanged: boolean;
  effectiveEffort: string;
}) {
  const notes = targetNotes(target, catalog);
  if (effortChanged) notes.unshift(`Effort ${target.effort.trim()} resolves as ${effectiveEffort || "provider default"}.`);
  if (notes.length === 0) return null;
  return (
    <div className="route-target-notes">
      {notes.map((note) => <span key={note}>{note}</span>)}
    </div>
  );
}

function providerOptions(catalog: RoutingEditorCatalog, target: RouteTargetDraft) {
  const options = catalog.providers.map((provider) => ({
    value: provider.slug,
    label: `${provider.displayName}${provider.enabled ? "" : " (disabled)"}`
  }));
  if (target.providerId && !options.some((option) => option.value === target.providerId)) {
    options.unshift({ value: target.providerId, label: `${target.providerId} (missing)` });
  }
  if (options.length === 0) options.push({ value: "", label: "No providers" });
  return options;
}

function modelOptions(catalog: RoutingEditorCatalog, target: RouteTargetDraft): ModelOption[] {
  const options = catalog.models
    .filter((model) => model.provider === target.providerId)
    .map((model) => ({
      id: model.model,
      description: modelDescription(model)
    }));
  if (target.model && !options.some((option) => option.id === target.model)) {
    options.unshift({ id: target.model, description: "Current config value not found in the catalog" });
  }
  return options;
}

function modelDescription(model: RoutingEditorCatalog["models"][number]) {
  if (model.source === "unpriced") return model.seenInTraffic ? "Seen in traffic, unpriced" : "Catalog model, unpriced";
  if (model.source === "custom") return "Custom catalog pricing";
  return "Catalog pricing";
}

function defaultTarget(catalog: RoutingEditorCatalog) {
  const providerId = catalog.providers.find((provider) => provider.enabled)?.slug ?? "";
  return emptyRouteTarget(providerId, modelForProvider(catalog, providerId));
}

function modelForProvider(catalog: RoutingEditorCatalog, providerId: string) {
  return catalog.models.find((model) => model.provider === providerId)?.model ?? "";
}

function targetNotes(target: RouteTargetDraft, catalog: RoutingEditorCatalog) {
  const notes: string[] = [];
  const provider = catalog.providers.find((candidate) => candidate.slug === target.providerId);
  if (!target.providerId.trim() || !target.model.trim()) return notes;
  if (!provider) {
    notes.push("Provider is not in the registry.");
    return notes;
  }
  if (!provider.enabled) notes.push("Provider is disabled.");
  const dialects = providerDialects(provider);
  if (dialects.length === 0) {
    notes.push("No compatible provider endpoint.");
  } else {
    notes.push(`Coverage: ${coverageSummary(dialects)}.`);
    if (!dialects.includes("openai-responses") && translationCompatibilityForDialects({
      from: "openai-responses",
      targetDialects: dialects,
      transport: "http",
      statefulResponses: true
    }).status === "translated") {
      notes.push("Codex prior-response and WebSocket turns require a native Responses alternate.");
    }
  }
  if (!catalog.models.some((model) => model.provider === target.providerId && model.model === target.model)) {
    notes.push("Model is not in the catalog for this provider.");
  }
  if (!provider.builtin && provider.authStyle !== "none") notes.push("Requires an active provider key binding.");
  return notes;
}

const knownDialects = new Set<string>(TRANSLATION_COMPATIBILITY_DIALECTS);

function providerDialects(provider: RoutingEditorCatalog["providers"][number]) {
  return provider.endpoints
    .map((endpoint) => endpoint.dialect)
    .filter((dialect): dialect is TranslationDialect => knownDialects.has(dialect));
}

function coverageSummary(dialects: TranslationDialect[]) {
  return [
    coverageLabel("Codex HTTP", translationCompatibilityForDialects({
      from: "openai-responses",
      targetDialects: dialects,
      transport: "http",
      statefulResponses: true
    })),
    coverageLabel("Claude", translationCompatibilityForDialects({
      from: "anthropic-messages",
      targetDialects: dialects,
      transport: "http"
    })),
    coverageLabel("Chat", translationCompatibilityForDialects({
      from: "openai-chat",
      targetDialects: dialects,
      transport: "http"
    }))
  ].join("; ");
}

function coverageLabel(label: string, result: TranslationCompatibilityResult) {
  if (result.status === "native") return `${label} native`;
  if (result.status === "translated" && result.to) return `${label} via ${formatDialect(result.to)}`;
  return `${label} ${reasonLabel(result.reason)}`;
}

function formatDialect(dialect: TranslationDialect) {
  if (dialect === "openai-responses") return "Responses";
  if (dialect === "openai-chat") return "Chat";
  return "Messages";
}

function reasonLabel(reason: string | undefined) {
  if (reason === "stateful_translation_unavailable") return "native-only";
  if (reason === "previous_response_translation_unavailable") return "prior-response native-only";
  if (reason === "websocket_native_only") return "WebSocket native-only";
  return "unavailable";
}
