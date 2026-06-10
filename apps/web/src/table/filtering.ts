import type { ConsoleTableAdvancedField, ConsoleTableAdvancedRule, ConsoleTableFilter, ConsoleTableFilterOption, ConsoleTableSearch } from "./types";

export const FILTER_ALL_VALUE = "all";

/** Maps stored filter state to the values actually applied: absent entries fall back to the filter's defaultValue, and the "all" sentinel clears it. */
export function resolveFilterValues<TData>(
  filters: ConsoleTableFilter<TData>[],
  stored: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    filters
      .map((filter) => {
        const value = stored[filter.id] ?? "";
        if (filter.defaultValue === undefined) return [filter.id, value] as const;
        if (value === FILTER_ALL_VALUE) return [filter.id, ""] as const;
        return [filter.id, value || filter.defaultValue] as const;
      })
      .filter(([, value]) => value)
  );
}

/** Maps a user selection to the value to store: clearing a filter that has a default must persist the "all" sentinel or the default would reassert. */
export function storedFilterValue<TData>(filter: ConsoleTableFilter<TData> | undefined, value: string) {
  if (filter?.defaultValue !== undefined && value === "") return FILTER_ALL_VALUE;
  return value;
}

export function optionItems(values: string[]) {
  return uniqueOptionItems(values.map((value) => ({ value, label: value })));
}

export function uniqueOptionItems(values: ConsoleTableFilterOption[]) {
  const options = new Map<string, string>();
  values.forEach((item) => {
    if (!options.has(item.value)) options.set(item.value, item.label);
  });
  return [...options].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export function applyConsoleTableFilters<TData>({
  data,
  search,
  searchValue,
  filters,
  filterValues,
  advancedFields = [],
  advancedRules = []
}: {
  data: TData[];
  search?: ConsoleTableSearch<TData>;
  searchValue: string;
  filters: ConsoleTableFilter<TData>[];
  filterValues: Record<string, string>;
  advancedFields?: ConsoleTableAdvancedField<TData>[];
  advancedRules?: ConsoleTableAdvancedRule[];
}) {
  const normalizedSearch = searchValue.trim().toLowerCase();
  return data.filter((row) => {
    if (search && normalizedSearch && !matchesSearch(row, search, normalizedSearch)) return false;
    if (!filters.every((filter) => matchesFilter(row, filter, filterValues[filter.id]))) return false;
    return matchesAdvancedRules(row, advancedFields, advancedRules);
  });
}

function matchesSearch<TData>(row: TData, search: ConsoleTableSearch<TData>, searchValue: string) {
  return normalizeValues(search.getValue(row)).some((value) => value.toLowerCase().includes(searchValue));
}

function matchesFilter<TData>(row: TData, filter: ConsoleTableFilter<TData>, selectedValue?: string) {
  if (!selectedValue) return true;
  return normalizeValues(filter.getValue(row)).includes(selectedValue);
}

function normalizeValues(value: string | string[] | null | undefined) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function matchesAdvancedRules<TData>(
  row: TData,
  fields: ConsoleTableAdvancedField<TData>[],
  rules: ConsoleTableAdvancedRule[]
) {
  const activeRules = rules.filter((rule) => rule.operator === "isEmpty" || rule.operator === "isNotEmpty" || rule.value.trim());
  if (activeRules.length === 0) return true;

  return activeRules.reduce<boolean | null>((result, rule) => {
    const field = fields.find((item) => item.id === rule.fieldId);
    const matches = field ? matchesAdvancedRule(row, field, rule) : true;
    if (result === null) return matches;
    return rule.join === "or" ? result || matches : result && matches;
  }, null) ?? true;
}

function matchesAdvancedRule<TData>(
  row: TData,
  field: ConsoleTableAdvancedField<TData>,
  rule: ConsoleTableAdvancedRule
) {
  const values = normalizeAdvancedValues(field.getValue(row));
  const needle = rule.value.trim().toLowerCase();
  if (rule.operator === "isEmpty") return values.length === 0;
  if (rule.operator === "isNotEmpty") return values.length > 0;

  return values.some((value) => {
    const candidate = value.toLowerCase();
    if (rule.operator === "equals") return candidate === needle;
    if (rule.operator === "startsWith") return candidate.startsWith(needle);
    if (rule.operator === "endsWith") return candidate.endsWith(needle);
    return candidate.includes(needle);
  });
}

function normalizeAdvancedValues(value: string | string[] | number | null | undefined) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return [String(value)];
}
