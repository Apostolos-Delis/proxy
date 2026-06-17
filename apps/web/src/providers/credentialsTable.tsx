import { KeyRound, Plus } from "lucide-react";

import type { ApiKeySummary } from "../routing/data";
import { ConsoleTable } from "../table";
import type { UserDirectory } from "../userDirectory";
import {
  providerCredentialFilters,
  providerCredentialRowClass
} from "./credentialsTableControls";
import { providerCredentialColumns } from "./credentialsTableColumns";
import type { ProviderAccountSummary, ProviderRegistrySummary } from "./data";
import {
  providerCredentialRows,
  providerCredentialSearchValue
} from "./credentialsTableData";

type ProviderCredentialsTableProps = {
  accounts: ProviderAccountSummary[];
  providers: ProviderRegistrySummary[];
  users: UserDirectory;
  boundKeys: Map<string, ApiKeySummary[]> | null;
  revokePendingId?: string;
  revokeErrorId?: string;
  revokeErrorMessage?: string;
  onCreate: () => void;
  onRevoke: (providerAccountId: string) => void;
  onOpen: (providerAccountId: string) => void;
};

export function ProviderCredentialsTable({
  accounts,
  providers,
  users,
  boundKeys,
  revokePendingId,
  revokeErrorId,
  revokeErrorMessage,
  onCreate,
  onRevoke,
  onOpen
}: ProviderCredentialsTableProps) {
  const rows = providerCredentialRows(accounts, providers);
  return (
    <section className="provider-credentials">
      <div className="provider-credentials-head">
        <div className="provider-credentials-title">
          <KeyRound />
          <strong>Credentials</strong>
          <span className="faint">{credentialCountLabel(accounts.length)}</span>
        </div>
      </div>
      <ConsoleTable
        className="provider-credentials-table"
        urlState="credentials"
        data={rows}
        columns={providerCredentialColumns({
          users,
          boundKeys,
          revokePendingId,
          revokeErrorId,
          revokeErrorMessage,
          onRevoke,
          onOpen
        })}
        search={{
          placeholder: "Search credentials, providers, owners...",
          getValue: (row) => providerCredentialSearchValue(row, users, boundKeys)
        }}
        filters={providerCredentialFilters(rows)}
        initialPageSize={25}
        pageSizeOptions={[10, 25, 50]}
        emptyLabel="No provider credentials match these table controls."
        actions={() => (
          <button className="btn btn-sm btn-primary" type="button" onClick={onCreate}>
            <Plus />
            Add credential
          </button>
        )}
        getRowProps={(row) => ({ className: providerCredentialRowClass(row) })}
      />
    </section>
  );
}

function credentialCountLabel(count: number) {
  if (count === 0) return "no credentials";
  if (count === 1) return "1 saved";
  return `${count} saved`;
}
