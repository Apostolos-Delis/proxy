import {
  TRANSLATION_COMPATIBILITY_DIALECTS,
  translationCompatibilityForDialects,
  type TranslationCompatibilityReason,
  type TranslationCompatibilityResult,
  type TranslationDialect
} from "@proxy/schema/translationCompatibility";

import type {
  RouteTargetDraft,
  RoutingCatalogModel,
  RoutingCatalogProvider,
  RoutingCatalogProviderAccount,
  RoutingEditorCatalog
} from "../routingConfigEditor";

export type TargetPublishReason =
  | TranslationCompatibilityReason
  | "provider_not_found"
  | "provider_disabled"
  | "provider_adapter_unavailable"
  | "provider_credential_unresolved"
  | "provider_account_unavailable"
  | "model_catalog_missing";

export type SurfaceCompatibility = {
  label: string;
  result: TranslationCompatibilityResult;
};

export type TargetCompatibility = {
  provider?: RoutingCatalogProvider;
  model?: RoutingCatalogModel;
  providerAccounts: RoutingCatalogProviderAccount[];
  selectedAccount?: RoutingCatalogProviderAccount;
  dialects: TranslationDialect[];
  surfaces: SurfaceCompatibility[];
  publishable: boolean;
  reasonCode?: TargetPublishReason;
};

const knownDialects = new Set<string>(TRANSLATION_COMPATIBILITY_DIALECTS);

export function targetCompatibility(target: RouteTargetDraft, catalog: RoutingEditorCatalog): TargetCompatibility {
  const provider = providerForTarget(catalog, target);
  const providerAccounts = providerAccountsForTarget(catalog, target);
  const selectedAccount = providerAccounts.find((account) => account.id === target.providerAccountId);
  const model = modelForTarget(catalog, target, selectedAccount);
  const dialects = provider ? providerDialects(provider) : [];
  const bedrockSettingsOnNonBedrockTarget = hasBedrockSettings(target) && provider?.adapterKind !== "aws-bedrock-converse";
  const surfaces = surfaceCompatibility(dialects, bedrockSettingsOnNonBedrockTarget);
  const reasonCode = publishReason(target, catalog, provider, model, providerAccounts, selectedAccount, dialects, bedrockSettingsOnNonBedrockTarget);
  return {
    provider,
    model,
    providerAccounts,
    selectedAccount,
    dialects,
    surfaces,
    publishable: reasonCode === undefined,
    reasonCode
  };
}

export function providerForTarget(catalog: RoutingEditorCatalog, target: Pick<RouteTargetDraft, "providerId">) {
  return catalog.providers.find((candidate) => candidate.slug === target.providerId);
}

export function modelForTarget(
  catalog: RoutingEditorCatalog,
  target: Pick<RouteTargetDraft, "providerId" | "model" | "providerAccountId">,
  selectedAccount?: RoutingCatalogProviderAccount
) {
  const models = catalog.models.filter((model) =>
    model.provider === target.providerId &&
    model.model === target.model &&
    modelMatchesTargetScope(model, target, selectedAccount)
  );
  return models.find((model) => target.providerAccountId && model.providerAccountId === target.providerAccountId) ??
    models.find((model) => !model.providerAccountId) ??
    models[0];
}

export function providerAccountsForTarget(catalog: RoutingEditorCatalog, target: Pick<RouteTargetDraft, "providerId">) {
  return catalog.providerAccounts.filter((account) => account.provider === target.providerId);
}

export function providerDialects(provider: Pick<RoutingCatalogProvider, "endpoints">) {
  return provider.endpoints
    .map((endpoint) => endpoint.dialect)
    .filter((dialect): dialect is TranslationDialect => knownDialects.has(dialect));
}

export function hasBedrockSettings(target: Pick<RouteTargetDraft, "metadata">) {
  const metadata = target.metadata;
  if (!metadata || Array.isArray(metadata)) return false;
  return metadata.bedrock !== undefined ||
    metadata.bedrockConverse !== undefined ||
    metadata.bedrockSettings !== undefined;
}

export function bedrockSettings(metadata: RouteTargetDraft["metadata"]) {
  if (!metadata || Array.isArray(metadata)) return {};
  const candidate = metadata.bedrockConverse ?? metadata.bedrock ?? metadata.bedrockSettings;
  return isRecord(candidate) ? candidate : {};
}

export function withBedrockSettings(target: RouteTargetDraft, nextSettings: Record<string, unknown>) {
  const metadata = { ...target.metadata };
  delete metadata.bedrock;
  delete metadata.bedrockSettings;
  if (Object.keys(nextSettings).length > 0) metadata.bedrockConverse = nextSettings;
  else delete metadata.bedrockConverse;
  return withMetadata(target, metadata);
}

export function withMetadata(target: RouteTargetDraft, metadata: Record<string, unknown>) {
  const next = { ...target };
  if (Object.keys(metadata).length > 0) next.metadata = metadata;
  else delete next.metadata;
  return next;
}

export function activeProviderAccounts(accounts: RoutingCatalogProviderAccount[]) {
  return accounts.filter((account) => account.status === "active");
}

export function modelMatchesTargetScope(
  model: RoutingCatalogModel,
  target: Pick<RouteTargetDraft, "providerAccountId">,
  selectedAccount?: RoutingCatalogProviderAccount
) {
  if (!target.providerAccountId) return true;
  if (model.providerAccountId && model.providerAccountId !== target.providerAccountId) return false;
  if (model.region && selectedAccount?.region && model.region !== selectedAccount.region) return false;
  return true;
}

function publishReason(
  target: RouteTargetDraft,
  catalog: RoutingEditorCatalog,
  provider: RoutingCatalogProvider | undefined,
  model: RoutingCatalogModel | undefined,
  providerAccounts: RoutingCatalogProviderAccount[],
  selectedAccount: RoutingCatalogProviderAccount | undefined,
  dialects: TranslationDialect[],
  bedrockSettingsOnNonBedrockTarget: boolean
): TargetPublishReason | undefined {
  if (!target.providerId.trim() || !target.model.trim()) return undefined;
  if (!provider) return "provider_not_found";
  if (!provider.enabled) return "provider_disabled";
  if (provider.adapterKind !== "generic-http-json" && provider.adapterKind !== "aws-bedrock-converse") {
    return "provider_adapter_unavailable";
  }
  if (dialects.length === 0) return "dialect_unavailable";
  if (bedrockSettingsOnNonBedrockTarget) return "bedrock_settings_on_non_bedrock_target";
  if (target.providerAccountId && selectedAccount?.status !== "active") return "provider_account_unavailable";
  if (provider.authStyle === "aws-sdk" && !target.providerAccountId) return "provider_credential_unresolved";
  if (!provider.builtin && provider.authStyle !== "none" && activeProviderAccounts(providerAccounts).length === 0) {
    return "provider_credential_unresolved";
  }
  if (providerNeedsCatalogModel(provider) && !model) return "model_catalog_missing";
  return undefined;
}

function providerNeedsCatalogModel(provider: RoutingCatalogProvider) {
  return !provider.builtin || provider.adapterKind === "aws-bedrock-converse";
}

function surfaceCompatibility(dialects: TranslationDialect[], bedrockSettingsOnNonBedrockTarget: boolean): SurfaceCompatibility[] {
  return [
    {
      label: "Codex HTTP",
      result: translationCompatibilityForDialects({
        from: "openai-responses",
        targetDialects: dialects,
        transport: "http",
        statefulResponses: true,
        bedrockSettingsOnNonBedrockTarget
      })
    },
    {
      label: "Codex WS",
      result: translationCompatibilityForDialects({
        from: "openai-responses",
        targetDialects: dialects,
        transport: "websocket",
        statefulResponses: true,
        bedrockSettingsOnNonBedrockTarget
      })
    },
    {
      label: "Claude",
      result: translationCompatibilityForDialects({
        from: "anthropic-messages",
        targetDialects: dialects,
        transport: "http",
        bedrockSettingsOnNonBedrockTarget
      })
    },
    {
      label: "Chat",
      result: translationCompatibilityForDialects({
        from: "openai-chat",
        targetDialects: dialects,
        transport: "http",
        bedrockSettingsOnNonBedrockTarget
      })
    }
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
