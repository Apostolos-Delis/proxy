import type { ProviderName } from "./providers/data";
import type { ProviderRegistrySummary } from "./providers/data";

export const PROVIDER_OPTIONS: { value: ProviderName; label: string }[] = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI" }
];

export const PROVIDER_ORDER: ProviderName[] = PROVIDER_OPTIONS.map((option) => option.value);

export function providerOptionsFromRegistry(providers: ProviderRegistrySummary[]) {
  const builtin = new Map(PROVIDER_OPTIONS.map((option) => [option.value, option.label]));
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      value: provider.slug,
      label: builtin.get(provider.slug) ?? provider.displayName,
      adapterKind: provider.adapterKind
    }));
}
