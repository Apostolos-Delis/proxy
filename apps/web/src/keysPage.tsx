import { Link } from "@tanstack/react-router";
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
import { apiKeySearchValue, apiKeyStatus, routingConfigFilterValue, routingConfigLabel } from "./keys/apiKeyTableData";
import { ConsoleTable, optionItems, uniqueOptionItems, type ConsoleTableAdvancedField, type ConsoleTableFilter } from "./table";
import { PageState, PageTitle } from "./ui";

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
