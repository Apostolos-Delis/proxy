import { useNavigate, useSearch } from "@tanstack/react-router";
import { functionalUpdate, type PaginationState, type SortingState, type Updater, type VisibilityState } from "@tanstack/react-table";
import { useState } from "react";

import type { ConsoleTableAdvancedRule, ConsoleTableView } from "./types";
import {
  advancedRulesPatch,
  clearTablePatch,
  columnVisibilityPatch,
  filterValuePatch,
  filterValuesPatch,
  paginationPatch,
  readConsoleTableUrlState,
  searchValuePatch,
  sortingPatch,
  type ConsoleTableUrlConfig,
  type ConsoleTableUrlPatch
} from "./urlState";

export type ConsoleTableStateOptions = {
  urlState?: boolean | string;
  stateKey?: string;
  views: ConsoleTableView[];
  filterIds: string[];
  advancedFieldIds: string[];
  columnIds: string[];
  initialPageSize: number;
  pageSizeOptions: number[];
};

export type ConsoleTableState = {
  searchValue: string;
  filterValues: Record<string, string>;
  advancedRules: ConsoleTableAdvancedRule[];
  sorting: SortingState;
  columnVisibility: VisibilityState;
  pagination: PaginationState;
  activeViewId: string | null;
  setSearchValue: (value: string) => void;
  setFilterValue: (filterId: string, value: string) => void;
  setAdvancedRules: (rules: ConsoleTableAdvancedRule[]) => void;
  updateSorting: (updater: Updater<SortingState>) => void;
  updateColumnVisibility: (updater: Updater<VisibilityState>) => void;
  updatePagination: (updater: Updater<PaginationState>) => void;
  applyView: (view: ConsoleTableView) => void;
  clear: () => void;
};

export function useConsoleTableState(options: ConsoleTableStateOptions): ConsoleTableState {
  const memoryState = useMemoryTableState(options);
  const urlTableState = useUrlTableState(options);
  return options.urlState ? urlTableState : memoryState;
}

function useMemoryTableState({ views, stateKey, initialPageSize }: ConsoleTableStateOptions): ConsoleTableState {
  const [searchValue, setSearchValue] = useState("");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [advancedRules, setAdvancedRules] = useState<ConsoleTableAdvancedRule[]>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: initialPageSize });
  const [activeViewId, setActiveViewId] = useState<string | null>(views[0]?.id ?? null);
  const [appliedStateKey, setAppliedStateKey] = useState(stateKey);
  if (stateKey !== appliedStateKey) {
    setAppliedStateKey(stateKey);
    setSearchValue("");
    setFilterValues({});
    setAdvancedRules([]);
    setSorting([]);
    setActiveViewId(views[0]?.id ?? null);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  }

  return {
    searchValue,
    filterValues,
    advancedRules,
    sorting,
    columnVisibility,
    pagination,
    activeViewId,
    setSearchValue: (value) => {
      setActiveViewId(null);
      setPagination((current) => ({ ...current, pageIndex: 0 }));
      setSearchValue(value);
    },
    setFilterValue: (filterId, value) => {
      setActiveViewId(null);
      setPagination((current) => ({ ...current, pageIndex: 0 }));
      setFilterValues((current) => ({ ...current, [filterId]: value }));
    },
    setAdvancedRules: (rules) => {
      setActiveViewId(null);
      setPagination((current) => ({ ...current, pageIndex: 0 }));
      setAdvancedRules(rules);
    },
    updateSorting: (updater) => {
      setActiveViewId(null);
      setSorting((current) => functionalUpdate(updater, current));
    },
    updateColumnVisibility: (updater) => {
      setActiveViewId(null);
      setColumnVisibility((current) => functionalUpdate(updater, current));
    },
    updatePagination: setPagination,
    applyView: (view) => {
      setActiveViewId(view.id);
      setSearchValue(view.search ?? "");
      setFilterValues(view.filters ?? {});
      setAdvancedRules(view.advancedRules ?? []);
      setColumnVisibility(view.columnVisibility ?? {});
      setSorting(view.sorting ?? []);
      setPagination((current) => ({ ...current, pageIndex: 0 }));
    },
    clear: () => {
      setActiveViewId(views[0]?.id ?? null);
      setSearchValue("");
      setFilterValues({});
      setAdvancedRules([]);
      setColumnVisibility({});
      setSorting([]);
      setPagination((current) => ({ ...current, pageIndex: 0 }));
    }
  };
}

function useUrlTableState(options: ConsoleTableStateOptions): ConsoleTableState {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const [activeViewId, setActiveViewId] = useState<string | null>(options.views[0]?.id ?? null);
  const config: ConsoleTableUrlConfig = {
    prefix: typeof options.urlState === "string" ? options.urlState : "",
    filterIds: options.filterIds,
    advancedFieldIds: options.advancedFieldIds,
    columnIds: options.columnIds,
    initialPageSize: options.initialPageSize,
    pageSizeOptions: options.pageSizeOptions
  };
  const state = readConsoleTableUrlState(search, config);
  const patchSearch = (patch: ConsoleTableUrlPatch, viewId: string | null = null) => {
    setActiveViewId(viewId);
    void navigate({ to: ".", search: (current) => ({ ...current, ...patch }), replace: true });
  };

  return {
    ...state,
    activeViewId,
    setSearchValue: (value) => patchSearch(searchValuePatch(config, value)),
    setFilterValue: (filterId, value) => patchSearch(filterValuePatch(config, filterId, value)),
    setAdvancedRules: (rules) => patchSearch(advancedRulesPatch(config, rules)),
    updateSorting: (updater) => patchSearch(sortingPatch(config, functionalUpdate(updater, state.sorting))),
    updateColumnVisibility: (updater) => patchSearch(columnVisibilityPatch(config, functionalUpdate(updater, state.columnVisibility))),
    updatePagination: (updater) => {
      const patch = paginationPatch(config, functionalUpdate(updater, state.pagination));
      void navigate({ to: ".", search: (current) => ({ ...current, ...patch }), replace: true });
    },
    applyView: (view) =>
      patchSearch(
        {
          ...clearTablePatch(config),
          ...searchValuePatch(config, view.search ?? ""),
          ...filterValuesPatch(config, view.filters ?? {}),
          ...advancedRulesPatch(config, view.advancedRules ?? []),
          ...sortingPatch(config, view.sorting ?? []),
          ...columnVisibilityPatch(config, view.columnVisibility ?? {})
        },
        view.id
      ),
    clear: () => patchSearch(clearTablePatch(config), options.views[0]?.id ?? null)
  };
}
