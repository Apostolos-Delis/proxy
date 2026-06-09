import {
  flexRender,
  functionalUpdate,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnSizingState,
  type SortingState,
  type Updater,
  type VisibilityState
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import { GlassCard } from "../ui";
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
  resultLabel?: (filteredCount: number, totalCount: number) => string;
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
  resultLabel = defaultResultLabel,
  actions,
  getRowProps
}: ConsoleTableProps<TData>) {
  const [searchValue, setSearchValue] = useState("");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [advancedRules, setAdvancedRules] = useState<ConsoleTableAdvancedRule[]>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(views[0]?.id ?? null);
  const visibleData = applyConsoleTableFilters({ data, search, searchValue, filters, filterValues, advancedFields, advancedRules });
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
    state: { sorting, columnVisibility, columnSizing },
    onSortingChange: updateSorting,
    onColumnVisibilityChange: updateColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });
  const tableWidth = Math.max(table.getCenterTotalSize(), 760);
  const sortedVisibleData = table.getRowModel().rows.map((row) => row.original);
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
    setFilterValues((current) => ({ ...current, [filterId]: value }));
  };
  const setSearch = (value: string) => {
    setActiveViewId(null);
    setSearchValue(value);
  };
  const setAdvanced = (rules: ConsoleTableAdvancedRule[]) => {
    setActiveViewId(null);
    setAdvancedRules(rules);
  };
  const applyView = (view: ConsoleTableView) => {
    setActiveViewId(view.id);
    setSearchValue(view.search ?? "");
    setFilterValues(view.filters ?? {});
    setAdvancedRules(view.advancedRules ?? []);
    setColumnVisibility(view.columnVisibility ?? {});
    setSorting(view.sorting ?? []);
  };
  const clear = () => {
    setActiveViewId(views[0]?.id ?? null);
    setSearchValue("");
    setFilterValues({});
    setAdvancedRules([]);
    setColumnVisibility({});
    setSorting([]);
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
        resultLabel={resultLabel(visibleData.length, data.length)}
        actions={actions}
        onSearchChange={setSearch}
        onFilterChange={setFilterValue}
        onAdvancedRulesChange={setAdvanced}
        onApplyView={applyView}
        onToggleColumn={(columnId) => table.getColumn(columnId)?.toggleVisibility()}
        onSortingChange={(nextSorting) => updateSorting(nextSorting)}
        onClear={clear}
      />
      <div className="console-table-scroll">
        <table className="tbl console-table" style={{ width: tableWidth }}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} style={{ width: header.getSize() }}>
                    <div className="console-table-th">
                      {header.isPlaceholder ? null : (
                        <button type="button" disabled={!header.column.getCanSort()} onClick={header.column.getToggleSortingHandler()}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon sorted={header.column.getIsSorted()} />
                        </button>
                      )}
                      {header.column.getCanResize() ? (
                        <span
                          role="separator"
                          aria-label={`Resize ${header.column.id} column`}
                          className={`console-column-resizer${header.column.getIsResizing() ? " resizing" : ""}`}
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                        />
                      ) : null}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const rowProps = getRowProps?.(row.original);
              return (
                <tr key={row.id} {...rowProps} className={rowProps?.className}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} style={{ width: cell.column.getSize() }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {visibleData.length === 0 ? <div className="empty">{emptyLabel}</div> : null}
    </GlassCard>
  );
}

function SortIcon({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <ArrowUp />;
  if (sorted === "desc") return <ArrowDown />;
  return <ArrowUpDown />;
}

function defaultResultLabel(filteredCount: number, totalCount: number) {
  if (filteredCount === totalCount) return `${totalCount} rows`;
  return `${filteredCount} of ${totalCount} rows`;
}
