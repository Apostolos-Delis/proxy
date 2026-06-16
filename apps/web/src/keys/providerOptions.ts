import { PROVIDER_OPTIONS, PROVIDER_ORDER } from "../providers";
import type { ProviderAccountSummary, ProviderName } from "../providers/data";

type RoutingProviderSource = {
  routes: {
    targets: {
      providerId: string;
    }[];
  }[];
} | null;

export function providerOptionsForAccounts(
  accounts: ProviderAccountSummary[],
  bindings: Record<ProviderName, string | null>,
  routingProviders: ProviderName[] = []
) {
  const labels = new Map(PROVIDER_OPTIONS.map((option) => [option.value, option.label]));
  const fallbackProviders = routingProviders.length > 0 ? [] : PROVIDER_ORDER;
  const boundProviders = Object.entries(bindings)
    .filter((entry) => Boolean(entry[1]))
    .map(([provider]) => provider);
  const providers = new Set<ProviderName>([
    ...routingProviders,
    ...fallbackProviders,
    ...accounts.map((account) => account.provider),
    ...boundProviders
  ]);
  return [...providers].map((provider) => ({
    value: provider,
    label: labels.get(provider) ?? provider
  }));
}

export function providerIdsForRoutingConfig(config: RoutingProviderSource) {
  const providers: ProviderName[] = [];
  const seen = new Set<ProviderName>();
  for (const route of config?.routes ?? []) {
    for (const target of route.targets) {
      const provider = target.providerId.trim();
      if (!provider || seen.has(provider)) continue;
      providers.push(provider);
      seen.add(provider);
    }
  }
  return providers;
}

export function providerCredentialHint(account: Pick<ProviderAccountSummary, "authType" | "secretHint">) {
  const kind = account.authType === "oauth" ? "subscription" : "API key";
  return account.secretHint ? `${kind} / ${account.secretHint}` : kind;
}
