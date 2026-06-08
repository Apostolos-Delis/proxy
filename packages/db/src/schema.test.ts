import { describe, expect, it } from "vitest";

import { events, requests, usageLedger } from "./schema.js";

describe("prompt proxy database schema", () => {
  it("exposes the core durable tables", () => {
    expect(events).toBeTruthy();
    expect(requests).toBeTruthy();
    expect(usageLedger).toBeTruthy();
  });
});
