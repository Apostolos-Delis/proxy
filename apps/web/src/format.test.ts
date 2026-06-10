import { describe, expect, it } from "vitest";

import { formatDurationMs } from "./format";

describe("formatDurationMs", () => {
  it("renders sub-second values as milliseconds", () => {
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(-1)).toBe("0ms");
    expect(formatDurationMs(999)).toBe("999ms");
  });

  it("renders seconds with precision scaled to magnitude", () => {
    expect(formatDurationMs(1400)).toBe("1.40s");
    expect(formatDurationMs(9_499)).toBe("9.50s");
    expect(formatDurationMs(9_999)).toBe("10.0s");
    expect(formatDurationMs(12_300)).toBe("12.3s");
  });

  it("rolls seconds into minutes without 60s artifacts", () => {
    expect(formatDurationMs(59_999)).toBe("1m");
    expect(formatDurationMs(228_000)).toBe("3m 48s");
    expect(formatDurationMs(119_700)).toBe("2m");
  });

  it("renders hours with remaining minutes", () => {
    expect(formatDurationMs(3_600_000)).toBe("1h");
    expect(formatDurationMs(3_900_000)).toBe("1h 5m");
  });
});
