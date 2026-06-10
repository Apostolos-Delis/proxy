import type { PaginationState, SortingState, VisibilityState } from "@tanstack/react-table";

import type { ConsoleTableAdvancedOperator, ConsoleTableAdvancedRule } from "./types";

export type ConsoleTableUrlConfig = {
  prefix: string;
  filterIds: string[];
  advancedFieldIds: string[];
  columnIds: string[];
  initialPageSize: number;
  pageSizeOptions: number[];
};

export type ConsoleTableUrlState = {
  searchValue: string;
  filterValues: Record<string, string>;
  advancedRules: ConsoleTableAdvancedRule[];
  sorting: SortingState;
  columnVisibility: VisibilityState;
  pagination: PaginationState;
};

/** Param values to merge into the current search; `undefined` removes a param. */
export type ConsoleTableUrlPatch = Record<string, unknown>;

const RESERVED_PARAMS = new Set(["q", "sort", "page", "size", "hide", "adv"]);
const ADVANCED_OPERATORS: ConsoleTableAdvancedOperator[] = ["contains", "equals", "startsWith", "endsWith", "isEmpty", "isNotEmpty"];

export function readConsoleTableUrlState(search: Record<string, unknown>, config: ConsoleTableUrlConfig): ConsoleTableUrlState {
  return {
    searchValue: paramString(search[paramName(config, "q")]),
    filterValues: Object.fromEntries(
      config.filterIds
        .map((filterId) => [filterId, paramString(search[filterParamName(config, filterId)])])
        .filter(([, value]) => value)
    ),
    advancedRules: readAdvancedRules(search[paramName(config, "adv")], config.advancedFieldIds),
    sorting: readSorting(search[paramName(config, "sort")], config.columnIds),
    columnVisibility: readColumnVisibility(search[paramName(config, "hide")], config.columnIds),
    pagination: {
      pageIndex: readPositiveInt(search[paramName(config, "page")], 1) - 1,
      pageSize: readPageSize(search[paramName(config, "size")], config)
    }
  };
}

export function searchValuePatch(config: ConsoleTableUrlConfig, value: string): ConsoleTableUrlPatch {
  return { [paramName(config, "q")]: value || undefined, [paramName(config, "page")]: undefined };
}

export function filterValuePatch(config: ConsoleTableUrlConfig, filterId: string, value: string): ConsoleTableUrlPatch {
  return { [filterParamName(config, filterId)]: value || undefined, [paramName(config, "page")]: undefined };
}

export function filterValuesPatch(config: ConsoleTableUrlConfig, values: Record<string, string>): ConsoleTableUrlPatch {
  return {
    ...Object.fromEntries(config.filterIds.map((filterId) => [filterParamName(config, filterId), values[filterId] || undefined])),
    [paramName(config, "page")]: undefined
  };
}

export function advancedRulesPatch(config: ConsoleTableUrlConfig, rules: ConsoleTableAdvancedRule[]): ConsoleTableUrlPatch {
  const encoded = rules.map((rule) => [rule.fieldId, rule.operator, rule.value, rule.join]);
  return { [paramName(config, "adv")]: encoded.length > 0 ? encoded : undefined, [paramName(config, "page")]: undefined };
}

// Sort encoding requires column ids without commas or a leading "-".
export function sortingPatch(config: ConsoleTableUrlConfig, sorting: SortingState): ConsoleTableUrlPatch {
  const encoded = sorting.map((entry) => (entry.desc ? `-${entry.id}` : entry.id)).join(",");
  return { [paramName(config, "sort")]: encoded || undefined };
}

export function columnVisibilityPatch(config: ConsoleTableUrlConfig, visibility: VisibilityState): ConsoleTableUrlPatch {
  const hidden = Object.entries(visibility)
    .filter(([, visible]) => visible === false)
    .map(([columnId]) => columnId)
    .sort();
  return { [paramName(config, "hide")]: hidden.length > 0 ? hidden.join(",") : undefined };
}

export function paginationPatch(config: ConsoleTableUrlConfig, pagination: PaginationState): ConsoleTableUrlPatch {
  return {
    [paramName(config, "page")]: pagination.pageIndex > 0 ? pagination.pageIndex + 1 : undefined,
    [paramName(config, "size")]: pagination.pageSize === config.initialPageSize ? undefined : pagination.pageSize
  };
}

/** Clears search, filters, advanced rules, sorting, hidden columns, and page. Keeps page size. */
export function clearTablePatch(config: ConsoleTableUrlConfig): ConsoleTableUrlPatch {
  return {
    ...Object.fromEntries(config.filterIds.map((filterId) => [filterParamName(config, filterId), undefined])),
    [paramName(config, "q")]: undefined,
    [paramName(config, "adv")]: undefined,
    [paramName(config, "sort")]: undefined,
    [paramName(config, "hide")]: undefined,
    [paramName(config, "page")]: undefined
  };
}

function paramName(config: ConsoleTableUrlConfig, name: string) {
  return config.prefix ? `${config.prefix}_${name}` : name;
}

function filterParamName(config: ConsoleTableUrlConfig, filterId: string) {
  // Ids already starting with f_ are escaped too, so "page" (→ f_page) can never collide with a literal "f_page".
  const collides = RESERVED_PARAMS.has(filterId) || filterId.startsWith("f_");
  return paramName(config, collides ? `f_${filterId}` : filterId);
}

function paramString(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function readPositiveInt(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(paramString(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readPageSize(value: unknown, config: ConsoleTableUrlConfig) {
  const size = readPositiveInt(value, config.initialPageSize);
  const allowed = new Set([...config.pageSizeOptions, config.initialPageSize]);
  return allowed.has(size) ? size : config.initialPageSize;
}

function readSorting(value: unknown, columnIds: string[]): SortingState {
  return paramString(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({ id: entry.replace(/^-/, ""), desc: entry.startsWith("-") }))
    .filter((entry) => columnIds.includes(entry.id));
}

function readColumnVisibility(value: unknown, columnIds: string[]): VisibilityState {
  return Object.fromEntries(
    paramString(value)
      .split(",")
      .map((entry) => entry.trim())
      .filter((columnId) => columnId && columnIds.includes(columnId))
      .map((columnId) => [columnId, false])
  );
}

function readAdvancedRules(value: unknown, advancedFieldIds: string[]): ConsoleTableAdvancedRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 4) return [];
    const [fieldId, operator, ruleValue, join] = entry as unknown[];
    if (typeof fieldId !== "string" || !advancedFieldIds.includes(fieldId)) return [];
    if (typeof operator !== "string" || !ADVANCED_OPERATORS.includes(operator as ConsoleTableAdvancedOperator)) return [];
    if (join !== "and" && join !== "or") return [];
    return [{ id: `url-${index}`, fieldId, operator: operator as ConsoleTableAdvancedOperator, value: paramString(ruleValue), join }];
  });
}
