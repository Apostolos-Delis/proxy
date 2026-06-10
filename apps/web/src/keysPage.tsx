import { Link } from "@tanstack/react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Ban, ChevronDown, KeyRound, Plus, TerminalSquare, X } from "lucide-react";
import { useState } from "react";

import {
  assignApiKeyRoutingConfig,
  fetchApiKeys,
  fetchRoutingConfigs,
  revokeApiKey,
  type ApiKeySummary,
  type RoutingConfigSummary
} from "./routing/data";
import { apiKeyScopeOptions, CreateApiKeyPanel } from "./createApiKeyPanel";
import { compactId, formatDateTime } from "./format";
import { HarnessSetupCard } from "./harnessSetupCard";
import { ConsoleTable, type ConsoleTableAdvancedField, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { PageState, PageTitle, StatusBadge } from "./ui";

type AssignmentVariables = {
  apiKeyId: string;
  routingConfigId: string | null;
};

export function KeysPage() {
  const [openKeyId, setOpenKeyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [keysQuery, configsQuery] = useQueries({
    queries: [
      { queryKey: ["api-keys"], queryFn: fetchApiKeys },
      { queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs }
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
  const loading = keysQuery.isLoading || configsQuery.isLoading;
  const error = keysQuery.error ?? configsQuery.error;

  if (loading) return <PageState title="API keys" label="Loading API keys" />;
  if (error) return <PageState title="API keys" label={error.message} />;

  const keys = keysQuery.data ?? [];
  const configs = (configsQuery.data ?? []).filter(isAssignableConfig);
  return (
    <div className="page page-enter">
      <PageTitle
        title="API keys"
        subtitle="Attach each hashed key to a routing config, or let it use the organization default."
        actions={(
          <>
            <button className="btn" type="button" onClick={() => setShowSetup((open) => !open)}>
              <TerminalSquare />
              Setup guide
            </button>
            <Link to="/usage" className="btn"><BarChart3 />Key usage</Link>
            <button className="btn btn-primary" type="button" onClick={() => setShowCreate((open) => !open)}>
              {showCreate ? <X /> : <Plus />}
              {showCreate ? "Close" : "Create key"}
            </button>
          </>
        )}
      />
      {showCreate ? (
        <CreateApiKeyPanel
          configs={configs}
          onCreated={(created) => setCreatedSecret(created.secret)}
          onShowSetup={() => setShowSetup(true)}
        />
      ) : null}
      {showSetup ? <HarnessSetupCard secret={createdSecret} /> : null}
      <ConsoleTable
        className="routing-configs-card"
        data={keys}
        columns={apiKeyColumns({
          configs,
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
    { id: "name", header: "Name", size: 260, accessorFn: (apiKey) => apiKey.name, cell: ({ row }) => <ApiKeyNameCell apiKey={row.original} /> },
    { id: "status", header: "Status", size: 130, accessorFn: apiKeyStatus, cell: ({ row }) => <StatusBadge status={apiKeyStatus(row.original)} /> },
    { id: "routingConfig", header: "Routing config", size: 250, accessorFn: routingConfigLabel, cell: ({ row }) => (
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
    ) },
    { id: "scopes", header: "Scopes", size: 200, accessorFn: (apiKey) => apiKey.scopes.join(" "), cell: ({ row }) => <ScopesCell scopes={row.original.scopes} /> },
    { id: "owner", header: "Owner", size: 140, accessorFn: (apiKey) => apiKey.userId ?? "organization", cell: ({ row }) => <span className="mono">{row.original.userId ?? "organization"}</span> },
    { id: "created", header: "Created", size: 170, accessorFn: (apiKey) => apiKey.createdAt, cell: ({ row }) => formatDateTime(row.original.createdAt) },
    { id: "lastUsed", header: "Last used", size: 170, accessorFn: (apiKey) => apiKey.lastUsedAt ?? "", cell: ({ row }) => row.original.lastUsedAt ? formatDateTime(row.original.lastUsedAt) : <span className="faint">never</span> },
    { id: "actions", header: "", size: 120, enableSorting: false, enableHiding: false, accessorFn: () => "", cell: ({ row }) => (
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
        className={`btn btn-sm${confirming ? " btn-danger" : ""}`}
        type="button"
        disabled={pending}
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
        <Ban />
        {revokeLabel(pending, confirming)}
      </button>
      {error ? <div className="action-error">{error}</div> : null}
    </>
  );
}

function revokeLabel(pending: boolean, confirming: boolean) {
  if (pending) return "Revoking";
  return confirming ? "Confirm revoke" : "Revoke";
}

function ApiKeyNameCell({ apiKey }: { apiKey: ApiKeySummary }) {
  return (
    <>
      <div className="row gap-8"><KeyRound /><strong>{apiKey.name}</strong></div>
      <div className="key-id faint" title={apiKey.id}>
        <span>Key ID</span>
        <span className="mono">{compactId(apiKey.id, 14)}</span>
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
  const label = apiKey.routingConfig?.name ?? "Organization default";
  return (
    <div className="assignment-menu">
      <button className="btn btn-sm" type="button" disabled={pending} onClick={() => onOpenChange(!open)}>
        {pending ? "Updating" : label}
        <ChevronDown />
      </button>
      {open ? (
        <div className="assignment-popover">
          <button type="button" className={!apiKey.routingConfigId ? "active" : ""} onClick={() => onAssign(null)}>
            <strong>Organization default</strong>
            <span>Clear key-specific routing</span>
          </button>
          {configs.map((config) => (
            <button key={config.id} type="button" className={apiKey.routingConfigId === config.id ? "active" : ""} onClick={() => onAssign(config.id)}>
              <strong>{config.name}</strong>
              <span>v{config.activeVersion?.version ?? "?"} · {config.assignedApiKeyCount} keys</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function isAssignableConfig(config: RoutingConfigSummary) {
  return config.status === "active" && Boolean(config.activeVersion);
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
      getValue: apiKeyStatus
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
    apiKey.scopes.join(" ")
  ].filter((value): value is string => Boolean(value));
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

function optionItems(values: string[]) {
  return uniqueOptions(values).map((value) => ({ value, label: value }));
}

function uniqueOptionItems(values: { value: string; label: string }[]) {
  const options = new Map<string, string>();
  values.forEach((item) => {
    if (!options.has(item.value)) options.set(item.value, item.label);
  });
  return [...options].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function uniqueOptions(values: string[]) {
  return [...new Set(values)].filter(Boolean).sort();
}
