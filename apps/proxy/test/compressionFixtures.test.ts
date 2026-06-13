import { describe, expect, it } from "vitest";

import { compressToolResults, type CompressionRecord } from "../src/toolResultCompression.js";
import { roughTokenEstimate } from "../src/util.js";

const esc = String.fromCharCode(27);

type CompressionFixture = {
  name: string;
  toolName: string;
  content: string;
  expectedRule?: string;
  assertOutput: (output: string) => void;
};

const prettyJson = `{
  "issue_id": 7234567890123456789,
  "x": 1.0,
  "z": 1,
  "z": 2,
  "items": [
${Array.from({ length: 40 }, (_, index) => `    { "id": "${index}", "note": "value ${index}" }`).join(",\n")}
  ]
}`;

const csv = [
  "id,name,amount,status",
  ...Array.from({ length: 80 }, (_, index) => `${index},Customer ${index},${index * 7},active`)
].join("\n");

const tsv = [
  "id\tpath\tstatus",
  ...Array.from({ length: 80 }, (_, index) => `${index}\tsrc/module_${index}.ts\tmatched`)
].join("\n");

const shellLog = `${esc}[32mPASS${esc}[0m\nDownloading\r10%\r100%\n${`${esc}[33mWARN${esc}[0m detail\n`.repeat(80)}`;

const searchOutput = Array.from(
  { length: 80 },
  (_, index) => `src/file_${index}.ts:${index + 1}: matched search result with context`
).join("\n");

const browserOutput = [
  "URL: https://example.test/dashboard",
  "Title: Operations dashboard",
  "Text:",
  ...Array.from({ length: 80 }, (_, index) => `Section ${index}: visible row ${index} with status ready`)
].join("\n");

const fixtures: CompressionFixture[] = [
  {
    name: "pretty JSON with exact numeric spellings",
    toolName: "CustomJsonTool",
    content: prettyJson,
    expectedRule: "json-whitespace",
    assertOutput: (output) => {
      expect(output).not.toContain("\n");
      expect(output).toContain('"issue_id":7234567890123456789');
      expect(output).toContain('"x":1.0');
      expect(output).toContain('"z":1,"z":2');
      expect(JSON.parse(output).items).toHaveLength(40);
    }
  },
  {
    name: "CSV table",
    toolName: "CustomReportTool",
    content: csv,
    assertOutput: (output) => expect(output).toBe(csv)
  },
  {
    name: "TSV table",
    toolName: "CustomReportTool",
    content: tsv,
    assertOutput: (output) => expect(output).toBe(tsv)
  },
  {
    name: "shell log",
    toolName: "Bash",
    content: shellLog,
    expectedRule: "bash-output-noise",
    assertOutput: (output) => {
      expect(output).not.toContain(esc);
      expect(output).not.toContain("\r10%");
      expect(output).toContain("100%");
      expect(output).toContain("WARN detail");
    }
  },
  {
    name: "search output",
    toolName: "Search",
    content: searchOutput,
    assertOutput: (output) => expect(output).toBe(searchOutput)
  },
  {
    name: "browser-like output",
    toolName: "browser_snapshot",
    content: browserOutput,
    assertOutput: (output) => expect(output).toBe(browserOutput)
  }
];

describe("compression fixture corpus", () => {
  it.each(fixtures)("$name preserves expected semantics", (fixture) => {
    const result = runFixture(fixture);
    fixture.assertOutput(result.output);
    if (fixture.expectedRule) {
      expect(result.record?.rule).toBe(fixture.expectedRule);
      expect(result.record?.savedEstimatedTokens).toBeGreaterThan(0);
    } else {
      expect(result.record).toBeUndefined();
      expect(result.output).toBe(fixture.content);
    }
  });

  it("records non-negative estimated token savings for every fixture", () => {
    const rows = fixtures.map((fixture) => {
      const result = runFixture(fixture);
      const beforeEstimatedTokens = roughTokenEstimate(fixture.content.length);
      const afterEstimatedTokens = roughTokenEstimate(result.output.length);
      return {
        name: fixture.name,
        rule: result.record?.rule ?? null,
        beforeEstimatedTokens,
        afterEstimatedTokens,
        savedEstimatedTokens: beforeEstimatedTokens - afterEstimatedTokens,
        recordSavedEstimatedTokens: result.record?.savedEstimatedTokens ?? 0
      };
    });

    expect(rows.map((row) => ({ name: row.name, rule: row.rule }))).toEqual([
      { name: "pretty JSON with exact numeric spellings", rule: "json-whitespace" },
      { name: "CSV table", rule: null },
      { name: "TSV table", rule: null },
      { name: "shell log", rule: "bash-output-noise" },
      { name: "search output", rule: null },
      { name: "browser-like output", rule: null }
    ]);
    for (const row of rows) {
      expect(row.beforeEstimatedTokens).toBeGreaterThan(0);
      expect(row.afterEstimatedTokens).toBeGreaterThan(0);
      expect(row.savedEstimatedTokens).toBeGreaterThanOrEqual(0);
      expect(row.recordSavedEstimatedTokens).toBe(row.savedEstimatedTokens);
    }
  });
});

function runFixture(fixture: CompressionFixture) {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: fixture.toolName, input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: fixture.content }] }
    ]
  };
  const result = compressToolResults("anthropic-messages", body) as {
    body: { messages: Array<{ content: Array<{ content: string }> }> };
    records: CompressionRecord[];
  };
  return {
    output: result.body.messages[1].content[0].content,
    record: result.records[0]
  };
}
