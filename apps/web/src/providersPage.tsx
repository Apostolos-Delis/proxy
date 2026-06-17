import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import {
  fetchProviderAccounts,
  fetchProviderRegistry,
  revokeProviderCredential
} from "./providers/data";
import { ProviderKeyDetailPanel } from "./providers/detailPanel";
import { ProviderCredentialsTable } from "./providers/credentialsTable";
import { boundKeysByAccount } from "./providers/credentialsTableData";
import { ProviderRegistrySection } from "./providers/registrySection";
import { CreateProviderKeyModal } from "./createProviderKeyModal";
import { fetchApiKeys } from "./routing/data";
import { PageState } from "./ui";
import { fetchUserDirectory, type UserDirectory } from "./userDirectory";

export function ProvidersPage() {
  const [showCreate, setShowCreate] = useState(false);
  const search = useSearch({ strict: false }) as { key?: unknown };
  const openAccountId = typeof search.key === "string" ? search.key : null;
  const navigate = useNavigate();
  const setOpenAccountId = (accountId: string | null) =>
    void navigate({ to: ".", search: (current) => ({ ...current, key: accountId ?? undefined }), replace: true });
  const queryClient = useQueryClient();
  const { isLoading: accountsQueryIsLoading, error: accountsQueryError, data: accountsQueryData } = useQuery({ queryKey: ["provider-accounts"], queryFn: fetchProviderAccounts });
  const { isLoading: registryQueryIsLoading, error: registryQueryError, data: registryQueryData } = useQuery({ queryKey: ["provider-registry"], queryFn: fetchProviderRegistry });
  const { isLoading: usersQueryIsLoading, error: usersQueryError, data: usersQueryData } = useQuery({ queryKey: ["user-directory"], queryFn: fetchUserDirectory });
  const { data: keysQueryData } = useQuery({ queryKey: ["api-keys"], queryFn: fetchApiKeys });
  const revokeMutation = useMutation({
    mutationFn: (providerAccountId: string) => revokeProviderCredential(providerAccountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    }
  });

  if (accountsQueryIsLoading || registryQueryIsLoading || usersQueryIsLoading) return <PageState title="Model providers" label="Loading model providers" />;
  const error = accountsQueryError ?? registryQueryError ?? usersQueryError;
  if (error) return <PageState title="Model providers" label={error.message} />;

  const accounts = accountsQueryData ?? [];
  const providers = registryQueryData ?? [];
  const users: UserDirectory = usersQueryData ?? new Map();
  const boundKeys = keysQueryData ? boundKeysByAccount(keysQueryData) : null;
  const openAccount = accounts.find((account) => account.id === openAccountId);
  return (
    <div className="page page-enter providers-page">
      {showCreate ? <CreateProviderKeyModal onClose={() => setShowCreate(false)} /> : null}
      {openAccount ? <ProviderKeyDetailPanel account={openAccount} onClose={() => setOpenAccountId(null)} /> : null}
      <ProviderRegistrySection providers={providers} />
      <ProviderCredentialsTable
        accounts={accounts}
        providers={providers}
        users={users}
        boundKeys={boundKeys}
        revokePendingId={revokeMutation.isPending ? revokeMutation.variables : undefined}
        revokeErrorId={revokeMutation.error ? revokeMutation.variables : undefined}
        revokeErrorMessage={revokeMutation.error?.message}
        onCreate={() => setShowCreate(true)}
        onRevoke={(providerAccountId) => revokeMutation.mutate(providerAccountId)}
        onOpen={(providerAccountId) => setOpenAccountId(providerAccountId)}
      />
    </div>
  );
}
