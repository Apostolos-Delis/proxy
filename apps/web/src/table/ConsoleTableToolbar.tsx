import { ListFilter, Search, SlidersHorizontal, X } from "lucide-react";
import type { SortingState } from "@tanstack/react-table";
import { useState, type ReactNode } from "react";

import { ActiveFilterChips } from "./ActiveFilterChips";
import { AdvancedFilterPanel } from "./AdvancedFilterPanel";
import { DisplayOptionsPopover } from "./DisplayOptionsPopover";
import { QuickFilterPopover } from "./QuickFilterPopover";
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
  resultLabel: string;
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
  resultLabel,
  actions,
  onSearchChange,
  onFilterChange,
  onAdvancedRulesChange,
  onApplyView,
  onToggleColumn,
  onSortingChange,
  onClear
}: ConsoleTableToolbarProps<TData>) {
  const [quickFiltersOpen, setQuickFiltersOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const activeQuickFilterCount = Object.values(filterValues).filter(Boolean).length;
  const activeAdvancedCount = advancedRules.filter((rule) => rule.operator === "isEmpty" || rule.operator === "isNotEmpty" || rule.value.trim()).length;
  const hasControls = Boolean(searchValue) || activeQuickFilterCount > 0 || activeAdvancedCount > 0 || sorting.length > 0;
  const topLineClassName = views.length > 0 ? "console-table-topline" : "console-table-topline no-views";
  return (
    <div className="console-table-toolbar">
      <div className={topLineClassName}>
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
          {advancedFields.length > 0 ? (
            <button type="button" className={`btn advanced-filter-trigger${advancedOpen ? " active" : ""}`} onClick={() => setAdvancedOpen(!advancedOpen)}>
              Advanced filter
              {activeAdvancedCount > 0 ? <span className="table-dot" /> : null}
            </button>
          ) : null}
          {filters.length > 0 ? (
            <div className="table-popover-anchor">
              <button type="button" className={`btn btn-icon table-icon-button${quickFiltersOpen ? " active" : ""}`} aria-label="Open quick filters" onClick={() => setQuickFiltersOpen(!quickFiltersOpen)}>
                <ListFilter />
                {activeQuickFilterCount > 0 ? <span className="table-dot" /> : null}
              </button>
              {quickFiltersOpen ? (
                <QuickFilterPopover
                  filters={filters}
                  filterValues={filterValues}
                  onFilterChange={onFilterChange}
                  onAdvancedFilter={() => {
                    setQuickFiltersOpen(false);
                    setAdvancedOpen(true);
                  }}
                />
              ) : null}
            </div>
          ) : null}
          <div className="table-popover-anchor">
            <button type="button" className={`btn btn-icon table-icon-button${displayOpen ? " active" : ""}`} aria-label="Open display options" onClick={() => setDisplayOpen(!displayOpen)}>
              <SlidersHorizontal />
            </button>
            {displayOpen ? (
              <DisplayOptionsPopover
                columns={columnOptions}
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
          <span className="badge table-count-badge">{resultLabel}</span>
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
