import { ArrowUpDown, PlusCircle, Search, SlidersHorizontal, X } from "lucide-react";
import type { SortingState } from "@tanstack/react-table";
import { useState, type ReactNode } from "react";

import { ActiveFilterChips } from "./ActiveFilterChips";
import { AdvancedFilterPanel } from "./AdvancedFilterPanel";
import { DisplayOptionsPopover } from "./DisplayOptionsPopover";
import type {
  ConsoleTableActionContext,
  ConsoleTableAdvancedField,
  ConsoleTableAdvancedRule,
  ConsoleTableColumnOption,
  ConsoleTableFilter,
  ConsoleTableView
} from "./types";

type ConsoleTableToolbarProps<TData> = {
  searchValue: string;
  searchPlaceholder?: string;
  filters: ConsoleTableFilter<TData>[];
  filterValues: Record<string, string>;
  advancedFields: ConsoleTableAdvancedField<TData>[];
  advancedRules: ConsoleTableAdvancedRule[];
  views: ConsoleTableView[];
  activeViewId: string | null;
  columnOptions: ConsoleTableColumnOption[];
  sorting: SortingState;
  actionContext: ConsoleTableActionContext<TData>;
  actions?: (context: ConsoleTableActionContext<TData>) => ReactNode;
  onSearchChange: (value: string) => void;
  onFilterChange: (filterId: string, value: string) => void;
  onAdvancedRulesChange: (rules: ConsoleTableAdvancedRule[]) => void;
  onApplyView: (view: ConsoleTableView) => void;
  onToggleColumn: (columnId: string) => void;
  onSortingChange: (sorting: SortingState) => void;
  onClear: () => void;
};

export function ConsoleTableToolbar<TData>({
  searchValue,
  searchPlaceholder,
  filters,
  filterValues,
  advancedFields,
  advancedRules,
  views,
  activeViewId,
  columnOptions,
  sorting,
  actionContext,
  actions,
  onSearchChange,
  onFilterChange,
  onAdvancedRulesChange,
  onApplyView,
  onToggleColumn,
  onSortingChange,
  onClear
}: ConsoleTableToolbarProps<TData>) {
  const [openFilterId, setOpenFilterId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [displayMode, setDisplayMode] = useState<"sort" | "view" | null>(null);
  const activeAdvancedCount = advancedRules.filter((rule) => rule.operator === "isEmpty" || rule.operator === "isNotEmpty" || rule.value.trim()).length;
  const hasControls = Boolean(searchValue) || Object.values(filterValues).some(Boolean) || activeAdvancedCount > 0 || sorting.length > 0;

  return (
    <div className="console-table-toolbar">
      <div className={`console-table-topline${views.length === 0 ? " no-views" : ""}`}>
        {views.length > 0 ? (
          <div className="console-table-views" aria-label="Table views">
            {views.map((view) => (
              <button key={view.id} type="button" className={activeViewId === view.id ? "active" : ""} onClick={() => onApplyView(view)}>
                {view.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="console-table-controls">
          {searchPlaceholder ? (
            <div className="input console-table-search">
              <Search />
              <input value={searchValue} onChange={(event) => onSearchChange(event.target.value)} placeholder={searchPlaceholder} />
              {searchValue ? (
                <button type="button" aria-label="Clear search" onClick={() => onSearchChange("")}>
                  <X />
                </button>
              ) : null}
            </div>
          ) : null}
          {filters.map((filter) => (
            <FilterButton
              key={filter.id}
              filter={filter}
              value={filterValues[filter.id] ?? ""}
              open={openFilterId === filter.id}
              onOpenChange={(open) => setOpenFilterId(open ? filter.id : null)}
              onChange={(value) => {
                onFilterChange(filter.id, value);
                setOpenFilterId(null);
              }}
            />
          ))}
          {advancedFields.length > 0 ? (
            <button type="button" className={`btn table-filter-button${advancedOpen ? " active" : ""}`} onClick={() => setAdvancedOpen(!advancedOpen)}>
              <PlusCircle />Advanced filter
              {activeAdvancedCount > 0 ? <span className="table-dot" /> : null}
            </button>
          ) : null}
          <div className="console-table-spacer" />
          <div className="table-popover-anchor">
            <button type="button" className={`btn table-mode-button${displayMode === "sort" ? " active" : ""}`} onClick={() => setDisplayMode(displayMode === "sort" ? null : "sort")}>
              <ArrowUpDown />Sort
              {sorting.length > 0 ? <span className="mode-count">{sorting.length}</span> : null}
            </button>
            {displayMode === "sort" ? (
              <DisplayOptionsPopover
                columns={columnOptions}
                mode="sort"
                sorting={sorting}
                onSortingChange={onSortingChange}
                onToggleColumn={onToggleColumn}
              />
            ) : null}
          </div>
          <div className="table-popover-anchor">
            <button type="button" className={`btn table-mode-button${displayMode === "view" ? " active" : ""}`} onClick={() => setDisplayMode(displayMode === "view" ? null : "view")}>
              <SlidersHorizontal />View
            </button>
            {displayMode === "view" ? (
              <DisplayOptionsPopover
                columns={columnOptions}
                mode="view"
                sorting={sorting}
                onSortingChange={onSortingChange}
                onToggleColumn={onToggleColumn}
              />
            ) : null}
          </div>
          {hasControls ? (
            <button className="btn btn-icon table-icon-button" type="button" aria-label="Clear table controls" onClick={onClear}>
              <X />
            </button>
          ) : null}
          {actions ? <div className="console-table-actions">{actions(actionContext)}</div> : null}
        </div>
      </div>
      <ActiveFilterChips
        searchValue={searchValue}
        filters={filters}
        filterValues={filterValues}
        advancedFields={advancedFields}
        advancedRules={advancedRules}
        onSearchChange={onSearchChange}
        onFilterChange={onFilterChange}
        onAdvancedRulesChange={onAdvancedRulesChange}
      />
      {advancedOpen && advancedFields.length > 0 ? (
        <AdvancedFilterPanel fields={advancedFields} rules={advancedRules} onRulesChange={onAdvancedRulesChange} onClose={() => setAdvancedOpen(false)} />
      ) : null}
    </div>
  );
}

function FilterButton<TData>({ filter, value, open, onOpenChange, onChange }: {
  filter: ConsoleTableFilter<TData>;
  value: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
}) {
  const selectedLabel = value ? filter.options.find((option) => option.value === value)?.label ?? value : filter.label;
  return (
    <div className="table-popover-anchor">
      <button type="button" className={`btn table-filter-button${value ? " active" : ""}`} onClick={() => onOpenChange(!open)}>
        <PlusCircle />
        {selectedLabel}
      </button>
      {open ? (
        <div className="filter-popover table-filter-popover">
          <button type="button" className={!value ? "active" : ""} onClick={() => onChange("")}>
            {filter.allLabel}
          </button>
          {filter.options.map((option) => (
            <button key={option.value} type="button" className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
