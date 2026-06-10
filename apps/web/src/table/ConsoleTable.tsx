import {
  functionalUpdate,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnSizingState,
  type PaginationState,
  type SortingState,
  type Updater,
  type VisibilityState
} from "@tanstack/react-table";
import { useState, type ReactNode } from "react";

import { GlassCard } from "../ui";
import { ConsoleTableFrame } from "./ConsoleTableFrame";
import { ConsoleTablePagination } from "./ConsoleTablePagination";
import { ConsoleTableToolbar } from "./ConsoleTableToolbar";
import { applyConsoleTableFilters } from "./filtering";
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
  actions?: (context: ConsoleTableActionContext<TData>) => ReactNode;
  getRowProps?: (row: TData) => ConsoleTableRowProps;
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
  actions,
  getRowProps
}: ConsoleTableProps<TData>) {
  const [searchValue, setSearchValue] = useState("");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [advancedRules, setAdvancedRules] = useState<ConsoleTableAdvancedRule[]>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: initialPageSize });
  const [activeViewId, setActiveViewId] = useState<string | null>(views[0]?.id ?? null);
  const visibleData = applyConsoleTableFilters({ data, search, searchValue, filters, filterValues, advancedFields, advancedRules });
  const normalizedPageSizeOptions = Array.from(new Set([...pageSizeOptions, initialPageSize])).sort((a, b) => a - b);
  const hasFilterControls = Boolean(searchValue) || Object.values(filterValues).some(Boolean) || activeAdvancedRuleCount(advancedRules) > 0;
  const updateSorting = (updater: Updater<SortingState>) => {
    setActiveViewId(null);
    setSorting((current) => functionalUpdate(updater, current));
  };
  const updateColumnVisibility = (updater: Updater<VisibilityState>) => {
    setActiveViewId(null);
    setColumnVisibility((current) => functionalUpdate(updater, current));
  };
  const table = useReactTable({
    data: visibleData,
    columns,
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 96, size: 180, maxSize: 680 },
    state: { sorting, columnVisibility, columnSizing, pagination },
    onSortingChange: updateSorting,
    onColumnVisibilityChange: updateColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onPaginationChange: setPagination,
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

  const setFilterValue = (filterId: string, value: string) => {
    setActiveViewId(null);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
    setFilterValues((current) => ({ ...current, [filterId]: value }));
  };
  const setSearch = (value: string) => {
    setActiveViewId(null);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
    setSearchValue(value);
  };
  const setAdvanced = (rules: ConsoleTableAdvancedRule[]) => {
    setActiveViewId(null);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
    setAdvancedRules(rules);
  };
  const applyView = (view: ConsoleTableView) => {
    setActiveViewId(view.id);
    setSearchValue(view.search ?? "");
    setFilterValues(view.filters ?? {});
    setAdvancedRules(view.advancedRules ?? []);
    setColumnVisibility(view.columnVisibility ?? {});
    setSorting(view.sorting ?? []);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };
  const clear = () => {
    setActiveViewId(views[0]?.id ?? null);
    setSearchValue("");
    setFilterValues({});
    setAdvancedRules([]);
    setColumnVisibility({});
    setSorting([]);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

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
        activeViewId={activeViewId}
        columnOptions={columnOptions}
        sorting={sorting}
        actionContext={actionContext}
        actions={actions}
        onSearchChange={setSearch}
        onFilterChange={setFilterValue}
        onAdvancedRulesChange={setAdvanced}
        onApplyView={applyView}
        onToggleColumn={(columnId) => table.getColumn(columnId)?.toggleVisibility()}
        onSortingChange={(nextSorting) => updateSorting(nextSorting)}
        onClear={clear}
      />
      <ConsoleTableFrame table={table} tableWidth={tableWidth} emptyLabel={emptyLabel} filtered={hasFilterControls} getRowProps={getRowProps} onClear={clear} />
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
