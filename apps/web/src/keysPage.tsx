import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Plus, TerminalSquare } from "lucide-react";
import { useState } from "react";

import {
  assignApiKeyRoutingConfig,
  fetchApiKeys,
  fetchRoutingConfigs,
  isAssignableConfig,
  revokeApiKey,
  type ApiKeySummary
} from "./routing/data";
import { fetchProviderAccounts } from "./providers/data";
import { Drawer } from "./drawer";
import { HarnessSetupGuide } from "./harnessSetupCard";
import { apiKeyColumns } from "./keys/apiKeyColumns";
import { ApiKeyDetailPanel } from "./keys/detailPanel";
import { apiKeySearchValue, apiKeyStatus, routingConfigFilterValue, routingConfigLabel } from "./keys/apiKeyTableData";
import { ConsoleTable, optionItems, uniqueOptionItems, type ConsoleTableAdvancedField, type ConsoleTableFilter } from "./table";
import { PageState, PageTitle } from "./ui";
import { fetchUserDirectory, ownerLabel, type UserDirectory } from "./userDirectory";

type AssignmentVariables = {
  apiKeyId: string;
  routingConfigId: string | null;
};

export function KeysPage() {
  const [openKeyId, setOpenKeyId] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  // The open slideout lives in the URL (?key=<id>) so API keys can be deep-linked.
  const search = useSearch({ strict: false }) as { key?: unknown };
  const inspectKeyId = typeof search.key === "string" ? search.key : null;
  const navigate = useNavigate();
  const setInspectKeyId = (apiKeyId: string | null) =>
    void navigate({ to: ".", search: (current) => ({ ...current, key: apiKeyId ?? undefined }), replace: true });
  const queryClient = useQueryClient();
  const [keysQuery, configsQuery, providerAccountsQuery, usersQuery] = useQueries({
    queries: [
      { queryKey: ["api-keys"], queryFn: fetchApiKeys },
      { queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs },
      { queryKey: ["provider-accounts"], queryFn: fetchProviderAccounts },
      { queryKey: ["user-directory"], queryFn: fetchUserDirectory }
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
  const loading = keysQuery.isLoading || configsQuery.isLoading || providerAccountsQuery.isLoading || usersQuery.isLoading;
  const error = keysQuery.error ?? configsQuery.error ?? providerAccountsQuery.error ?? usersQuery.error;

  if (loading) return <PageState title="API keys" label="Loading API keys" />;
  if (error) return <PageState title="API keys" label={error.message} />;

  const keys = keysQuery.data ?? [];
  const configs = (configsQuery.data ?? []).filter(isAssignableConfig);
  const providerAccounts = providerAccountsQuery.data ?? [];
  const users: UserDirectory = usersQuery.data ?? new Map();
  const inspectKey = keys.find((apiKey) => apiKey.id === inspectKeyId);
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
      {inspectKey ? <ApiKeyDetailPanel apiKey={inspectKey} onClose={() => setInspectKeyId(null)} /> : null}
      <ConsoleTable
        className="routing-configs-card"
        urlState
        data={keys}
        columns={apiKeyColumns({
          configs,
          providerAccounts,
          users,
          openKeyId,
          pendingKeyId: assignmentMutation.isPending ? assignmentMutation.variables?.apiKeyId : undefined,
          errorKeyId: assignmentMutation.variables?.apiKeyId,
          errorMessage: assignmentMutation.error?.message,
          onOpenChange: (apiKeyId, open) => setOpenKeyId(open ? apiKeyId : null),
          onAssign: (apiKeyId, routingConfigId) => assignmentMutation.mutate({ apiKeyId, routingConfigId }),
          onInspect: (apiKeyId) => setInspectKeyId(apiKeyId),
          revokePendingKeyId: revokeMutation.isPending ? revokeMutation.variables : undefined,
          revokeErrorKeyId: revokeMutation.error ? revokeMutation.variables : undefined,
          revokeErrorMessage: revokeMutation.error?.message,
          onRevoke: (apiKeyId) => revokeMutation.mutate(apiKeyId)
        })}
        search={{ placeholder: "Search keys, owners, routing...", getValue: (apiKey) => [...apiKeySearchValue(apiKey), ownerLabel(users, apiKey.userId)] }}
        filters={apiKeyFilters(keys)}
        advancedFields={apiKeyAdvancedFields(users)}
        emptyLabel="No API keys found."
      />
    </div>
  );
}

function apiKeyAdvancedFields(users: UserDirectory): ConsoleTableAdvancedField<ApiKeySummary>[] {
  return [
    { id: "name", label: "Name", getValue: (apiKey) => apiKey.name },
    { id: "keyId", label: "Key ID", getValue: (apiKey) => apiKey.id },
    { id: "status", label: "Status", getValue: apiKeyStatus },
    { id: "routingConfig", label: "Routing", getValue: routingConfigLabel },
    { id: "owner", label: "Owner", getValue: (apiKey) => ownerLabel(users, apiKey.userId) }
  ];
}

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
      label: "Routing",
      allLabel: "All configs",
      options: uniqueOptionItems(routingValues),
      getValue: routingConfigFilterValue
    }
  ];
}
