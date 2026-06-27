import { PROVIDER_ORDER } from "../providers";
import type { ApiKeySummary } from "../routing/data";
import { ownerLabel, type UserDirectory } from "../userDirectory";
import type { ProviderAccountSummary, ProviderRegistrySummary } from "./data";
import { providerHealthSearchTokens } from "./healthData";

type ProviderDefaultLabels = {
  title: string;
  secret: string;
  status: string;
  note: string;
};

type ProviderCredentialBaseRow = {
  id: string;
  provider: string;
  providerLabel: string;
  providerDomain: string;
  registryProvider?: ProviderRegistrySummary;
};

type ProviderCredentialDefaultRow = ProviderCredentialBaseRow & {
  kind: "default";
  labels: ProviderDefaultLabels;
};

type ProviderCredentialAccountRow = ProviderCredentialBaseRow & {
  kind: "account";
  account: ProviderAccountSummary;
};

export type ProviderCredentialRow = ProviderCredentialDefaultRow | ProviderCredentialAccountRow;

const PROVIDER_META: Record<string, { label: string; domain: string }> = {
  anthropic: { label: "Anthropic", domain: "api.anthropic.com" },
  openai: { label: "OpenAI", domain: "api.openai.com" }
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

export function providerCredentialRows(
  accounts: ProviderAccountSummary[],
  providers: ProviderRegistrySummary[]
): ProviderCredentialRow[] {
  const providerBySlug = new Map(providers.map((provider) => [provider.slug, provider]));
  return orderedProviders(accounts, providers).flatMap((provider) => {
    const registryProvider = providerBySlug.get(provider);
    const meta = providerMeta(provider, registryProvider);
    const defaultRow: ProviderCredentialDefaultRow = {
      id: `default-${provider}`,
      kind: "default",
      provider,
      providerLabel: meta.label,
      providerDomain: meta.domain,
      registryProvider,
      labels: providerDefaultLabels(registryProvider, registryProvider?.builtin ?? groupIsBuiltinFallback(provider))
    };
    const accountRows: ProviderCredentialAccountRow[] = accounts
      .filter((account) => account.provider === provider)
      .sort(compareAccounts)
      .map((account) => ({
        id: account.id,
        kind: "account",
        provider,
        providerLabel: meta.label,
        providerDomain: meta.domain,
        registryProvider,
        account
      }));
    return [defaultRow, ...accountRows];
  });
}

export function authTypeLabel(account: ProviderAccountSummary) {
  if (account.credentialSourceCategory) return account.credentialSourceCategory;
  if (account.authType !== "oauth") return "API key";
  if (account.provider === "anthropic") return "Claude sub";
  if (account.provider === "openai") return "ChatGPT sub";
  return "Subscription";
}

export function providerCredentialStatus(row: ProviderCredentialRow) {
  if (row.kind === "account") return row.account.status;
  if (row.registryProvider?.enabled === false) return "disabled";
  if (row.labels.status === "credential required") return "credential required";
  return "active";
}

export function providerCredentialType(row: ProviderCredentialRow) {
  return row.kind === "default" ? "default" : "credential";
}

export function providerCredentialLabel(row: ProviderCredentialRow) {
  return row.kind === "default" ? row.labels.title : row.account.name;
}

export function providerCredentialAuthLabel(row: ProviderCredentialRow) {
  return row.kind === "default" ? row.registryProvider?.authStyle ?? "provider default" : authTypeLabel(row.account);
}

export function providerCredentialBindingLabel(row: ProviderCredentialRow, boundKeys: Map<string, ApiKeySummary[]> | null) {
  if (row.kind === "default") return `${row.labels.status} ${row.labels.note}`;
  const names = boundKeyNames(row, boundKeys);
  if (names.length > 0) return names.join(" ");
  return providerBoundKeyCountLabel(row.account.boundKeyCount);
}

export function providerBoundKeyCountLabel(count: number) {
  if (count === 0) return "no keys bound";
  if (count === 1) return "1 key bound";
  return `${count} keys bound`;
}

export function providerCredentialSearchValue(
  row: ProviderCredentialRow,
  users: UserDirectory,
  boundKeys: Map<string, ApiKeySummary[]> | null
) {
  if (row.kind === "default") {
    return [
      row.provider,
      row.providerLabel,
      row.providerDomain,
      row.labels.title,
      row.labels.secret,
      row.labels.status,
      row.labels.note
    ];
  }
  return [
    row.account.id,
    row.account.name,
    row.account.provider,
    row.providerLabel,
    authTypeLabel(row.account),
    row.account.status,
    row.account.secretHint ?? "",
    row.account.credentialSourceCategory ?? "",
    row.account.region ?? "",
    row.account.discoveryRegions.join(" "),
    ownerLabel(users, row.account.ownerUserId),
    ...providerHealthSearchTokens(row.account),
    ...boundKeyNames(row, boundKeys)
  ];
}

export function boundKeyNames(row: ProviderCredentialRow, boundKeys: Map<string, ApiKeySummary[]> | null) {
  if (row.kind !== "account") return [];
  return (boundKeys?.get(row.account.id) ?? []).map((apiKey) => apiKey.name);
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

function providerMeta(provider: string, registryProvider?: ProviderRegistrySummary) {
  return PROVIDER_META[provider] ?? {
    label: registryProvider?.displayName ?? provider,
    domain: domainForProvider(registryProvider)
  };
}

function providerDefaultLabels(provider: ProviderRegistrySummary | undefined, builtin: boolean): ProviderDefaultLabels {
  if (builtin) {
    return {
      title: "Company key",
      secret: "proxy host credential",
      status: "used by default",
      note: "when no provider key is bound"
    };
  }
  if (provider?.authStyle === "none") {
    return {
      title: "No credential required",
      secret: "no auth",
      status: provider.enabled ? "enabled" : "disabled",
      note: "targeted traffic"
    };
  }
  return {
    title: "Provider key required",
    secret: "BYOK only",
    status: provider?.enabled ? "credential required" : "disabled",
    note: "targeted traffic"
  };
}

function domainForProvider(provider?: ProviderRegistrySummary) {
  if (!provider) return "";
  try {
    return new URL(provider.baseUrl).host;
  } catch {
    return "";
  }
}

function groupIsBuiltinFallback(provider?: string) {
  return provider === "anthropic" || provider === "openai";
}
