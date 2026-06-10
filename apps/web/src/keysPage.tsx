import { Link } from "@tanstack/react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Ban, ChevronDown, Plus, TerminalSquare } from "lucide-react";
import { useRef, useState } from "react";

import {
  assignApiKeyRoutingConfig,
  fetchApiKeys,
  fetchRoutingConfigs,
  isAssignableConfig,
  isDefaultConfig,
  revokeApiKey,
  type ApiKeySummary,
  type RoutingConfigSummary
} from "./routing/data";
import { fetchProviderAccounts, type ProviderAccountSummary } from "./providers/data";
import { ApiKeyProviderBinding } from "./apiKeyProviderBinding";
import { Drawer } from "./drawer";
import { compactId, formatDate, formatDateTime } from "./format";
import { HarnessSetupGuide } from "./harnessSetupCard";
import { apiKeyScopeOptions } from "./keys/scopeOptions";
import { ConsoleTable, optionItems, uniqueOptionItems, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { AnchoredPopover } from "./table/PopoverShell";
import { PageState, PageTitle, StatusBadge } from "./ui";

type AssignmentVariables = {
  apiKeyId: string;
  routingConfigId: string | null;
};

export function KeysPage() {
  const [openKeyId, setOpenKeyId] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const queryClient = useQueryClient();
  const [keysQuery, configsQuery, providerAccountsQuery] = useQueries({
    queries: [
      { queryKey: ["api-keys"], queryFn: fetchApiKeys },
      { queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs },
      { queryKey: ["provider-accounts"], queryFn: fetchProviderAccounts }
    ]
  });
  const assignmentMutation = useMutation({
    mutationFn: (input: AssignmentVariables) => assignApiKeyRoutingConfig(input.apiKeyId, input.routingConfigId),
    onSuccess: () => {
      setOpenKeyId(null);
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
    }
  });
  const revokeMutation = useMutation({
    mutationFn: (apiKeyId: string) => revokeApiKey(apiKeyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
    }
  });
  const loading = keysQuery.isLoading || configsQuery.isLoading || providerAccountsQuery.isLoading;
  const error = keysQuery.error ?? configsQuery.error ?? providerAccountsQuery.error;

  if (loading) return <PageState title="API keys" label="Loading API keys" />;
  if (error) return <PageState title="API keys" label={error.message} />;

  const keys = keysQuery.data ?? [];
  const configs = (configsQuery.data ?? []).filter(isAssignableConfig);
  const providerAccounts = providerAccountsQuery.data ?? [];
  return (
    <div className="page page-enter">
      <PageTitle
        title="API keys"
        subtitle="Attach each hashed key to a routing config, or let it use the organization default."
        actions={(
          <>
            <button className="btn" type="button" onClick={() => setShowSetup(true)}>
              <TerminalSquare />
              Setup guide
            </button>
            <Link to="/usage" className="btn"><BarChart3 />Key usage</Link>
            <Link to="/api-keys/new" className="btn btn-primary"><Plus />Create key</Link>
          </>
        )}
      />
      {showSetup ? (
        <Drawer label="Harness setup guide" onClose={() => setShowSetup(false)}>
          <HarnessSetupGuide secret={null} />
        </Drawer>
      ) : null}
      <ConsoleTable
        className="routing-configs-card"
        urlState
        data={keys}
        columns={apiKeyColumns({
          configs,
          providerAccounts,
          openKeyId,
          pendingKeyId: assignmentMutation.isPending ? assignmentMutation.variables?.apiKeyId : undefined,
          errorKeyId: assignmentMutation.variables?.apiKeyId,
          errorMessage: assignmentMutation.error?.message,
          onOpenChange: (apiKeyId, open) => setOpenKeyId(open ? apiKeyId : null),
          onAssign: (apiKeyId, routingConfigId) => assignmentMutation.mutate({ apiKeyId, routingConfigId }),
          revokePendingKeyId: revokeMutation.isPending ? revokeMutation.variables : undefined,
          revokeErrorKeyId: revokeMutation.error ? revokeMutation.variables : undefined,
          revokeErrorMessage: revokeMutation.error?.message,
          onRevoke: (apiKeyId) => revokeMutation.mutate(apiKeyId)
        })}
        search={{ placeholder: "Search keys, scopes, owners...", getValue: apiKeySearchValue }}
        filters={apiKeyFilters(keys)}
        advancedFields={apiKeyAdvancedFields}
        emptyLabel="No API keys found."
      />
    </div>
  );
}

function apiKeyColumns({
  configs,
  providerAccounts,
  openKeyId,
  pendingKeyId,
  errorKeyId,
  errorMessage,
  onOpenChange,
  onAssign,
  revokePendingKeyId,
  revokeErrorKeyId,
  revokeErrorMessage,
  onRevoke
}: {
  configs: RoutingConfigSummary[];
  providerAccounts: ProviderAccountSummary[];
  openKeyId: string | null;
  pendingKeyId?: string;
  errorKeyId?: string;
  errorMessage?: string;
  onOpenChange: (apiKeyId: string, open: boolean) => void;
  onAssign: (apiKeyId: string, routingConfigId: string | null) => void;
  revokePendingKeyId?: string;
  revokeErrorKeyId?: string;
  revokeErrorMessage?: string;
  onRevoke: (apiKeyId: string) => void;
}): ConsoleTableColumn<ApiKeySummary>[] {
  return [
    { id: "name", header: "Name", size: 225, accessorFn: (apiKey) => apiKey.name, cell: ({ row }) => <ApiKeyNameCell apiKey={row.original} /> },
    { id: "status", header: "Status", size: 96, accessorFn: apiKeyStatus, cell: ({ row }) => <StatusBadge status={apiKeyStatus(row.original)} /> },
    { id: "routingConfig", header: "Routing config", size: 200, accessorFn: routingConfigLabel, cell: ({ row }) => (
      apiKeyStatus(row.original) === "active" ? (
        <>
          <AssignmentMenu
            apiKey={row.original}
            configs={configs}
            open={openKeyId === row.original.id}
            pending={pendingKeyId === row.original.id}
            onOpenChange={(open) => onOpenChange(row.original.id, open)}
            onAssign={(routingConfigId) => onAssign(row.original.id, routingConfigId)}
          />
          {errorKeyId === row.original.id && errorMessage ? <div className="action-error">{errorMessage}</div> : null}
        </>
      ) : (
        <span className="faint">{routingConfigLabel(row.original)}</span>
      )
    ) },
    { id: "providerKey", header: "Provider key", size: 220, enableSorting: false, accessorFn: providerBindingValue, cell: ({ row }) => <ApiKeyProviderBinding apiKey={row.original} providerAccounts={providerAccounts} /> },
    { id: "scopes", header: "Scopes", size: 215, accessorFn: (apiKey) => apiKey.scopes.join(" "), cell: ({ row }) => <ScopesCell scopes={row.original.scopes} /> },
    { id: "owner", header: "Owner", size: 115, accessorFn: (apiKey) => apiKey.userId ?? "organization", cell: ({ row }) => (
      row.original.userId ? <span className="mono">{row.original.userId}</span> : <span className="faint">Organization</span>
    ) },
    { id: "created", header: "Created", size: 105, accessorFn: (apiKey) => apiKey.createdAt, cell: ({ row }) => (
      <span className="nowrap" title={formatDateTime(row.original.createdAt)}>{formatDate(row.original.createdAt)}</span>
    ) },
    { id: "lastUsed", header: "Last used", size: 105, accessorFn: (apiKey) => apiKey.lastUsedAt ?? "", cell: ({ row }) => (
      row.original.lastUsedAt
        ? <span className="nowrap" title={formatDateTime(row.original.lastUsedAt)}>{formatDate(row.original.lastUsedAt)}</span>
        : <span className="faint">Never</span>
    ) },
    { id: "actions", header: "", size: 88, enableSorting: false, enableHiding: false, accessorFn: () => "", cell: ({ row }) => (
      <RevokeKeyAction
        apiKey={row.original}
        pending={revokePendingKeyId === row.original.id}
        error={revokeErrorKeyId === row.original.id ? revokeErrorMessage : undefined}
        onRevoke={() => onRevoke(row.original.id)}
      />
    ) }
  ];
}

const visibleScopeCount = 2;

function ScopesCell({ scopes }: { scopes: string[] }) {
  const hiddenCount = scopes.length - visibleScopeCount;
  return (
    <div className="cell-tags scope-tags" title={scopes.map(scopeTitle).join("\n")}>
      {scopes.slice(0, visibleScopeCount).map((scope) => <span key={scope} className="code-pill">{scope}</span>)}
      {hiddenCount > 0 ? <span className="code-pill scope-more">+{hiddenCount}</span> : null}
    </div>
  );
}

function scopeTitle(scope: string) {
  const description = apiKeyScopeOptions.find((option) => option.value === scope)?.description;
  return description ? `${scope} — ${description}` : scope;
}

function RevokeKeyAction({ apiKey, pending, error, onRevoke }: {
  apiKey: ApiKeySummary;
  pending: boolean;
  error?: string;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (apiKey.revokedAt) return null;
  return (
    <>
      <button
        className={confirming || pending ? "btn btn-sm btn-danger" : "btn btn-icon btn-ghost cell-action"}
        type="button"
        disabled={pending}
        title={confirming ? undefined : "Revoke key"}
        aria-label={confirming ? `Confirm revoking ${apiKey.name}` : `Revoke ${apiKey.name}`}
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
  if (pending) return "Revoking…";
  if (confirming) return "Revoke?";
  return <Ban />;
}

function ApiKeyNameCell({ apiKey }: { apiKey: ApiKeySummary }) {
  return (
    <>
      <div className="key-name">{apiKey.name}</div>
      <div className="key-id faint" title={apiKey.id}>
        <span>Key ID</span>
        <span className="mono">{compactId(apiKey.id, 9)}</span>
      </div>
    </>
  );
}

function AssignmentMenu({ apiKey, configs, open, pending, onOpenChange, onAssign }: {
  apiKey: ApiKeySummary;
  configs: RoutingConfigSummary[];
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onAssign: (routingConfigId: string | null) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = apiKey.routingConfig?.name ?? "Organization default";
  const options = configs.filter((config) => !isDefaultConfig(config) || apiKey.routingConfigId === config.id);
  return (
    <div
      className="assignment-menu"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        onOpenChange(false);
      }}
    >
      <button
        ref={triggerRef}
        className={`cell-select${apiKey.routingConfig ? "" : " unset"}`}
        type="button"
        disabled={pending}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>{pending ? "Updating…" : label}</span>
        <ChevronDown />
      </button>
      {open ? (
        <AnchoredPopover anchorRef={triggerRef} onDismiss={() => onOpenChange(false)}>
          <div className="assignment-popover">
            <button type="button" className={!apiKey.routingConfigId ? "active" : ""} onClick={() => onAssign(null)}>
              <strong>Organization default</strong>
              <span>Clear key-specific routing</span>
            </button>
            {options.map((config) => (
              <button key={config.id} type="button" className={apiKey.routingConfigId === config.id ? "active" : ""} onClick={() => onAssign(config.id)}>
                <strong>{config.name}</strong>
                <span>v{config.activeVersion?.version ?? "?"} · {config.assignedApiKeyCount} keys</span>
              </button>
            ))}
          </div>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}

const apiKeyAdvancedFields: ConsoleTableAdvancedField<ApiKeySummary>[] = [
  { id: "name", label: "Name", getValue: (apiKey) => apiKey.name },
  { id: "keyId", label: "Key ID", getValue: (apiKey) => apiKey.id },
  { id: "status", label: "Status", getValue: apiKeyStatus },
  { id: "routingConfig", label: "Routing config", getValue: routingConfigLabel },
  { id: "owner", label: "Owner", getValue: (apiKey) => apiKey.userId ?? "organization" },
  { id: "scopes", label: "Scopes", getValue: (apiKey) => apiKey.scopes }
];

function apiKeyFilters(keys: ApiKeySummary[]): ConsoleTableFilter<ApiKeySummary>[] {
  const routingValues = keys.map((apiKey) => ({ value: routingConfigFilterValue(apiKey), label: routingConfigLabel(apiKey) }));
  return [
    {
      id: "status",
      label: "Status",
      allLabel: "All statuses",
      options: optionItems(keys.map(apiKeyStatus)),
      getValue: apiKeyStatus,
      defaultValue: "active"
    },
    {
      id: "routingConfig",
      label: "Routing config",
      allLabel: "All configs",
      options: uniqueOptionItems(routingValues),
      getValue: routingConfigFilterValue
    }
  ];
}

function apiKeySearchValue(apiKey: ApiKeySummary) {
  return [
    apiKey.id,
    apiKey.name,
    apiKey.userId,
    apiKey.routingConfig?.name,
    apiKey.routingConfig?.status,
    apiKey.scopes.join(" "),
    providerBindingValue(apiKey)
  ].filter((value): value is string => Boolean(value));
}

function providerBindingValue(apiKey: ApiKeySummary) {
  if (apiKey.providerCredentials.length === 0) return "company default";
  return apiKey.providerCredentials
    .map((binding) => `${binding.provider} ${binding.name ?? ""}`.trim())
    .join(" ");
}

function apiKeyStatus(apiKey: ApiKeySummary) {
  if (apiKey.revokedAt) return "revoked";
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() < Date.now()) return "expired";
  return "active";
}

function routingConfigFilterValue(apiKey: ApiKeySummary) {
  return apiKey.routingConfigId ?? "default";
}

function routingConfigLabel(apiKey: ApiKeySummary) {
  return apiKey.routingConfig?.name ?? "Organization default";
}

