import { Ban, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { compactId, formatDateTime } from "../format";
import type { ApiKeySummary } from "../routing/data";
import { GlassCard, StatusBadge } from "../ui";
import { OwnerCell, type UserDirectory } from "../userDirectory";
import type { ProviderAccountSummary, ProviderRegistrySummary } from "./data";
import { authTypeLabel, providerGroups, type ProviderGroup } from "./groupedListData";
import { ProviderMark } from "./icons";

const PROVIDER_META: Record<string, { label: string; domain: string }> = {
  anthropic: { label: "Anthropic", domain: "api.anthropic.com" },
  openai: { label: "OpenAI", domain: "api.openai.com" }
};

export function ProviderGroupsList({
  accounts,
  providers,
  searchValue,
  users,
  boundKeys,
  revokePendingId,
  revokeErrorId,
  revokeErrorMessage,
  onRevoke,
  onOpen
}: {
  accounts: ProviderAccountSummary[];
  providers: ProviderRegistrySummary[];
  searchValue: string;
  users: UserDirectory;
  boundKeys: Map<string, ApiKeySummary[]> | null;
  revokePendingId?: string;
  revokeErrorId?: string;
  revokeErrorMessage?: string;
  onRevoke: (providerAccountId: string) => void;
  onOpen: (providerAccountId: string) => void;
}) {
  const groups = providerGroups(accounts, providers, searchValue, users, boundKeys);
  const providerBySlug = new Map(providers.map((provider) => [provider.slug, provider]));
  if (groups.length === 0) {
    return (
      <GlassCard className="provider-key-card">
        <div className="empty">No credentials match &ldquo;{searchValue.trim()}&rdquo;.</div>
      </GlassCard>
    );
  }
  return groups.map((group) => (
    <ProviderGroupSection
      key={group.provider}
      group={group}
      provider={providerBySlug.get(group.provider)}
      users={users}
      boundKeys={boundKeys}
      revokePendingId={revokePendingId}
      revokeErrorId={revokeErrorId}
      revokeErrorMessage={revokeErrorMessage}
      onRevoke={onRevoke}
      onOpen={onOpen}
    />
  ));
}

function ProviderGroupSection({
  group,
  provider,
  users,
  boundKeys,
  revokePendingId,
  revokeErrorId,
  revokeErrorMessage,
  onRevoke,
  onOpen
}: {
  group: ProviderGroup;
  provider?: ProviderRegistrySummary;
  users: UserDirectory;
  boundKeys: Map<string, ApiKeySummary[]> | null;
  revokePendingId?: string;
  revokeErrorId?: string;
  revokeErrorMessage?: string;
  onRevoke: (providerAccountId: string) => void;
  onOpen: (providerAccountId: string) => void;
}) {
  const meta = PROVIDER_META[group.provider] ?? { label: provider?.displayName ?? group.provider, domain: domainForProvider(provider) };
  return (
    <section className="provider-group">
      <div className="provider-group-head">
        <span className="provider-mark"><ProviderMark provider={group.provider} /></span>
        <strong>{meta.label}</strong>
        {meta.domain ? <span className="provider-group-domain mono">{meta.domain}</span> : null}
        <span className="provider-group-count">{groupCountLabel(group)}</span>
      </div>
      <GlassCard className="provider-key-card">
        <ProviderDefaultRow provider={provider} />
        {group.accounts.length === 0 ? (
          <div className="empty">No {meta.label} keys yet.</div>
        ) : group.accounts.map((account) => (
          <ProviderKeyRow
            key={account.id}
            account={account}
            users={users}
            boundKeys={boundKeys?.get(account.id)}
            boundKeysAvailable={Boolean(boundKeys)}
            pending={revokePendingId === account.id}
            error={revokeErrorId === account.id ? revokeErrorMessage : undefined}
            onRevoke={() => onRevoke(account.id)}
            onOpen={() => onOpen(account.id)}
          />
        ))}
      </GlassCard>
    </section>
  );
}

function groupCountLabel(group: ProviderGroup) {
  if (group.total === 0) return "no customer keys";
  return `${group.activeCount} of ${group.total} enabled`;
}

function ProviderDefaultRow({ provider }: { provider?: ProviderRegistrySummary }) {
  const builtin = provider?.builtin ?? groupIsBuiltinFallback(provider?.slug);
  const labels = providerDefaultLabels(provider, builtin);
  return (
    <div className="provider-default-row">
      <div className="provider-default-copy">
        <div className="provider-key-default-title">
          <ShieldCheck />
          <span>{labels.title}</span>
        </div>
        <span className="provider-key-secret-pill mono">{labels.secret}</span>
      </div>
      <div className="provider-default-meta">
        <span className="code-pill provider-default-pill">{labels.status}</span>
        <span className="provider-default-note mono">{labels.note}</span>
      </div>
    </div>
  );
}

function providerDefaultLabels(provider: ProviderRegistrySummary | undefined, builtin: boolean) {
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

function ProviderKeyRow({
  account,
  users,
  boundKeys,
  boundKeysAvailable,
  pending,
  error,
  onRevoke,
  onOpen
}: {
  account: ProviderAccountSummary;
  users: UserDirectory;
  boundKeys?: ApiKeySummary[];
  boundKeysAvailable: boolean;
  pending: boolean;
  error?: string;
  onRevoke: () => void;
  onOpen: () => void;
}) {
  return (
    <div className={`provider-key-row${account.status === "active" ? "" : " inactive"}`}>
      <div className="provider-key-main">
        <button type="button" className="table-link key-name" onClick={onOpen} aria-label={`Inspect ${account.name}`}>
          {account.name}
        </button>
        <div className="provider-key-secret-pill mono" title={account.id}>{secretLabel(account)}</div>
      </div>
      <div><AuthPill account={account} /></div>
      <BoundKeyTags boundKeys={boundKeys} boundKeyCount={account.boundKeyCount} boundKeysAvailable={boundKeysAvailable} />
      <OwnerCell users={users} userId={account.ownerUserId} />
      <div className="provider-key-lastused">
        {account.lastUsedAt ? formatDateTime(account.lastUsedAt) : <span className="faint">never</span>}
      </div>
      <div className="provider-key-status"><StatusBadge status={account.status} /></div>
      <div className="provider-key-actions">
        <RevokeCredentialAction account={account} pending={pending} error={error} onRevoke={onRevoke} />
      </div>
    </div>
  );
}

function AuthPill({ account }: { account: ProviderAccountSummary }) {
  const subscription = account.authType === "oauth";
  return (
    <span className={`code-pill auth-pill auth-pill-${account.provider}${subscription ? " auth-pill-subscription" : ""}`}>
      {subscription ? <ProviderMark provider={account.provider} /> : <KeyRound />}
      {authTypeLabel(account)}
    </span>
  );
}

function secretLabel(account: ProviderAccountSummary) {
  if (account.authType === "oauth" || !account.secretHint) return compactId(account.id, 12);
  return account.secretHint;
}

const visibleBoundKeyCount = 2;

function BoundKeyTags({
  boundKeys,
  boundKeyCount,
  boundKeysAvailable
}: {
  boundKeys?: ApiKeySummary[];
  boundKeyCount: number;
  boundKeysAvailable: boolean;
}) {
  if (!boundKeysAvailable) return <span className="faint">{boundKeyCountLabel(boundKeyCount)}</span>;
  if (!boundKeys || boundKeys.length === 0) return <span className="faint">no keys bound</span>;
  const hiddenCount = boundKeys.length - visibleBoundKeyCount;
  return (
    <div className="cell-tags scope-tags" title={boundKeys.map((apiKey) => apiKey.name).join("\n")}>
      {boundKeys.slice(0, visibleBoundKeyCount).map((apiKey) => (
        <span key={apiKey.id} className="code-pill">{apiKey.name}</span>
      ))}
      {hiddenCount > 0 ? <span className="code-pill scope-more">+{hiddenCount}</span> : null}
    </div>
  );
}

function boundKeyCountLabel(count: number) {
  if (count === 0) return "no keys bound";
  if (count === 1) return "1 key bound";
  return `${count} keys bound`;
}

function RevokeCredentialAction({ account, pending, error, onRevoke }: {
  account: ProviderAccountSummary;
  pending: boolean;
  error?: string;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (account.status !== "active") return null;
  return (
    <>
      <button
        className={confirming || pending ? "btn btn-sm btn-danger" : "btn btn-icon btn-ghost cell-action"}
        type="button"
        disabled={pending}
        title={confirming ? undefined : "Revoke key"}
        aria-label={confirming ? `Confirm revoking ${account.name}` : `Revoke ${account.name}`}
        onBlur={() => setConfirming(false)}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          onRevoke();
        }}
      >
        {revokeContent(pending, confirming)}
      </button>
      {error ? <div className="action-error">{error}</div> : null}
    </>
  );
}

function revokeContent(pending: boolean, confirming: boolean) {
  if (pending) return "Revoking...";
  if (confirming) return "Revoke?";
  return <Ban />;
}
