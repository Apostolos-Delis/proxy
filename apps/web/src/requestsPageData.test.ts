import { describe, expect, it } from "vitest";

import { uniqueOptions } from "./requestsPageData";

describe("uniqueOptions", () => {
  it("returns sorted unique truthy options for request log filters", () => {
    expect(uniqueOptions(["gpt-5", "", "claude", "gpt-5", "o4-mini"])).toEqual([
      "claude",
      "gpt-5",
      "o4-mini"
    ]);
  });
});
