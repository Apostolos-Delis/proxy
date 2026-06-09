import { Check, ListFilter, Search } from "lucide-react";
import { useState } from "react";

import type { ConsoleTableFilter } from "./types";

type QuickFilterPopoverProps<TData> = {
  filters: ConsoleTableFilter<TData>[];
  filterValues: Record<string, string>;
  onFilterChange: (filterId: string, value: string) => void;
  onAdvancedFilter: () => void;
};

export function QuickFilterPopover<TData>({ filters, filterValues, onFilterChange, onAdvancedFilter }: QuickFilterPopoverProps<TData>) {
  const [activeFilterId, setActiveFilterId] = useState(filters[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const activeFilter = filters.find((filter) => filter.id === activeFilterId) ?? filters[0];
  const options = activeFilter?.options.filter((option) => option.label.toLowerCase().includes(query.toLowerCase())) ?? [];

  if (!activeFilter) return null;

  return (
    <div className="quick-filter-popover">
      <div className="quick-filter-left">
        <div className="input quick-filter-search">
          <Search />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Add filter..." />
          <kbd>F</kbd>
        </div>
        <div className="quick-filter-fields">
          {filters.map((filter) => (
            <button key={filter.id} type="button" className={activeFilter.id === filter.id ? "active" : ""} onClick={() => setActiveFilterId(filter.id)}>
              <ListFilter />
              <span>{filter.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="quick-filter-advanced" onClick={onAdvancedFilter}>
          <ListFilter />Advanced filter
        </button>
      </div>
      <div className="quick-filter-right">
        <div className="input quick-filter-search">
          <Search />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${activeFilter.label.toLowerCase()}`} />
        </div>
        <button type="button" className={!filterValues[activeFilter.id] ? "active" : ""} onClick={() => onFilterChange(activeFilter.id, "")}>
          <span>{activeFilter.allLabel}</span>
          {!filterValues[activeFilter.id] ? <Check /> : null}
        </button>
        {options.map((option) => (
          <button key={option.value} type="button" className={filterValues[activeFilter.id] === option.value ? "active" : ""} onClick={() => onFilterChange(activeFilter.id, option.value)}>
            <span>{option.label}</span>
            {filterValues[activeFilter.id] === option.value ? <Check /> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
