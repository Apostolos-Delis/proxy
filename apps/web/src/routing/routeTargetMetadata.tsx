import {
  type TranslationDialect,
  type TranslationCompatibilityResult
} from "@proxy/schema/translationCompatibility";

import type { RouteTargetDraft, RoutingEditorCatalog } from "../routingConfigEditor";
import { emptyRouteTarget } from "../routingConfigEditor";
import type { ModelOption } from "./modelSelect";
import {
  activeProviderAccounts,
  modelMatchesTargetScope,
  targetCompatibility,
  type TargetCompatibility
} from "./targetCompatibility";

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
  const selectedAccount = catalog.providerAccounts.find((account) => account.id === target.providerAccountId);
  const modelsById = new Map<string, RoutingEditorCatalog["models"]>();
  for (const model of catalog.models) {
    if (model.provider !== target.providerId || !modelMatchesTargetScope(model, target, selectedAccount)) continue;
    modelsById.set(model.model, [...(modelsById.get(model.model) ?? []), model]);
  }
  const options = [...modelsById.entries()].map(([id, models]) => ({
    id,
    description: modelDescription(models)
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

function modelDescription(models: RoutingEditorCatalog["models"]) {
  const model = models.find((model) => model.providerAccountId) ?? models[0];
  if (!model) return "model catalog";
  const regions = [...new Set(models.map((model) => model.region).filter(Boolean))];
  const region = regions.length > 1 ? `${regions.length} regions` : regions[0];
  const parts = [
    model.displayName,
    region,
    model.contextWindow ? `${compactNumber(model.contextWindow)} ctx` : undefined,
    model.supportsTools === true ? "tools" : undefined,
    model.supportsStreaming === true ? "stream" : undefined,
    model.pricingKnown ? "priced" : "unpriced"
  ].filter(Boolean);
  return parts.join(" · ") || model.catalogSource;
}

function targetNotes(target: RouteTargetDraft, catalog: RoutingEditorCatalog) {
  const notes: string[] = [];
  const compatibility = targetCompatibility(target, catalog);
  const provider = compatibility.provider;
  if (!target.providerId.trim() || !target.model.trim()) return notes;
  if (!provider) {
    notes.push("provider_not_found");
    return notes;
  }
  if (compatibility.reasonCode) notes.push(compatibility.reasonCode);
  notes.push(`Provider: ${provider.displayName}.`);
  notes.push(`Dialect: ${dialectSummary(compatibility.dialects)}.`);
  if (provider.adapterKind === "aws-bedrock-converse") notes.push("Adapter: Bedrock Converse.");
  else if (provider.adapterKind === "generic-http-json") notes.push(provider.builtin ? "Adapter: native HTTP." : "Adapter: custom HTTP.");
  if (!provider.enabled) notes.push("Health: provider disabled.");
  const dialects = compatibility.dialects;
  if (dialects.length === 0) {
    notes.push("Dialect: unavailable.");
  } else {
    notes.push(`Coverage: ${coverageSummary(compatibility)}.`);
  }
  notes.push(...modelNotes(compatibility));
  notes.push(...credentialNotes(compatibility, provider));
  notes.push(...healthNotes(compatibility, target.model));
  return notes;
}

function coverageSummary(compatibility: TargetCompatibility) {
  return compatibility.surfaces.map((surface) => coverageLabel(surface.label, surface.result)).join("; ");
}

function coverageLabel(label: string, result: TranslationCompatibilityResult) {
  if (result.status === "native") return `${label} native`;
  if (result.status === "translated" && result.to) return `${label} via ${formatDialect(result.to)}`;
  return `${label} ${reasonLabel(result.reason)}`;
}

function formatDialect(dialect: TranslationDialect) {
  if (dialect === "openai-responses") return "Responses";
  if (dialect === "openai-chat") return "Chat";
  if (dialect === "bedrock-converse") return "Bedrock";
  return "Messages";
}

function reasonLabel(reason: string | undefined) {
  if (reason === "stateful_translation_unavailable") return "native-only";
  if (reason === "previous_response_translation_unavailable") return "prior-response native-only";
  if (reason === "websocket_native_only") return "WebSocket native-only";
  return reason ?? "unavailable";
}

function dialectSummary(dialects: TranslationDialect[]) {
  return dialects.length === 0 ? "none" : dialects.map(formatDialect).join(", ");
}

function modelNotes(compatibility: TargetCompatibility) {
  const model = compatibility.model;
  if (!model) return ["Model: model_catalog_missing."];
  const notes = [
    `Model: ${model.displayName ?? model.model}.`,
    model.region ? `Region: ${model.region}.` : undefined,
    model.contextWindow ? `Context: ${compactNumber(model.contextWindow)} tokens.` : undefined,
    `Tools: ${supportLabel(model.supportsTools)}.`,
    `Streaming: ${supportLabel(model.supportsStreaming)}.`,
    `Pricing: ${model.pricingKnown ? "known" : "unknown"}.`
  ].filter((note): note is string => Boolean(note));
  if (model.bedrockInferenceProfileId) notes.push(`Profile: ${model.bedrockInferenceProfileId}.`);
  for (const warning of model.warnings) notes.push(`Catalog warning: ${warning}.`);
  return notes;
}

function credentialNotes(compatibility: TargetCompatibility, provider: RoutingEditorCatalog["providers"][number]) {
  if (provider.authStyle === "none") return ["Credential: not required."];
  const activeAccounts = activeProviderAccounts(compatibility.providerAccounts);
  if (compatibility.selectedAccount) {
    const account = compatibility.selectedAccount;
    return [`Credential: ${account.name} (${account.status}${account.credentialSourceCategory ? `, ${account.credentialSourceCategory}` : ""}).`];
  }
  if (provider.authStyle === "aws-sdk") return ["Credential: provider_credential_unresolved."];
  return [`Credential: ${activeAccounts.length > 0 ? `${activeAccounts.length} active` : "provider_credential_unresolved"}.`];
}

function healthNotes(compatibility: TargetCompatibility, model: string) {
  const account = compatibility.selectedAccount ?? activeProviderAccounts(compatibility.providerAccounts)[0];
  if (!account?.health) return ["Health: unknown."];
  const notes = [`Health: ${account.health.status ?? "unknown"}${account.health.lastErrorType ? ` (${account.health.lastErrorType})` : ""}.`];
  const modelHealth = account.health.modelHealth.find((candidate) => candidate.model === model);
  if (modelHealth) notes.push(`Model health: ${modelHealth.status}${modelHealth.lastErrorType ? ` (${modelHealth.lastErrorType})` : ""}.`);
  return notes;
}

function supportLabel(value: boolean | null | undefined) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
