import { describe, expect, it } from "vitest";

import { filterSearchOptions, type SearchSelectOption } from "./SearchSelect";

const options: SearchSelectOption[] = [
  { value: "", label: "Company default" },
  { value: "a", label: "Research team key", hint: "••••1234" },
  { value: "b", label: "CI smoke key", hint: "••••5678" }
];

describe("filterSearchOptions", () => {
  it("returns everything for an empty or whitespace query", () => {
    expect(filterSearchOptions(options, "")).toEqual(options);
    expect(filterSearchOptions(options, "   ")).toEqual(options);
  });

  it("matches case-insensitively on the label", () => {
    expect(filterSearchOptions(options, "RESEARCH").map((option) => option.value)).toEqual(["a"]);
  });

  it("matches on the hint", () => {
    expect(filterSearchOptions(options, "5678").map((option) => option.value)).toEqual(["b"]);
  });

  it("returns nothing when no option matches", () => {
    expect(filterSearchOptions(options, "zzz")).toEqual([]);
  });
});
