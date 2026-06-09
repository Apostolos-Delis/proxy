import { X } from "lucide-react";

import type { ConsoleTableAdvancedField, ConsoleTableAdvancedRule, ConsoleTableFilter } from "./types";

type ActiveFilterChipsProps<TData> = {
  searchValue: string;
  filters: ConsoleTableFilter<TData>[];
  filterValues: Record<string, string>;
  advancedFields: ConsoleTableAdvancedField<TData>[];
  advancedRules: ConsoleTableAdvancedRule[];
  onSearchChange: (value: string) => void;
  onFilterChange: (filterId: string, value: string) => void;
  onAdvancedRulesChange: (rules: ConsoleTableAdvancedRule[]) => void;
};

export function ActiveFilterChips<TData>({
  searchValue,
  filters,
  filterValues,
  advancedFields,
  advancedRules,
  onSearchChange,
  onFilterChange,
  onAdvancedRulesChange
}: ActiveFilterChipsProps<TData>) {
  const activeFilters = filters.filter((filter) => filterValues[filter.id]);
  const activeRules = advancedRules.filter((rule) => rule.operator === "isEmpty" || rule.operator === "isNotEmpty" || rule.value.trim());
  if (!searchValue && activeFilters.length === 0 && activeRules.length === 0) return null;

  return (
    <div className="active-filter-chips">
      {searchValue ? <Chip label={`Search contains ${searchValue}`} onClear={() => onSearchChange("")} /> : null}
      {activeFilters.map((filter) => (
        <Chip key={filter.id} label={`${filter.label}: ${filter.options.find((option) => option.value === filterValues[filter.id])?.label ?? filterValues[filter.id]}`} onClear={() => onFilterChange(filter.id, "")} />
      ))}
      {activeRules.map((rule) => (
        <Chip key={rule.id} label={advancedRuleLabel(rule, advancedFields)} onClear={() => onAdvancedRulesChange(advancedRules.filter((item) => item.id !== rule.id))} />
      ))}
    </div>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button type="button" className="active-filter-chip" onClick={onClear}>
      <span>{label}</span>
      <X />
    </button>
  );
}

function advancedRuleLabel<TData>(rule: ConsoleTableAdvancedRule, fields: ConsoleTableAdvancedField<TData>[]) {
  const field = fields.find((item) => item.id === rule.fieldId)?.label ?? rule.fieldId;
  const value = rule.operator === "isEmpty" || rule.operator === "isNotEmpty" ? "" : ` ${rule.value}`;
  return `${field} ${rule.operator}${value}`;
}
