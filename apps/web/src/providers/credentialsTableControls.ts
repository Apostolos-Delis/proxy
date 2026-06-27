import {
  optionItems,
  uniqueOptionItems,
  type ConsoleTableFilter
} from "../table";
import {
  BEDROCK_HEALTH_CATEGORY_OPTIONS,
  providerBedrockHealthCategories
} from "./healthData";
import {
  providerCredentialStatus,
  providerCredentialType,
  type ProviderCredentialRow
} from "./credentialsTableData";

export function providerCredentialFilters(rows: ProviderCredentialRow[]): ConsoleTableFilter<ProviderCredentialRow>[] {
  return [
    {
      id: "provider",
      label: "Provider",
      allLabel: "All providers",
      options: uniqueOptionItems(rows.map((row) => ({ value: row.provider, label: row.providerLabel }))),
      getValue: (row) => row.provider
    },
    {
      id: "type",
      label: "Type",
      allLabel: "All types",
      options: [
        { value: "default", label: "Default" },
        { value: "credential", label: "Credential" }
      ],
      getValue: providerCredentialType
    },
    {
      id: "status",
      label: "Status",
      allLabel: "All statuses",
      options: optionItems(rows.map(providerCredentialStatus)),
      getValue: providerCredentialStatus
    },
    {
      id: "bedrockHealth",
      label: "Bedrock health",
      allLabel: "All Bedrock health",
      options: BEDROCK_HEALTH_CATEGORY_OPTIONS,
      getValue: (row) => row.kind === "account" ? providerBedrockHealthCategories(row.account) : []
    }
  ];
}

export function providerCredentialRowClass(row: ProviderCredentialRow) {
  const classes = ["provider-credential-table-row"];
  if (row.kind === "default") classes.push("provider-default-table-row");
  if (row.kind === "account" && row.account.status !== "active") classes.push("inactive");
  return classes.join(" ");
}
