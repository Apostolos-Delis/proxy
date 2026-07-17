import { describe, expect, it } from "vitest";

import {
  filterSearchMultiSelectOptions,
  toggleSearchMultiSelectValue,
  type SearchMultiSelectOption
} from "./SearchMultiSelect";

const options: SearchMultiSelectOption[] = [
  { value: "coding", label: "coding-auto", hint: "Configured coding model set", badge: "auto-router" },
  { value: "fable", label: "fable", hint: "Claude Fable 5", badge: "direct" }
];

describe("search multi-select", () => {
  it("filters across model details and toggles values without losing other selections", () => {
    expect(filterSearchMultiSelectOptions(options, "ROUTER")).toEqual([options[0]]);
    expect(filterSearchMultiSelectOptions(options, "claude")).toEqual([options[1]]);
    expect(toggleSearchMultiSelectValue(["coding"], "fable")).toEqual(["coding", "fable"]);
    expect(toggleSearchMultiSelectValue(["coding", "fable"], "coding")).toEqual(["fable"]);
  });
});
