import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

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
  effortOptionsForProvider
} from "../routingConfigEditor";
import { MenuSelect } from "../table/MenuSelect";
import { ModelSelect } from "./modelSelect";
import {
  TargetNotes,
  defaultTarget,
  modelForProvider,
  modelOptions,
  providerOptions
} from "./routeTargetMetadata";
import { TargetControls } from "./routeTargetControls";
import { providerDialects } from "./targetCompatibility";
import { EffortMeter, TierGauge } from "./tierViz";

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
          onChange={(providerId) => onChange(targetForProvider(target, catalog, providerId))}
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
      <TargetControls target={target} catalog={catalog} onChange={onChange} />
    </div>
  );
}

function targetForProvider(target: RouteTargetDraft, catalog: RoutingEditorCatalog, providerId: string): RouteTargetDraft {
  return {
    providerId,
    model: modelForProvider(catalog, providerId),
    effort: target.effort
  };
}
