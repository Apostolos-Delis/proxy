import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Pencil, Plus, ServerCog } from "lucide-react";
import { useState } from "react";

import { Badge, GlassCard, StatusBadge } from "../ui";
import {
  disableProvider,
  type ProviderRegistrySummary
} from "./data";
import { ProviderFormModal, type ProviderFormMode } from "./registryFormModal";
import { ProviderMark } from "./icons";

export function ProviderRegistrySection({ providers }: { providers: ProviderRegistrySummary[] }) {
  const [formMode, setFormMode] = useState<ProviderFormMode | null>(null);
  const queryClient = useQueryClient();
  const refreshProviders = () => {
    queryClient.invalidateQueries({ queryKey: ["provider-registry"] });
    queryClient.invalidateQueries({ queryKey: ["routing-model-catalog"] });
    queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
  };
  const disableMutation = useMutation({
    mutationFn: disableProvider,
    onSuccess: refreshProviders
  });

  return (
    <section className="provider-registry">
      <div className="provider-registry-head">
        <div className="provider-registry-title">
          <ServerCog />
          <strong>Providers</strong>
          <span className="faint">{providers.length} configured</span>
        </div>
        <button className="btn btn-sm btn-primary" type="button" onClick={() => setFormMode({ kind: "create" })}>
          <Plus />Add provider
        </button>
      </div>
      <GlassCard className="provider-registry-card">
        {providers.map((provider) => (
          <ProviderRegistryRow
            key={provider.id}
            provider={provider}
            pendingDisableId={disableMutation.variables}
            disableError={disableMutation.variables === provider.id ? disableMutation.error?.message : undefined}
            onEdit={() => setFormMode({ kind: "edit", provider })}
            onDisable={() => disableMutation.mutate(provider.id)}
          />
        ))}
      </GlassCard>
      {formMode ? (
        <ProviderFormModal
          mode={formMode}
          onClose={() => setFormMode(null)}
          onSaved={() => {
            refreshProviders();
            setFormMode(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ProviderRegistryRow({ provider, pendingDisableId, disableError, onEdit, onDisable }: {
  provider: ProviderRegistrySummary;
  pendingDisableId?: string;
  disableError?: string;
  onEdit: () => void;
  onDisable: () => void;
}) {
  return (
    <div className={`provider-registry-row${provider.enabled ? "" : " inactive"}`}>
      <div className="provider-registry-main">
        <span className="provider-mark"><ProviderMark provider={provider.slug} /></span>
        <div>
          <strong>{provider.displayName}</strong>
          <div className="mono faint">{provider.slug}</div>
        </div>
      </div>
      <div className="provider-registry-url mono" title={provider.baseUrl}>{provider.baseUrl}</div>
      <div className="cell-tags scope-tags">
        <span className="code-pill">{provider.authStyle}</span>
        <span className="code-pill">{endpointLabel(provider)}</span>
        {Object.keys(headerRecord(provider.defaultHeaders)).length > 0 ? <span className="code-pill">headers</span> : null}
      </div>
      <div className="cell-tags scope-tags">
        {provider.builtin ? <Badge>builtin</Badge> : <Badge variant="accent">custom</Badge>}
        <StatusBadge status={provider.enabled ? "active" : "disabled"} />
      </div>
      <div className="provider-registry-actions">
        {provider.builtin ? null : (
          <>
            <button className="btn btn-icon btn-ghost cell-action" type="button" aria-label={`Edit ${provider.displayName}`} onClick={onEdit}>
              <Pencil />
            </button>
            {provider.enabled ? (
              <DisableProviderButton
                provider={provider}
                pending={pendingDisableId === provider.id}
                error={disableError}
                onDisable={onDisable}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function DisableProviderButton({ provider, pending, error, onDisable }: {
  provider: ProviderRegistrySummary;
  pending: boolean;
  error?: string;
  onDisable: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        className={confirming || pending ? "btn btn-sm btn-danger" : "btn btn-icon btn-ghost cell-action"}
        type="button"
        disabled={pending}
        aria-label={confirming ? `Confirm disabling ${provider.displayName}` : `Disable ${provider.displayName}`}
        onBlur={() => setConfirming(false)}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          onDisable();
        }}
      >
        {disableButtonContent(pending, confirming)}
      </button>
      {error ? <div className="action-error">{error}</div> : null}
    </>
  );
}

function disableButtonContent(pending: boolean, confirming: boolean) {
  if (pending) return "Disabling";
  if (confirming) return "Disable";
  return <Ban />;
}

function headerRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, string>;
}

function endpointLabel(provider: ProviderRegistrySummary) {
  if (provider.endpoints.length === 1) return provider.endpoints[0]?.dialect ?? "1 endpoint";
  return `${provider.endpoints.length} endpoints`;
}
