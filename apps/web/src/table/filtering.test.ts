import { describe, expect, it } from "vitest";

import { applyConsoleTableFilters, FILTER_ALL_VALUE, resolveFilterValues, storedFilterValue } from "./filtering";
import type { ConsoleTableFilter } from "./types";

type Row = { status: string };

const plainFilter: ConsoleTableFilter<Row> = {
  id: "status",
  label: "Status",
  allLabel: "All statuses",
  options: [
    { value: "active", label: "active" },
    { value: "revoked", label: "revoked" }
  ],
  getValue: (row) => row.status
};

const defaultedFilter: ConsoleTableFilter<Row> = { ...plainFilter, defaultValue: "active" };

describe("resolveFilterValues", () => {
  it("passes stored values through for filters without a default", () => {
    expect(resolveFilterValues([plainFilter], {})).toEqual({});
    expect(resolveFilterValues([plainFilter], { status: "revoked" })).toEqual({ status: "revoked" });
  });

  it("applies the default when the filter is untouched", () => {
    expect(resolveFilterValues([defaultedFilter], {})).toEqual({ status: "active" });
  });

  it("clears the filter when the all sentinel is stored", () => {
    expect(resolveFilterValues([defaultedFilter], { status: FILTER_ALL_VALUE })).toEqual({});
  });

  it("prefers an explicit selection over the default", () => {
    expect(resolveFilterValues([defaultedFilter], { status: "revoked" })).toEqual({ status: "revoked" });
  });
});

describe("storedFilterValue", () => {
  it("persists the all sentinel when clearing a defaulted filter", () => {
    expect(storedFilterValue(defaultedFilter, "")).toBe(FILTER_ALL_VALUE);
  });

  it("keeps clearing as removal for filters without a default", () => {
    expect(storedFilterValue(plainFilter, "")).toBe("");
  });

  it("stores explicit selections unchanged", () => {
    expect(storedFilterValue(defaultedFilter, "revoked")).toBe("revoked");
  });
});

describe("default filters end to end", () => {
  const rows: Row[] = [{ status: "active" }, { status: "revoked" }, { status: "expired" }];

  const visible = (stored: Record<string, string>) =>
    applyConsoleTableFilters({
      data: rows,
      searchValue: "",
      filters: [defaultedFilter],
      filterValues: resolveFilterValues([defaultedFilter], stored)
    }).map((row) => row.status);

  it("hides non-default rows until the filter is touched", () => {
    expect(visible({})).toEqual(["active"]);
  });

  it("shows everything once cleared and a specific status when selected", () => {
    expect(visible({ status: FILTER_ALL_VALUE })).toEqual(["active", "revoked", "expired"]);
    expect(visible({ status: "revoked" })).toEqual(["revoked"]);
  });
});
