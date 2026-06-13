import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus, Search, X } from "lucide-react";
import { useState } from "react";

import {
  fetchProviderAccounts,
  revokeProviderCredential
} from "./providers/data";
import { ProviderKeyDetailPanel } from "./providers/detailPanel";
import { ProviderGroupsList } from "./providers/groupedList";
import { boundKeysByAccount } from "./providers/groupedListData";
import { CreateProviderKeyModal } from "./createProviderKeyModal";
import { fetchApiKeys } from "./routing/data";
import { PageState } from "./ui";
import { fetchUserDirectory, type UserDirectory } from "./userDirectory";

export function ProvidersPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  // The open slideout lives in the URL (?key=<id>) so provider keys can be deep-linked.
  const search = useSearch({ strict: false }) as { key?: unknown };
  const openAccountId = typeof search.key === "string" ? search.key : null;
  const navigate = useNavigate();
  const setOpenAccountId = (accountId: string | null) =>
    void navigate({ to: ".", search: (current) => ({ ...current, key: accountId ?? undefined }), replace: true });
  const queryClient = useQueryClient();
  const { isLoading: accountsQueryIsLoading, error: accountsQueryError, data: accountsQueryData } = useQuery({ queryKey: ["provider-accounts"], queryFn: fetchProviderAccounts });
  const { isLoading: usersQueryIsLoading, error: usersQueryError, data: usersQueryData } = useQuery({ queryKey: ["user-directory"], queryFn: fetchUserDirectory });
  const { data: keysQueryData } = useQuery({ queryKey: ["api-keys"], queryFn: fetchApiKeys });
  const revokeMutation = useMutation({
    mutationFn: (providerAccountId: string) => revokeProviderCredential(providerAccountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    }
  });

  if (accountsQueryIsLoading || usersQueryIsLoading) return <PageState title="Provider keys" label="Loading provider keys" />;
  const error = accountsQueryError ?? usersQueryError;
  if (error) return <PageState title="Provider keys" label={error.message} />;

  const accounts = accountsQueryData ?? [];
  const users: UserDirectory = usersQueryData ?? new Map();
  const boundKeys = keysQueryData ? boundKeysByAccount(keysQueryData) : null;
  const openAccount = accounts.find((account) => account.id === openAccountId);
  return (
    <div className="page page-enter provider-keys-page">
      <div className="provider-keys-title-row">
        <div>
          <h2>Provider keys</h2>
          <div className="muted">Bring-your-own provider credentials. Unbound traffic uses the company key.</div>
        </div>
        <div className="provider-keys-actions">
          <div className="input provider-key-search">
            <Search />
            <input
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder="Search keys, owners..."
              aria-label="Search provider keys"
            />
            {searchValue ? (
              <button type="button" aria-label="Clear search" onClick={() => setSearchValue("")}>
                <X />
              </button>
            ) : null}
          </div>
          <button className="btn btn-primary" type="button" onClick={() => setShowCreate(true)}>
            <Plus />
            Add provider key
          </button>
        </div>
      </div>
      {showCreate ? <CreateProviderKeyModal onClose={() => setShowCreate(false)} /> : null}
      {openAccount ? <ProviderKeyDetailPanel account={openAccount} onClose={() => setOpenAccountId(null)} /> : null}
      <ProviderGroupsList
        accounts={accounts}
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
