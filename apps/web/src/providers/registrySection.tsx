import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Pencil, Plus, ServerCog } from "lucide-react";
import { useState } from "react";

import {
  ConsoleTable,
  optionItems,
  uniqueOptionItems,
  type ConsoleTableColumn,
  type ConsoleTableFilter
} from "../table";
import { Badge, StatusIndicator } from "../ui";
import {
  disableProvider,
  type ProviderRegistrySummary
} from "./data";
import { ProviderFormModal, type ProviderFormMode } from "./registryFormModal";
import { ProviderMark } from "./icons";

type ProviderRegistryColumnConfig = {
  pendingDisableId?: string;
  disableErrorId?: string;
  disableErrorMessage?: string;
  onEdit: (provider: ProviderRegistrySummary) => void;
  onDisable: (providerId: string) => void;
};

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
      </div>
      <ConsoleTable
        className="provider-registry-table"
        urlState="providers"
        data={providers}
        columns={providerRegistryColumns({
          pendingDisableId: disableMutation.isPending ? disableMutation.variables : undefined,
          disableErrorId: disableMutation.error ? disableMutation.variables : undefined,
          disableErrorMessage: disableMutation.error?.message,
          onEdit: (provider) => setFormMode({ kind: "edit", provider }),
          onDisable: (providerId) => disableMutation.mutate(providerId)
        })}
        search={{ placeholder: "Search providers, protocols...", getValue: providerSearchValue }}
        filters={providerRegistryFilters(providers)}
        emptyLabel="No providers match these table controls."
        actions={() => (
          <button className="btn btn-sm btn-primary" type="button" onClick={() => setFormMode({ kind: "create" })}>
            <Plus />Add provider
          </button>
        )}
        getRowProps={(provider) => ({ className: provider.enabled ? "provider-registry-table-row" : "provider-registry-table-row inactive" })}
      />
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

function providerRegistryColumns({
  pendingDisableId,
  disableErrorId,
  disableErrorMessage,
  onEdit,
  onDisable
}: ProviderRegistryColumnConfig): ConsoleTableColumn<ProviderRegistrySummary>[] {
  return [
    {
      id: "provider",
      header: "Provider",
      accessorFn: (provider) => provider.displayName,
      size: 190,
      cell: ({ row }) => (
        <div className="provider-registry-main">
          <span className="provider-mark"><ProviderMark provider={row.original.slug} /></span>
          <div>
            <strong>{row.original.displayName}</strong>
            <div className="mono faint">{row.original.slug}</div>
          </div>
        </div>
      )
    },
    {
      id: "baseUrl",
      header: "Base URL",
      accessorFn: (provider) => provider.baseUrl,
      size: 275,
      cell: ({ row }) => <div className="provider-registry-url mono" title={row.original.baseUrl}>{row.original.baseUrl}</div>
    },
    {
      id: "protocol",
      header: "Protocol",
      accessorFn: (provider) => `${provider.authStyle} ${endpointLabel(provider)} ${Object.keys(headerRecord(provider.defaultHeaders)).join(" ")}`,
      size: 245,
      cell: ({ row }) => (
        <div className="cell-tags scope-tags provider-registry-endpoints">
          <span className="code-pill">{row.original.authStyle}</span>
          <span className="code-pill">{endpointLabel(row.original)}</span>
          {Object.keys(headerRecord(row.original.defaultHeaders)).length > 0 ? <span className="code-pill">headers</span> : null}
        </div>
      )
    },
    {
      id: "state",
      header: "State",
      accessorFn: (provider) => provider.enabled ? "active" : "disabled",
      size: 155,
      cell: ({ row }) => (
        <div className="cell-tags scope-tags provider-registry-state">
          {row.original.builtin ? <Badge>builtin</Badge> : <Badge variant="accent">custom</Badge>}
          <StatusIndicator status={row.original.enabled ? "active" : "disabled"} />
        </div>
      )
    },
    {
      id: "actions",
      header: "Actions",
      enableSorting: false,
      enableHiding: false,
      size: 90,
      cell: ({ row }) => (
        <div className="provider-registry-actions">
          {row.original.builtin ? null : (
            <>
              <button className="btn btn-icon btn-ghost cell-action" type="button" aria-label={`Edit ${row.original.displayName}`} onClick={() => onEdit(row.original)}>
                <Pencil />
              </button>
              {row.original.enabled ? (
                <DisableProviderButton
                  provider={row.original}
                  pending={pendingDisableId === row.original.id}
                  error={disableErrorId === row.original.id ? disableErrorMessage : undefined}
                  onDisable={() => onDisable(row.original.id)}
                />
              ) : null}
            </>
          )}
        </div>
      )
    }
  ];
}

function providerSearchValue(provider: ProviderRegistrySummary) {
  return [
    provider.displayName,
    provider.slug,
    provider.baseUrl,
    provider.authStyle,
    endpointLabel(provider),
    provider.builtin ? "builtin" : "custom",
    provider.enabled ? "active" : "disabled"
  ];
}

function providerRegistryFilters(providers: ProviderRegistrySummary[]): ConsoleTableFilter<ProviderRegistrySummary>[] {
  return [
    {
      id: "kind",
      label: "Kind",
      allLabel: "All kinds",
      options: uniqueOptionItems(providers.map((provider) => ({
        value: provider.builtin ? "builtin" : "custom",
        label: provider.builtin ? "Builtin" : "Custom"
      }))),
      getValue: (provider) => provider.builtin ? "builtin" : "custom"
    },
    {
      id: "state",
      label: "State",
      allLabel: "All states",
      options: optionItems(providers.map((provider) => provider.enabled ? "active" : "disabled")),
      getValue: (provider) => provider.enabled ? "active" : "disabled"
    }
  ];
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
