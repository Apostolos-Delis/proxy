import type { ColumnDef, SortingState, VisibilityState } from "@tanstack/react-table";
import type { KeyboardEvent, ReactNode } from "react";

export type ConsoleTableColumn<TData> = ColumnDef<TData, unknown>;

export type ConsoleTableFilterOption = {
  value: string;
  label: string;
};

export type ConsoleTableFilter<TData> = {
  id: string;
  label: string;
  allLabel: string;
  icon?: ReactNode;
  options: ConsoleTableFilterOption[];
  getValue: (row: TData) => string | string[] | null | undefined;
};

export type ConsoleTableAdvancedField<TData> = {
  id: string;
  label: string;
  getValue: (row: TData) => string | string[] | number | null | undefined;
};

export type ConsoleTableAdvancedOperator =
  | "contains"
  | "equals"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty";

export type ConsoleTableAdvancedRule = {
  id: string;
  fieldId: string;
  operator: ConsoleTableAdvancedOperator;
  value: string;
  join: "and" | "or";
};

export type ConsoleTableSearch<TData> = {
  placeholder: string;
  getValue: (row: TData) => string | string[] | null | undefined;
};

export type ConsoleTableView = {
  id: string;
  label: string;
  search?: string;
  filters?: Record<string, string>;
  advancedRules?: ConsoleTableAdvancedRule[];
  columnVisibility?: VisibilityState;
  sorting?: SortingState;
};

export type ConsoleTableActionContext<TData> = {
  visibleData: TData[];
  totalCount: number;
  filteredCount: number;
};

export type ConsoleTableRowProps = {
  className?: string;
  role?: string;
  tabIndex?: number;
  onClick?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTableRowElement>) => void;
};

export type ConsoleTableColumnOption = {
  id: string;
  label: string;
  visible: boolean;
  canHide: boolean;
  canSort: boolean;
};
