import { describe, expect, it } from "vitest";

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
  type ConsoleTableUrlConfig
} from "./urlState";

const config: ConsoleTableUrlConfig = {
  prefix: "",
  filterIds: ["user", "model", "status"],
  advancedFieldIds: ["proxy", "model"],
  columnIds: ["proxy", "user", "model", "tokens"],
  initialPageSize: 10,
  pageSizeOptions: [10, 25, 50]
};

describe("readConsoleTableUrlState", () => {
  it("returns defaults for an empty search", () => {
    expect(readConsoleTableUrlState({}, config)).toEqual({
      searchValue: "",
      filterValues: {},
      advancedRules: [],
      sorting: [],
      columnVisibility: {},
      pagination: { pageIndex: 0, pageSize: 10 }
    });
  });

  it("reads search, filters, sorting, visibility, and pagination", () => {
    const state = readConsoleTableUrlState(
      { q: "he", user: "u_123", model: "gpt-5.5", sort: "-tokens,user", hide: "model,tokens", page: 3, size: 25 },
      config
    );
    expect(state.searchValue).toBe("he");
    expect(state.filterValues).toEqual({ user: "u_123", model: "gpt-5.5" });
    expect(state.sorting).toEqual([{ id: "tokens", desc: true }, { id: "user", desc: false }]);
    expect(state.columnVisibility).toEqual({ model: false, tokens: false });
    expect(state.pagination).toEqual({ pageIndex: 2, pageSize: 25 });
  });

  it("coerces non-string param values parsed from the URL", () => {
    const state = readConsoleTableUrlState({ q: 123, user: true }, config);
    expect(state.searchValue).toBe("123");
    expect(state.filterValues).toEqual({ user: "true" });
  });

  it("drops unknown sort columns, hidden columns, and invalid pagination", () => {
    const state = readConsoleTableUrlState({ sort: "-nope,tokens", hide: "nope", page: "zero", size: 999 }, config);
    expect(state.sorting).toEqual([{ id: "tokens", desc: false }]);
    expect(state.columnVisibility).toEqual({});
    expect(state.pagination).toEqual({ pageIndex: 0, pageSize: 10 });
  });

  it("coerces non-string advanced rule values and drops malformed shapes", () => {
    const state = readConsoleTableUrlState(
      { adv: [["proxy", "contains", 42, "and"], ["model", "equals", null, "or"], ["proxy", "contains", "x", "and", "extra"]] },
      config
    );
    expect(state.advancedRules).toEqual([
      { id: "url-0", fieldId: "proxy", operator: "contains", value: "42", join: "and" },
      { id: "url-1", fieldId: "model", operator: "equals", value: "", join: "or" }
    ]);
  });

  it("reads valid advanced rules and drops malformed entries", () => {
    const state = readConsoleTableUrlState(
      { adv: [["proxy", "contains", "routing", "and"], ["nope", "contains", "x", "and"], ["model", "explodes", "x", "and"], ["model", "equals", "gpt", "nor"], "junk"] },
      config
    );
    expect(state.advancedRules).toEqual([
      { id: "url-0", fieldId: "proxy", operator: "contains", value: "routing", join: "and" }
    ]);
  });

  it("round-trips state written by the patch helpers", () => {
    const search = {
      ...searchValuePatch(config, "hello"),
      ...filterValuePatch(config, "status", "ok"),
      ...sortingPatch(config, [{ id: "tokens", desc: true }]),
      ...columnVisibilityPatch(config, { model: false, user: true }),
      ...advancedRulesPatch(config, [{ id: "a", fieldId: "model", operator: "equals", value: "gpt", join: "or" }]),
      ...paginationPatch(config, { pageIndex: 4, pageSize: 50 })
    };
    const state = readConsoleTableUrlState(search as Record<string, unknown>, config);
    expect(state.searchValue).toBe("hello");
    expect(state.filterValues).toEqual({ status: "ok" });
    expect(state.sorting).toEqual([{ id: "tokens", desc: true }]);
    expect(state.columnVisibility).toEqual({ model: false });
    expect(state.advancedRules).toEqual([{ id: "url-0", fieldId: "model", operator: "equals", value: "gpt", join: "or" }]);
    expect(state.pagination).toEqual({ pageIndex: 4, pageSize: 50 });
  });
});

describe("patch helpers", () => {
  it("omits params at their defaults", () => {
    expect(searchValuePatch(config, "")).toEqual({ q: undefined, page: undefined });
    expect(sortingPatch(config, [])).toEqual({ sort: undefined });
    expect(columnVisibilityPatch(config, { model: true })).toEqual({ hide: undefined });
    expect(advancedRulesPatch(config, [])).toEqual({ adv: undefined, page: undefined });
    expect(paginationPatch(config, { pageIndex: 0, pageSize: 10 })).toEqual({ page: undefined, size: undefined });
  });

  it("resets the page when search or filters change", () => {
    expect(searchValuePatch(config, "x")).toEqual({ q: "x", page: undefined });
    expect(filterValuePatch(config, "user", "u_1")).toEqual({ user: "u_1", page: undefined });
    expect(filterValuesPatch(config, { user: "u_1" })).toEqual({ user: "u_1", model: undefined, status: undefined, page: undefined });
  });

  it("clears every table param except page size", () => {
    expect(clearTablePatch(config)).toEqual({
      q: undefined,
      adv: undefined,
      sort: undefined,
      hide: undefined,
      page: undefined,
      user: undefined,
      model: undefined,
      status: undefined
    });
  });

  it("prefixes params and escapes filter ids that collide with reserved names", () => {
    const prefixed: ConsoleTableUrlConfig = { ...config, prefix: "t", filterIds: ["sort", "user"] };
    expect(searchValuePatch(prefixed, "x")).toEqual({ t_q: "x", t_page: undefined });
    expect(filterValuePatch(prefixed, "sort", "asc")).toEqual({ t_f_sort: "asc", t_page: undefined });
    const bare: ConsoleTableUrlConfig = { ...config, filterIds: ["page"] };
    expect(filterValuePatch(bare, "page", "two")).toEqual({ f_page: "two", page: undefined });
    const state = readConsoleTableUrlState({ f_page: "two" }, bare);
    expect(state.filterValues).toEqual({ page: "two" });
  });

  it("keeps a literal f_-prefixed filter id distinct from an escaped reserved id", () => {
    const colliding: ConsoleTableUrlConfig = { ...config, filterIds: ["page", "f_page"] };
    expect(filterValuePatch(colliding, "page", "a")).toEqual({ f_page: "a", page: undefined });
    expect(filterValuePatch(colliding, "f_page", "b")).toEqual({ f_f_page: "b", page: undefined });
    const state = readConsoleTableUrlState({ f_page: "a", f_f_page: "b" }, colliding);
    expect(state.filterValues).toEqual({ page: "a", f_page: "b" });
  });
});
