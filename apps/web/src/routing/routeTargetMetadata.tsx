import {
  TRANSLATION_COMPATIBILITY_DIALECTS,
  translationCompatibilityForDialects,
  type TranslationDialect,
  type TranslationCompatibilityResult
} from "@proxy/schema/translationCompatibility";

import type { RouteTargetDraft, RoutingEditorCatalog } from "../routingConfigEditor";
import { emptyRouteTarget } from "../routingConfigEditor";
import type { ModelOption } from "./modelSelect";

export function TargetNotes({ target, catalog, effortChanged, effectiveEffort }: {
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

export function providerOptions(catalog: RoutingEditorCatalog, target: RouteTargetDraft) {
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

export function modelOptions(catalog: RoutingEditorCatalog, target: RouteTargetDraft): ModelOption[] {
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

export function defaultTarget(catalog: RoutingEditorCatalog) {
  const providerId = catalog.providers.find((provider) => provider.enabled)?.slug ?? "";
  return emptyRouteTarget(providerId, modelForProvider(catalog, providerId));
}

export function modelForProvider(catalog: RoutingEditorCatalog, providerId: string) {
  return catalog.models.find((model) => model.provider === providerId)?.model ?? "";
}

export function providerDialects(provider: RoutingEditorCatalog["providers"][number]) {
  return provider.endpoints
    .map((endpoint) => endpoint.dialect)
    .filter((dialect): dialect is TranslationDialect => knownDialects.has(dialect));
}

function modelDescription(model: RoutingEditorCatalog["models"][number]) {
  if (model.source === "unpriced") return model.seenInTraffic ? "Seen in traffic, unpriced" : "Catalog model, unpriced";
  if (model.source === "custom") return "Custom catalog pricing";
  return "Catalog pricing";
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
