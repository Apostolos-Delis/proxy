import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, KeyRound, Plus } from "lucide-react";
import { useState } from "react";

import { assignApiKeyRoutingConfig, fetchApiKeys, type ApiKeySummary } from "../api";
import { formatDateTime } from "../format";
import { GlassCard } from "../ui";

export function ConfigApiKeysCard({ configId }: { configId: string }) {
  const [attachOpen, setAttachOpen] = useState(false);
  const queryClient = useQueryClient();
  const keysQuery = useQuery({ queryKey: ["api-keys"], queryFn: fetchApiKeys });
  const assignMutation = useMutation({
    mutationFn: (input: { apiKeyId: string; routingConfigId: string | null }) =>
      assignApiKeyRoutingConfig(input.apiKeyId, input.routingConfigId),
    onSuccess: () => {
      setAttachOpen(false);
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
      queryClient.invalidateQueries({ queryKey: ["routing-config", configId] });
    }
  });
  const keys = (keysQuery.data?.data ?? []).filter(isUsableKey);
  const assigned = keys.filter((key) => key.routingConfigId === configId);
  const attachable = keys.filter((key) => key.routingConfigId !== configId);

  return (
    <GlassCard className="config-keys-card">
      <div className="card-head">
        <div>
          <div className="card-title"><KeyRound />API keys</div>
          <div className="faint">Requests authenticated with these keys route through this config.</div>
        </div>
        <div className="assignment-menu config-keys-attach">
          <button
            className="btn"
            type="button"
            disabled={attachable.length === 0 || assignMutation.isPending}
            onClick={() => setAttachOpen((open) => !open)}
          >
            <Plus />
            Attach key
            <ChevronDown />
          </button>
          {attachOpen ? (
            <div className="assignment-popover">
              {attachable.map((key) => (
                <button
                  key={key.id}
                  type="button"
                  onClick={() => assignMutation.mutate({ apiKeyId: key.id, routingConfigId: configId })}
                >
                  <strong>{key.name}</strong>
                  <span>currently {keyConfigLabel(key)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <AssignedKeyRows
        loading={keysQuery.isLoading}
        assigned={assigned}
        pendingKeyId={assignMutation.isPending ? assignMutation.variables?.apiKeyId : undefined}
        onDetach={(apiKeyId) => assignMutation.mutate({ apiKeyId, routingConfigId: null })}
      />
      {keysQuery.error ? <div className="action-error">{keysQuery.error.message}</div> : null}
      {assignMutation.error ? <div className="action-error">{assignMutation.error.message}</div> : null}
    </GlassCard>
  );
}

function AssignedKeyRows({ loading, assigned, pendingKeyId, onDetach }: {
  loading: boolean;
  assigned: ApiKeySummary[];
  pendingKeyId?: string;
  onDetach: (apiKeyId: string) => void;
}) {
  if (loading) return <div className="faint">Loading API keys…</div>;
  if (assigned.length === 0) {
    return (
      <div className="empty compact-empty">
        No API keys use this config yet. Attach a key to route its traffic here.
      </div>
    );
  }
  return (
    <div className="config-key-rows">
      {assigned.map((key) => (
        <div key={key.id} className="config-key-row">
          <KeyRound />
          <div className="config-key-facts">
            <strong>{key.name}</strong>
            <span className="faint">
              owner <span className="mono">{key.userId ?? "organization"}</span>
              {" · "}
              {key.lastUsedAt ? `last used ${formatDateTime(key.lastUsedAt)}` : "never used"}
            </span>
          </div>
          <button
            className="btn btn-sm"
            type="button"
            disabled={pendingKeyId === key.id}
            title="The key falls back to the organization default config"
            onClick={() => onDetach(key.id)}
          >
            {pendingKeyId === key.id ? "Detaching" : "Detach"}
          </button>
        </div>
      ))}
    </div>
  );
}

export function KeyPickList({ keys, selectedIds, onToggle }: {
  keys: ApiKeySummary[];
  selectedIds: ReadonlySet<string>;
  onToggle: (keyId: string) => void;
}) {
  if (keys.length === 0) {
    return <div className="faint">No active API keys found. You can attach keys later from the config page.</div>;
  }
  return (
    <div className="key-pick-list">
      {keys.map((key) => (
        <label key={key.id} className="key-pick-row">
          <input type="checkbox" checked={selectedIds.has(key.id)} onChange={() => onToggle(key.id)} />
          <KeyRound />
          <span className="key-pick-name">{key.name}</span>
          <span className="faint">currently {keyConfigLabel(key)}</span>
        </label>
      ))}
    </div>
  );
}

export function isUsableKey(key: ApiKeySummary) {
  if (key.revokedAt) return false;
  return !key.expiresAt || new Date(key.expiresAt).getTime() >= Date.now();
}

function keyConfigLabel(key: ApiKeySummary) {
  return key.routingConfig?.name ?? "Organization default";
}
