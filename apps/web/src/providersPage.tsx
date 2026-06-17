import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { KeyRound, Plus, Search, X } from "lucide-react";
import { useState } from "react";

import {
  fetchProviderAccounts,
  fetchProviderRegistry,
  revokeProviderCredential
} from "./providers/data";
import { ProviderKeyDetailPanel } from "./providers/detailPanel";
import { ProviderGroupsList } from "./providers/groupedList";
import { boundKeysByAccount } from "./providers/groupedListData";
import { ProviderRegistrySection } from "./providers/registrySection";
import { CreateProviderKeyModal } from "./createProviderKeyModal";
import { fetchApiKeys } from "./routing/data";
import { PageState } from "./ui";
import { fetchUserDirectory, type UserDirectory } from "./userDirectory";

export function ProvidersPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [searchValue, setSearchValue] = useState("");
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
  let credentialCount = `${accounts.length} saved`;
  if (accounts.length === 0) credentialCount = "no credentials";
  if (accounts.length === 1) credentialCount = "1 saved";
  const providers = registryQueryData ?? [];
  const users: UserDirectory = usersQueryData ?? new Map();
  const boundKeys = keysQueryData ? boundKeysByAccount(keysQueryData) : null;
  const openAccount = accounts.find((account) => account.id === openAccountId);
  return (
    <div className="page page-enter providers-page">
      {showCreate ? <CreateProviderKeyModal onClose={() => setShowCreate(false)} /> : null}
      {openAccount ? <ProviderKeyDetailPanel account={openAccount} onClose={() => setOpenAccountId(null)} /> : null}
      <ProviderRegistrySection providers={providers} />
      <section className="provider-credentials">
        <div className="provider-credentials-head">
          <div className="provider-credentials-title">
            <KeyRound />
            <strong>Credentials</strong>
            <span className="faint">{credentialCount}</span>
          </div>
          <div className="provider-credentials-actions">
            <div className="input provider-key-search">
              <Search />
              <input
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Search credentials, owners..."
                aria-label="Search provider credentials"
              />
              {searchValue ? (
                <button type="button" aria-label="Clear search" onClick={() => setSearchValue("")}>
                  <X />
                </button>
              ) : null}
            </div>
            <button className="btn btn-sm btn-primary" type="button" onClick={() => setShowCreate(true)}>
              <Plus />
              Add credential
            </button>
          </div>
        </div>
      </section>
      <ProviderGroupsList
        accounts={accounts}
        providers={providers}
        searchValue={searchValue}
        users={users}
        boundKeys={boundKeys}
        revokePendingId={revokeMutation.isPending ? revokeMutation.variables : undefined}
        revokeErrorId={revokeMutation.error ? revokeMutation.variables : undefined}
        revokeErrorMessage={revokeMutation.error?.message}
        onRevoke={(providerAccountId) => revokeMutation.mutate(providerAccountId)}
        onOpen={(providerAccountId) => setOpenAccountId(providerAccountId)}
      />
    </div>
  );
}
