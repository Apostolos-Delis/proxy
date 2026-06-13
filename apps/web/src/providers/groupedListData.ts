import { PROVIDER_ORDER } from "../providers";
import type { ApiKeySummary } from "../routing/data";
import { ownerLabel, type UserDirectory } from "../userDirectory";
import type { ProviderAccountSummary, ProviderRegistrySummary } from "./data";

export type ProviderGroup = {
  provider: string;
  accounts: ProviderAccountSummary[];
  total: number;
  activeCount: number;
};

export function boundKeysByAccount(apiKeys: ApiKeySummary[]) {
  const map = new Map<string, ApiKeySummary[]>();
  for (const apiKey of apiKeys) {
    if (apiKey.revokedAt) continue;
    for (const credential of apiKey.providerCredentials) {
      if (!credential.providerAccountId) continue;
      const list = map.get(credential.providerAccountId) ?? [];
      list.push(apiKey);
      map.set(credential.providerAccountId, list);
    }
  }
  return map;
}

export function providerGroups(
  accounts: ProviderAccountSummary[],
  providers: ProviderRegistrySummary[],
  searchValue: string,
  users: UserDirectory,
  boundKeys: Map<string, ApiKeySummary[]> | null
): ProviderGroup[] {
  const query = searchValue.trim().toLowerCase();
  return orderedProviders(accounts, providers)
    .map((provider) => {
      const all = accounts.filter((account) => account.provider === provider).sort(compareAccounts);
      const visible = query ? all.filter((account) => matchesQuery(account, query, users, boundKeys)) : all;
      return {
        provider,
        accounts: visible,
        total: all.length,
        activeCount: all.filter((account) => account.status === "active").length
      };
    })
    .filter((group) => !query || group.accounts.length > 0);
}

export function authTypeLabel(account: ProviderAccountSummary) {
  if (account.authType !== "oauth") return "API key";
  if (account.provider === "anthropic") return "Claude sub";
  if (account.provider === "openai") return "ChatGPT sub";
  return "Subscription";
}

function orderedProviders(accounts: ProviderAccountSummary[], providers: ProviderRegistrySummary[]) {
  const known: string[] = [...PROVIDER_ORDER];
  const registry = providers.map((provider) => provider.slug).filter((provider) => !known.includes(provider));
  const extras = accounts.map((account) => account.provider).filter((provider) => !known.includes(provider));
  return [...known, ...new Set([...registry, ...extras])];
}

function compareAccounts(left: ProviderAccountSummary, right: ProviderAccountSummary) {
  const activeDelta = Number(right.status === "active") - Number(left.status === "active");
  if (activeDelta) return activeDelta;
  const authDelta = Number(left.authType === "oauth") - Number(right.authType === "oauth");
  if (authDelta) return authDelta;
  const lastUsedDelta = (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "");
  if (lastUsedDelta) return lastUsedDelta;
  return right.createdAt.localeCompare(left.createdAt);
}

function matchesQuery(
  account: ProviderAccountSummary,
  query: string,
  users: UserDirectory,
  boundKeys: Map<string, ApiKeySummary[]> | null
) {
  const values = [
    account.id,
    account.name,
    account.provider,
    authTypeLabel(account),
    account.status,
    account.secretHint ?? "",
    ownerLabel(users, account.ownerUserId),
    ...(boundKeys?.get(account.id) ?? []).map((apiKey) => apiKey.name)
  ];
  return values.some((value) => value.toLowerCase().includes(query));
}
