import { describe, expect, it } from "vitest";

import { mcpJsonRule } from "../src/compressionRules/mcpJson.js";

function run(toolName: string, content: unknown) {
  return mcpJsonRule.filter({ toolName, toolInput: undefined, content });
}

describe("mcpJsonRule", () => {
  it("matches only mcp__* tools", () => {
    expect(mcpJsonRule.matches("mcp__linear__list_issues")).toBe(true);
    expect(mcpJsonRule.matches("Bash")).toBe(false);
    expect(mcpJsonRule.matches("Read")).toBe(false);
  });

  it("strips pretty-print whitespace from string content", () => {
    const pretty = JSON.stringify({ id: 1, title: "x", nested: { b: 2 } }, null, 2);
    const result = run("mcp__linear__get", pretty) as string;
    expect(result).toBe('{"id":1,"title":"x","nested":{"b":2}}');
    expect(result.length).toBeLessThan(pretty.length);
  });

  it("compacts JSON inside Claude Code text-block array content", () => {
    const pretty = JSON.stringify({ a: 1, b: 2 }, null, 2);
    const result = run("mcp__x__y", [{ type: "text", text: pretty }]) as Array<{ text: string }>;
    expect(result[0].text).toBe('{"a":1,"b":2}');
  });

  it("preserves large integer IDs exactly (no float round-trip)", () => {
    const pretty = `{\n  "issue_id": 7234567890123456789\n}`;
    const result = run("mcp__github__issue", pretty) as string;
    expect(result).toBe('{"issue_id":7234567890123456789}');
  });

  it("preserves null values (does not drop null keys)", () => {
    const pretty = JSON.stringify({ error: null, deleted_at: null, id: 5 }, null, 2);
    const result = run("mcp__x__y", pretty) as string;
    expect(JSON.parse(result)).toEqual({ error: null, deleted_at: null, id: 5 });
  });

  it("preserves number representation (1.0 stays 1.0)", () => {
    const pretty = `{\n  "x": 1.0,\n  "y": 1e10\n}`;
    const result = run("mcp__x__y", pretty) as string;
    expect(result).toBe('{"x":1.0,"y":1e10}');
  });

  it("preserves key order and duplicate keys", () => {
    const pretty = `{\n  "z": 1,\n  "a": 2,\n  "z": 3\n}`;
    const result = run("mcp__x__y", pretty) as string;
    expect(result).toBe('{"z":1,"a":2,"z":3}');
  });

  it("does not strip whitespace inside string values", () => {
    const pretty = `{\n  "msg": "hello   world\\n  indented"\n}`;
    const result = run("mcp__x__y", pretty) as string;
    expect(result).toBe('{"msg":"hello   world\\n  indented"}');
    expect(JSON.parse(result).msg).toBe("hello   world\n  indented");
  });

  it("handles escaped quotes inside strings", () => {
    const pretty = `{\n  "q": "say \\"hi\\" now"\n}`;
    const result = run("mcp__x__y", pretty) as string;
    expect(JSON.parse(result).q).toBe('say "hi" now');
  });

  it("returns undefined for non-JSON content", () => {
    expect(run("mcp__x__y", "just a log line, not json")).toBeUndefined();
  });

  it("returns undefined when already compact", () => {
    expect(run("mcp__x__y", '{"a":1,"b":2}')).toBeUndefined();
  });

  it("is deterministic: same input yields same bytes", () => {
    const pretty = JSON.stringify({ z: 1, a: 2 }, null, 2);
    expect(run("mcp__x__y", pretty)).toBe(run("mcp__x__y", pretty));
  });
});
