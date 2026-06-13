import { PROVIDER_OPTIONS, PROVIDER_ORDER } from "../providers";
import type { ProviderAccountSummary, ProviderName } from "../providers/data";

export function providerOptionsForAccounts(
  accounts: ProviderAccountSummary[],
  bindings: Record<ProviderName, string | null>
) {
  const labels = new Map(PROVIDER_OPTIONS.map((option) => [option.value, option.label]));
  const providers = new Set<ProviderName>([
    ...PROVIDER_ORDER,
    ...accounts.map((account) => account.provider),
    ...Object.keys(bindings)
  ]);
  return [...providers].map((provider) => ({
    value: provider,
    label: labels.get(provider) ?? provider
  }));
}
