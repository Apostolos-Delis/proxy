import { describe, expect, it } from "vitest";

import { expandTabularJsonSpike, tabularJsonSpikeCandidate } from "../src/compressionRules/tabularJsonSpike.js";
import { compactJsonString } from "../src/compressionRules/jsonCompaction.js";

function exactFixtureTokens(text: string) {
  return text.match(/[A-Za-z0-9_]+|[^\s]/g)?.length ?? 0;
}

const linearIssues = Array.from({ length: 40 }, (_, index) => ({
  identifier: `PROXY-${index}`,
  title: `Token-aware compression ${index}`,
  state: index % 2 === 0 ? "Todo" : "In Progress",
  estimate: null
}));

const githubPullRequests = Array.from({ length: 40 }, (_, index) => ({
  number: index + 1,
  title: `Compression PR ${index}`,
  author: `dev-${index}`,
  merged: index % 3 === 0
}));

const slackMessages = Array.from({ length: 40 }, (_, index) => ({
  channel: "router-research",
  user: `U${index}`,
  text: `Line ${index} with comma, quote "x", tab\tand unicode π`,
  thread_ts: null
}));

const analyticsRows = Array.from({ length: 40 }, (_, index) => ({
  bucket: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
  route: index % 2 === 0 ? "fast" : "hard",
  requests: index + 1,
  failed: false
}));

describe("tabularJsonSpikeCandidate", () => {
  it.each([
    ["Linear issues", linearIssues],
    ["GitHub pull requests", githubPullRequests],
    ["Slack messages", slackMessages],
    ["analytics rows", analyticsRows]
  ])("encodes uniform %s arrays and expands back to the original values", (_name, rows) => {
    const original = JSON.stringify(rows, null, 2);
    const compact = compactJsonString(original);
    const candidate = tabularJsonSpikeCandidate(original);

    expect(candidate).toBeTruthy();
    expect(candidate?.compactJson).toBe(compact);
    expect(candidate?.encoded.length).toBeLessThan(compact?.length ?? 0);
    expect(exactFixtureTokens(candidate?.encoded ?? "")).toBeLessThan(exactFixtureTokens(compact ?? ""));
    expect(expandTabularJsonSpike(candidate?.encoded ?? "")).toEqual(rows);
  });

  it("preserves explicit nulls and string escaping through expansion", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      id: `row-${index}`,
      note: index % 2 === 0 ? "line\ncomma, quote \"x\"" : "tab\tunicode π",
      value: null
    }));
    const candidate = tabularJsonSpikeCandidate(JSON.stringify(rows, null, 2));

    expect(expandTabularJsonSpike(candidate?.encoded ?? "")).toEqual(rows);
  });

  it.each([
    ["large integer", '[{"id":7234567890123456789,"title":"unsafe"},{"id":2,"title":"safe"}]'],
    ["decimal spelling", '[{"id":1.0,"title":"unsafe"},{"id":2,"title":"safe"}]'],
    ["duplicate keys", '[{"id":"a","id":"b","title":"unsafe"},{"id":"c","title":"safe"}]'],
    ["nested non-uniform object", '[{"id":"a","meta":{"x":1}},{"id":"b","meta":{"y":2}}]'],
    ["top-level object wrapper", '{"items":[{"id":"a","title":"wrapped"}]}']
  ])("falls back for %s payloads", (_name, payload) => {
    expect(tabularJsonSpikeCandidate(payload)).toBeUndefined();
  });
});
