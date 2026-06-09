import { Link } from "@tanstack/react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { BarChart3, ChevronDown, KeyRound } from "lucide-react";
import { useState } from "react";

import {
  assignApiKeyRoutingConfig,
  fetchApiKeys,
  fetchRoutingConfigs,
  type ApiKeySummary,
  type RoutingConfigSummary
} from "./api";
import { compactId, formatDateTime } from "./format";
import { Badge, DataTable, GlassCard, PageState, PageTitle, StatusBadge } from "./ui";

type AssignmentVariables = {
  apiKeyId: string;
  routingConfigId: string | null;
};

export function KeysPage() {
  const [openKeyId, setOpenKeyId] = useState<string | null>(null);
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
  const loading = keysQuery.isLoading || configsQuery.isLoading;
  const error = keysQuery.error ?? configsQuery.error;

  if (loading) return <PageState title="API keys" label="Loading API keys" />;
  if (error) return <PageState title="API keys" label={error.message} />;

  const keys = keysQuery.data?.data ?? [];
  const configs = (configsQuery.data?.data ?? []).filter(isAssignableConfig);
  return (
    <div className="page page-enter">
      <PageTitle
        title="API keys"
        subtitle="Attach each hashed key to a routing config, or let it use the organization default."
        actions={<Link to="/usage" className="btn"><BarChart3 />Key usage</Link>}
      />
      <GlassCard className="table-wrap routing-configs-card">
        <DataTable>
          <thead><tr><th>Name</th><th>Status</th><th>Routing config</th><th>Scopes</th><th>Owner</th><th>Created</th><th>Last used</th></tr></thead>
          <tbody>
            {keys.map((apiKey) => (
              <ApiKeyRow
                key={apiKey.id}
                apiKey={apiKey}
                configs={configs}
                open={openKeyId === apiKey.id}
                pending={assignmentMutation.isPending && assignmentMutation.variables?.apiKeyId === apiKey.id}
                error={assignmentMutation.variables?.apiKeyId === apiKey.id ? assignmentMutation.error?.message : undefined}
                onOpenChange={(open) => setOpenKeyId(open ? apiKey.id : null)}
                onAssign={(routingConfigId) => assignmentMutation.mutate({ apiKeyId: apiKey.id, routingConfigId })}
              />
            ))}
          </tbody>
        </DataTable>
        {keys.length === 0 ? <div className="empty">No API keys found.</div> : null}
      </GlassCard>
    </div>
  );
}

function ApiKeyRow({ apiKey, configs, open, pending, error, onOpenChange, onAssign }: {
  apiKey: ApiKeySummary;
  configs: RoutingConfigSummary[];
  open: boolean;
  pending: boolean;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onAssign: (routingConfigId: string | null) => void;
}) {
  return (
    <tr>
      <td>
        <div className="row gap-8"><KeyRound /><strong>{apiKey.name}</strong></div>
        <div className="mono faint">{compactId(apiKey.id, 14)}</div>
      </td>
      <td><StatusBadge status={apiKeyStatus(apiKey)} /></td>
      <td>
        <AssignmentMenu
          apiKey={apiKey}
          configs={configs}
          open={open}
          pending={pending}
          onOpenChange={onOpenChange}
          onAssign={onAssign}
        />
        {error ? <div className="action-error">{error}</div> : null}
      </td>
      <td>{apiKey.scopes.map((scope) => <Badge key={scope}>{scope}</Badge>)}</td>
      <td><span className="mono">{apiKey.userId ?? "organization"}</span></td>
      <td>{formatDateTime(apiKey.createdAt)}</td>
      <td>{apiKey.lastUsedAt ? formatDateTime(apiKey.lastUsedAt) : <span className="faint">never</span>}</td>
    </tr>
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
      <div className="faint assignment-subtitle">{apiKey.routingConfig ? apiKey.routingConfig.status ?? "assigned" : "fallback"}</div>
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

function apiKeyStatus(apiKey: ApiKeySummary) {
  if (apiKey.revokedAt) return "revoked";
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() < Date.now()) return "expired";
  return "active";
}
