import {
  functionalUpdate,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnSizingState
} from "@tanstack/react-table";
import { useState, type ReactNode } from "react";

import { GlassCard } from "../ui";
import { ConsoleTableFrame } from "./ConsoleTableFrame";
import { ConsoleTablePagination } from "./ConsoleTablePagination";
import { ConsoleTableToolbar } from "./ConsoleTableToolbar";
import { applyConsoleTableFilters, resolveFilterValues, storedFilterValue } from "./filtering";
import { useConsoleTableState } from "./useConsoleTableState";
import type {
  ConsoleTableActionContext,
  ConsoleTableAdvancedField,
  ConsoleTableAdvancedRule,
  ConsoleTableColumn,
  ConsoleTableFilter,
  ConsoleTableRowProps,
  ConsoleTableSearch,
  ConsoleTableView
} from "./types";

type ConsoleTableProps<TData> = {
  data: TData[];
  columns: ConsoleTableColumn<TData>[];
  search?: ConsoleTableSearch<TData>;
  filters?: ConsoleTableFilter<TData>[];
  advancedFields?: ConsoleTableAdvancedField<TData>[];
  views?: ConsoleTableView[];
  emptyLabel?: string;
  className?: string;
  initialPageSize?: number;
  pageSizeOptions?: number[];
  /** Resets search/filters/sort/page in place when it changes. Prefer this over a `key` remount, which collapses the page's scroll position. */
  stateKey?: string;
  /** Syncs search/filters/sort/pagination to URL query params so table state is shareable. Pass a string to prefix the params when a page hosts more than one synced table. */
  urlState?: boolean | string;
  actions?: (context: ConsoleTableActionContext<TData>) => ReactNode;
  getRowProps?: (row: TData) => ConsoleTableRowProps;
  renderExpandedRow?: (row: TData) => ReactNode;
};

export function ConsoleTable<TData>({
  data,
  columns,
  search,
  filters = [],
  advancedFields = [],
  views = [],
  emptyLabel = "No rows found.",
  className = "",
  initialPageSize = 10,
  pageSizeOptions = [10, 25, 50],
  stateKey,
  urlState,
  actions,
  getRowProps,
  renderExpandedRow
}: ConsoleTableProps<TData>) {
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const state = useConsoleTableState({
    urlState,
    stateKey,
    views,
    filterIds: filters.map((filter) => filter.id),
    advancedFieldIds: advancedFields.map((field) => field.id),
    columnIds: columns.map((column) => column.id).filter((id): id is string => Boolean(id)),
    initialPageSize,
    pageSizeOptions
  });
  const { searchValue, advancedRules, sorting, columnVisibility } = state;
  const filterValues = resolveFilterValues(filters, state.filterValues);
  const setFilterValue = (filterId: string, value: string) =>
    state.setFilterValue(filterId, storedFilterValue(filters.find((filter) => filter.id === filterId), value));
  const visibleData = applyConsoleTableFilters({ data, search, searchValue, filters, filterValues, advancedFields, advancedRules });
  // A stale URL or a shrunken data set can point past the last page; render the last real page instead.
  const maxPageIndex = Math.max(0, Math.ceil(visibleData.length / state.pagination.pageSize) - 1);
  const pagination = state.pagination.pageIndex > maxPageIndex ? { ...state.pagination, pageIndex: maxPageIndex } : state.pagination;
  const normalizedPageSizeOptions = Array.from(new Set([...pageSizeOptions, initialPageSize])).sort((a, b) => a - b);
  const hasFilterControls = Boolean(searchValue) || Object.values(filterValues).some(Boolean) || activeAdvancedRuleCount(advancedRules) > 0;
  const table = useReactTable({
    data: visibleData,
    columns,
    // Callers pass freshly built data/columns arrays on every render. TanStack's auto-reset
    // queues a pagination state update whenever data identity changes, which re-renders the
    // caller, which builds a new array again — an unbounded microtask loop that freezes the
    // page. Page index is reset explicitly in the search/filter/view handlers instead.
    autoResetAll: false,
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 96, size: 180, maxSize: 680 },
    state: { sorting, columnVisibility, columnSizing, pagination },
    onSortingChange: state.updateSorting,
    onColumnVisibilityChange: state.updateColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    // Apply pagination updaters against the clamped value so a stale page index from the URL
    // converges instead of feeding TanStack's page-size math an out-of-range base.
    onPaginationChange: (updater) => state.updatePagination(() => functionalUpdate(updater, pagination)),
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel()
  });
  const tableWidth = Math.max(table.getCenterTotalSize(), 760);
  const sortedVisibleData = table.getPrePaginationRowModel().rows.map((row) => row.original);
  const actionContext = { visibleData: sortedVisibleData, totalCount: data.length, filteredCount: visibleData.length };
  const columnOptions = table.getAllLeafColumns().map((column) => ({
    id: column.id,
    label: String(column.columnDef.header ?? column.id),
    visible: column.getIsVisible(),
    canHide: column.getCanHide(),
    canSort: column.getCanSort()
  }));

  return (
    <GlassCard className={`console-table-card ${className}`}>
      <ConsoleTableToolbar
        searchValue={searchValue}
        searchPlaceholder={search?.placeholder}
        filters={filters}
        filterValues={filterValues}
        advancedFields={advancedFields}
        advancedRules={advancedRules}
        views={views}
        activeViewId={state.activeViewId}
        columnOptions={columnOptions}
        sorting={sorting}
        actionContext={actionContext}
        actions={actions}
        onSearchChange={state.setSearchValue}
        onFilterChange={setFilterValue}
        onAdvancedRulesChange={state.setAdvancedRules}
        onApplyView={state.applyView}
        onToggleColumn={(columnId) => table.getColumn(columnId)?.toggleVisibility()}
        onSortingChange={(nextSorting) => state.updateSorting(nextSorting)}
        onClear={state.clear}
      />
      <ConsoleTableFrame
        table={table}
        tableWidth={tableWidth}
        emptyLabel={emptyLabel}
        filtered={hasFilterControls}
        getRowProps={getRowProps}
        renderExpandedRow={renderExpandedRow}
        onClear={state.clear}
      />
      <ConsoleTablePagination
        pageIndex={pagination.pageIndex}
        pageSize={pagination.pageSize}
        pageCount={table.getPageCount()}
        filteredCount={visibleData.length}
        totalCount={data.length}
        pageSizeOptions={normalizedPageSizeOptions}
        canPreviousPage={table.getCanPreviousPage()}
        canNextPage={table.getCanNextPage()}
        onPageChange={(pageIndex) => table.setPageIndex(pageIndex)}
        onPageSizeChange={(pageSize) => table.setPageSize(pageSize)}
      />
    </GlassCard>
  );
}

function activeAdvancedRuleCount(rules: ConsoleTableAdvancedRule[]) {
  return rules.filter((rule) => rule.operator === "isEmpty" || rule.operator === "isNotEmpty" || rule.value.trim()).length;
}
