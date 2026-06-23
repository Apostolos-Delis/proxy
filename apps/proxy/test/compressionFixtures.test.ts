import { describe, expect, it } from "vitest";

import { defaultCompressionPolicy } from "@prompt-proxy/schema";

import { benchmarkCompressionFixtures } from "../src/compressionBenchmark.js";
import { expandJsonArrayCompaction } from "../src/compressionRules/jsonCompaction.js";
import {
  compressToolResults,
  compressionRules,
  compressionRulesForPolicy,
  type CompressionRecord,
  type CompressionOptions,
  type CompressionRule
} from "../src/toolResultCompression.js";
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

const githubJson = JSON.stringify({
  issues: Array.from({ length: 60 }, (_, index) => ({
    id: `I_kwDO${index}`,
    number: index + 1,
    title: `Improve compression benchmark ${index}`,
    labels: ["routing", "compression"],
    assignee: null
  }))
}, null, 2);

const linearJson = JSON.stringify({
  nodes: Array.from({ length: 60 }, (_, index) => ({
    identifier: `PROXY-${index}`,
    title: `Token-aware receipt ${index}`,
    state: { name: index % 2 === 0 ? "Todo" : "In Progress" },
    estimate: null
  }))
}, null, 2);

const slackJson = JSON.stringify({
  messages: Array.from({ length: 60 }, (_, index) => ({
    channel: "router-research",
    user: `U${index}`,
    text: `Compression rollout note ${index}`,
    thread_ts: null
  }))
}, null, 2);

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

const rgSearchOutput = [
  ...Array.from(
    { length: 45 },
    (_, index) => `apps/proxy/src/toolResultCompression.ts:${120 + index}:7:const groupedHit${index} = "router";`
  ),
  ...Array.from(
    { length: 45 },
    (_, index) => `apps/proxy/src/compressionRules/searchResults.ts:${20 + index}:3:return groupedHit${index};`
  )
].join("\n");

const repositorySearchOutput = [
  ...Array.from(
    { length: 50 },
    (_, index) => `packages/db/src/schema.ts:${200 + index}:export const requestSearchColumn${index} = text("request_${index}");`
  ),
  ...Array.from(
    { length: 35 },
    (_, index) => `packages/db/src/schema.ts:${400 + index}:export const receiptSearchColumn${index} = text("receipt_${index}");`
  )
].join("\n");

const githubSearchOutput = [
  ...Array.from(
    { length: 40 },
    (_, index) => `headroom/apps/proxy/src/server.ts:${80 + index}:fastify.post("/v1/search/${index}", handler);`
  ),
  ...Array.from(
    { length: 40 },
    (_, index) => `headroom/apps/proxy/src/routes/compression.ts:${30 + index}:router.get("/compression/${index}", handler);`
  )
].join("\n");

const grepOutput = Array.from(
  { length: 80 },
  (_, index) => `apps/proxy/src/file_${index}.ts:${index + 1}:const value_${index} = "match";`
).join("\n");

const testOutput = `${esc}[32m✓${esc}[0m compression.test.ts\n${`${esc}[32m✓${esc}[0m case passed\n`.repeat(100)}`;

const buildOutput = [
  `${esc}[36mwebpack${esc}[0m compiling\r10%\r60%\r100%`,
  ...Array.from({ length: 80 }, (_, index) => `${esc}[32masset${esc}[0m chunk-${index}.js ${index + 1} KiB`)
].join("\n");

const pytestLogOutput = [
  ...Array.from({ length: 160 }, (_, index) => `collecting pytest case ${index}`),
  "FAILED tests/test_router.py::test_routes",
  "tests/test_router.py:42: AssertionError",
  "Traceback (most recent call last):",
  "  File \"tests/test_router.py\", line 42, in test_routes",
  "AssertionError: expected hard route",
  ...Array.from({ length: 60 }, (_, index) => `pytest tail line ${index}`)
].join("\n");

const vitestLogOutput = [
  ...Array.from({ length: 140 }, (_, index) => `✓ src/components/view_${index}.test.ts > renders row ${index}`),
  "WARN retrying flaky fetch in src/components/view_99.test.ts",
  ...Array.from({ length: 55 }, (_, index) => `vitest tail line ${index}`)
].join("\n");

const tscLogOutput = [
  ...Array.from({ length: 220 }, (_, index) => `semantic check pass ${index}`),
  "src/router.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
  "12 const routeId: number = \"bad\";",
  ...Array.from({ length: 55 }, (_, index) => `tsc tail line ${index}`)
].join("\n");

const packageInstallLogOutput = [
  ...Array.from({ length: 150 }, (_, index) => `Progress: resolved ${index}, reused ${index}, downloaded ${index}, added ${index}`),
  "WARN deprecated left-pad@1.3.0: use String.prototype.padStart",
  ...Array.from({ length: 55 }, (_, index) => `install tail line ${index}`)
].join("\n");

const genericShellLogOutput = [
  ...Array.from({ length: 150 }, (_, index) => `processing shard ${index}`),
  "Command exited with code 0",
  ...Array.from({ length: 55 }, (_, index) => `generic tail line ${index}`)
].join("\n");

const gitDiffOutput = [
  "diff --git a/apps/proxy/src/generated.ts b/apps/proxy/src/generated.ts",
  "index 1111111..2222222 100644",
  "--- a/apps/proxy/src/generated.ts",
  "+++ b/apps/proxy/src/generated.ts",
  "@@ -1,80 +1,141 @@",
  ...Array.from({ length: 24 }, (_, index) => ` context line ${index}`),
  ...Array.from({ length: 80 }, (_, index) => `+export const generated_${index} = "value_${index}";`),
  "+console.error(\"failed route\");",
  ...Array.from({ length: 20 }, (_, index) => `-export const oldGenerated_${index} = "old_${index}";`),
  ...Array.from({ length: 24 }, (_, index) => ` trailing context line ${index}`)
].join("\n");

const packageLockDiffOutput = [
  "diff --git a/package-lock.json b/package-lock.json",
  "index 3333333..4444444 100644",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -20,6 +20,126 @@",
  ...Array.from({ length: 18 }, (_, index) => `     "existing-package-${index}": "1.0.${index}",`),
  ...Array.from({ length: 120 }, (_, index) => `+    "node_modules/generated-pkg-${index}": "2.0.${index}",`),
  ...Array.from({ length: 18 }, (_, index) => `     "tail-package-${index}": "1.1.${index}",`)
].join("\n");

const generatedFileDiffOutput = [
  "diff --git a/apps/web/src/gql/graphql.ts b/apps/web/src/gql/graphql.ts",
  "index 5555555..6666666 100644",
  "--- a/apps/web/src/gql/graphql.ts",
  "+++ b/apps/web/src/gql/graphql.ts",
  "@@ -100,10 +100,170 @@",
  ...Array.from({ length: 16 }, (_, index) => ` export type ExistingGenerated${index} = string;`),
  ...Array.from({ length: 150 }, (_, index) => `+export type GeneratedQuery${index} = { field${index}: string; nested${index}: number };`),
  ...Array.from({ length: 16 }, (_, index) => ` export type TailGenerated${index} = string;`)
].join("\n");

const conflictDiffOutput = [
  "diff --git a/apps/proxy/src/conflict.ts b/apps/proxy/src/conflict.ts",
  "index 7777777..8888888 100644",
  "--- a/apps/proxy/src/conflict.ts",
  "+++ b/apps/proxy/src/conflict.ts",
  "@@ -1,4 +1,8 @@",
  "+<<<<<<< HEAD",
  ...Array.from({ length: 90 }, (_, index) => `+const ours_${index} = true;`),
  "+=======",
  ...Array.from({ length: 90 }, (_, index) => `+const theirs_${index} = true;`),
  "+>>>>>>> branch"
].join("\n");

const browserOutput = [
  "URL: https://example.test/dashboard",
  "Title: Operations dashboard",
  "Text:",
  ...Array.from({ length: 80 }, (_, index) => `Section ${index}: visible row ${index} with status ready`)
].join("\n");

const jsonArrayFixtures: CompressionFixture[] = [
  {
    name: "top-level issue array JSON",
    toolName: "mcp__github__search_issues",
    content: JSON.stringify(
      Array.from({ length: 60 }, (_, index) => ({
        number: index + 1,
        title: `Compression issue ${index}`,
        state: index % 2 === 0 ? "open" : "closed",
        assignee: null
      })),
      null,
      2
    ),
    assertOutput: () => {}
  },
  {
    name: "Linear issues column JSON",
    toolName: "mcp__linear__list_issues",
    content: JSON.stringify({
      nodes: Array.from({ length: 60 }, (_, index) => ({
        identifier: `PROXY-${index}`,
        title: `Token-aware receipt ${index}`,
        state: index % 2 === 0 ? "Todo" : "In Progress",
        estimate: null
      }))
    }, null, 2),
    assertOutput: () => {}
  },
  {
    name: "GitHub pull requests column JSON",
    toolName: "mcp__github__search_pull_requests",
    content: JSON.stringify({
      items: Array.from({ length: 60 }, (_, index) => ({
        number: index + 1,
        title: `Compression PR ${index}`,
        author: `dev-${index}`,
        merged: index % 3 === 0
      }))
    }, null, 2),
    assertOutput: () => {}
  },
  {
    name: "Slack messages column JSON",
    toolName: "mcp__slack__search",
    content: JSON.stringify({
      messages: Array.from({ length: 60 }, (_, index) => ({
        channel: "router-research",
        user: `U${index}`,
        text: `Compression rollout note ${index}`,
        thread_ts: null
      }))
    }, null, 2),
    assertOutput: () => {}
  }
];

const searchResultFixtures: CompressionFixture[] = [
  {
    name: "rg repeated path output",
    toolName: "Bash",
    content: rgSearchOutput,
    assertOutput: (output) => {
      expect(output).toContain("[prompt-proxy.search-result-grouping.v1]");
      expect(output.match(/apps\/proxy\/src\/toolResultCompression\.ts/g) ?? []).toHaveLength(1);
      expect(output).toContain("  120:7: const groupedHit0");
      expect(output).toContain("  64:3: return groupedHit44;");
    }
  },
  {
    name: "repository search repeated path output",
    toolName: "Search",
    content: repositorySearchOutput,
    assertOutput: (output) => {
      expect(output.match(/packages\/db\/src\/schema\.ts/g) ?? []).toHaveLength(1);
      expect(output).toContain("  200: export const requestSearchColumn0");
      expect(output).toContain("  434: export const receiptSearchColumn34");
    }
  },
  {
    name: "GitHub search-like repeated path output",
    toolName: "mcp__github__search_code",
    content: githubSearchOutput,
    assertOutput: (output) => {
      expect(output.match(/headroom\/apps\/proxy\/src\/server\.ts/g) ?? []).toHaveLength(1);
      expect(output.match(/headroom\/apps\/proxy\/src\/routes\/compression\.ts/g) ?? []).toHaveLength(1);
      expect(output).toContain("  80: fastify.post");
      expect(output).toContain("  69: router.get");
    }
  }
];

const logOutputFixtures: CompressionFixture[] = [
  {
    name: "pytest log output",
    toolName: "Bash",
    content: pytestLogOutput,
    assertOutput: (output) => {
      expect(output).toContain("[prompt-proxy.log-output-compaction.v1;");
      expect(output).toContain("FAILED tests/test_router.py::test_routes");
      expect(output).toContain("tests/test_router.py:42: AssertionError");
      expect(output).toContain("Traceback (most recent call last):");
      expect(output).toContain("  File \"tests/test_router.py\", line 42, in test_routes");
      expect(output).toContain("AssertionError: expected hard route");
      expect(output).toContain("pytest tail line 59");
    }
  },
  {
    name: "vitest log output",
    toolName: "Bash",
    content: vitestLogOutput,
    assertOutput: (output) => {
      expect(output).toContain("WARN retrying flaky fetch in src/components/view_99.test.ts");
      expect(output).toContain("vitest tail line 54");
    }
  },
  {
    name: "tsc log output",
    toolName: "Bash",
    content: tscLogOutput,
    assertOutput: (output) => {
      expect(output).toContain("src/router.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.");
      expect(output).toContain("12 const routeId: number = \"bad\";");
      expect(output).toContain("tsc tail line 54");
    }
  },
  {
    name: "package install log output",
    toolName: "Bash",
    content: packageInstallLogOutput,
    assertOutput: (output) => {
      expect(output).toContain("WARN deprecated left-pad@1.3.0: use String.prototype.padStart");
      expect(output).toContain("install tail line 54");
    }
  },
  {
    name: "generic shell log output",
    toolName: "Bash",
    content: genericShellLogOutput,
    assertOutput: (output) => {
      expect(output).toContain("Command exited with code 0");
      expect(output).toContain("generic tail line 54");
    }
  }
];

const diffOutputFixtures: CompressionFixture[] = [
  {
    name: "git generated code diff",
    toolName: "Bash",
    content: gitDiffOutput,
    assertOutput: (output) => {
      expect(output).toContain("[prompt-proxy.diff-compaction.v1;");
      expect(output).toContain("diff --git a/apps/proxy/src/generated.ts b/apps/proxy/src/generated.ts");
      expect(output).toContain("@@ -1,80 +1,141 @@");
      expect(output).toContain("[hunk stats: added=81; deleted=20]");
      expect(output).toContain("+console.error(\"failed route\");");
    }
  },
  {
    name: "package lock diff",
    toolName: "Bash",
    content: packageLockDiffOutput,
    assertOutput: (output) => {
      expect(output).toContain("diff --git a/package-lock.json b/package-lock.json");
      expect(output).toContain("[hunk stats: added=120; deleted=0]");
      expect(output).toContain("+    \"node_modules/generated-pkg-0\": \"2.0.0\",");
    }
  },
  {
    name: "generated GraphQL diff",
    toolName: "Bash",
    content: generatedFileDiffOutput,
    assertOutput: (output) => {
      expect(output).toContain("diff --git a/apps/web/src/gql/graphql.ts b/apps/web/src/gql/graphql.ts");
      expect(output).toContain("[hunk stats: added=150; deleted=0]");
      expect(output).toContain("+export type GeneratedQuery0 = { field0: string; nested0: number };");
    }
  }
];

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
    name: "GitHub MCP issues JSON",
    toolName: "mcp__github__search_issues",
    content: githubJson,
    expectedRule: "mcp-json-whitespace",
    assertOutput: (output) => expect(JSON.parse(output).issues).toHaveLength(60)
  },
  {
    name: "Linear MCP issues JSON",
    toolName: "mcp__linear__list_issues",
    content: linearJson,
    expectedRule: "mcp-json-whitespace",
    assertOutput: (output) => expect(JSON.parse(output).nodes).toHaveLength(60)
  },
  {
    name: "Slack MCP search JSON",
    toolName: "mcp__slack__search",
    content: slackJson,
    expectedRule: "mcp-json-whitespace",
    assertOutput: (output) => expect(JSON.parse(output).messages).toHaveLength(60)
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
    name: "grep output",
    toolName: "Bash",
    content: grepOutput,
    assertOutput: (output) => expect(output).toBe(grepOutput)
  },
  {
    name: "test output",
    toolName: "Bash",
    content: testOutput,
    expectedRule: "bash-output-noise",
    assertOutput: (output) => {
      expect(output).not.toContain(esc);
      expect(output).toContain("case passed");
    }
  },
  {
    name: "build output",
    toolName: "Bash",
    content: buildOutput,
    expectedRule: "bash-output-noise",
    assertOutput: (output) => {
      expect(output).not.toContain(esc);
      expect(output).toContain("100%");
      expect(output).toContain("chunk-79.js");
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

  it.each(jsonArrayFixtures)("records measure-only JSON array candidates for $name", (fixture) => {
    const result = runFixture(fixture, measureOnlyRules(), { measureOnly: true, recordSkips: true });

    expect(result.record).toMatchObject({
      rule: "json-array-compaction",
      status: "candidate"
    });
    expect(result.record?.savedEstimatedTokens).toBeGreaterThan(0);
    expect(expandJsonArrayCompaction(result.output)).toEqual(JSON.parse(fixture.content));
  });

  it.each([
    ["duplicate keys", `[\n${Array.from({ length: 60 }, (_, index) => `  { "id": "${index}", "id": "dup-${index}", "title": "unsafe ${index}" }`).join(",\n")}\n]`],
    ["decimal spelling", `[\n${Array.from({ length: 60 }, (_, index) => `  { "id": ${index}.0, "title": "unsafe ${index}" }`).join(",\n")}\n]`],
    ["very large cell", `[\n${Array.from({ length: 60 }, (_, index) => `  { "id": "${index}", "body": "${"x".repeat(2049)}" }`).join(",\n")}\n]`],
    ["nested object", `[\n${Array.from({ length: 60 }, (_, index) => `  { "id": "${index}", "meta": { "x": ${index} } }`).join(",\n")}\n]`],
    ["mixed primitive array", `[\n${Array.from({ length: 60 }, (_, index) => index === 10 ? `  "unsafe ${index}"` : `  { "id": "${index}", "title": "safe ${index}" }`).join(",\n")}\n]`]
  ])("falls through to JSON whitespace for unsafe %s payloads", (_name, content) => {
    const result = runFixture({
      name: _name,
      toolName: "mcp__github__search_issues",
      content,
      assertOutput: () => {}
    }, measureOnlyRules(), { measureOnly: true, recordSkips: true });

    expect(result.records).toHaveLength(1);
    expect(result.record).toMatchObject({
      rule: "mcp-json-whitespace",
      status: "candidate"
    });
    expect(result.output).not.toContain("prompt-proxy.json-array-compaction");
  });

  it.each(searchResultFixtures)("records measure-only search grouping candidates for $name", (fixture) => {
    const result = runFixture(fixture, measureOnlyRules(), { measureOnly: true, recordSkips: true });

    expect(result.record).toMatchObject({
      rule: "search-result-grouping",
      status: "candidate"
    });
    expect(result.record?.savedEstimatedTokens).toBeGreaterThan(0);
    fixture.assertOutput(result.output);
  });

  it.each(logOutputFixtures)("records measure-only log output candidates for $name", (fixture) => {
    const result = runFixture(fixture, measureOnlyRules(), { measureOnly: true, recordSkips: true });

    expect(result.record).toMatchObject({
      rule: "log-output-compaction",
      status: "candidate"
    });
    expect(result.record?.savedEstimatedTokens).toBeGreaterThan(0);
    fixture.assertOutput(result.output);
  });

  it.each(diffOutputFixtures)("records measure-only diff compaction candidates for $name", (fixture) => {
    const result = runFixture(fixture, measureOnlyRules(), { measureOnly: true, recordSkips: true });

    expect(result.record).toMatchObject({
      rule: "diff-compaction",
      status: "candidate"
    });
    expect(result.record?.savedEstimatedTokens).toBeGreaterThan(0);
    fixture.assertOutput(result.output);
  });

  it.each([
    ["conflict diff", conflictDiffOutput],
    ["malformed diff-like output", "diff --git without enough structure"]
  ])("skips unsafe %s without creating a diff candidate", (_name, content) => {
    const result = runFixture({
      name: _name,
      toolName: "Bash",
      content,
      assertOutput: () => {}
    }, measureOnlyRules(), { measureOnly: true, recordSkips: true });

    expect(result.output).toBe(content);
    expect(result.records.some((record) => record.rule === "diff-compaction" && record.status === "candidate")).toBe(false);
  });

  it.each([
    ["empty output", "Search", ""],
    ["no-match output", "Search", "No results found"],
    ["malformed output", "Search", Array.from({ length: 40 }, (_, index) => `result ${index} without path or line`).join("\n")],
    ["failed search command output", "Search", Array.from({ length: 40 }, (_, index) => `rg: missing-${index}: No such file or directory (os error 2)`).join("\n")]
  ])("skips %s without creating a search candidate", (_name, toolName, content) => {
    const result = runFixture({
      name: _name,
      toolName,
      content,
      assertOutput: () => {}
    }, measureOnlyRules(), { measureOnly: true, recordSkips: true });

    expect(result.output).toBe(content);
    expect(result.records.some((record) => record.rule === "search-result-grouping" && record.status === "candidate")).toBe(false);
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
      { name: "GitHub MCP issues JSON", rule: "mcp-json-whitespace" },
      { name: "Linear MCP issues JSON", rule: "mcp-json-whitespace" },
      { name: "Slack MCP search JSON", rule: "mcp-json-whitespace" },
      { name: "CSV table", rule: null },
      { name: "TSV table", rule: null },
      { name: "shell log", rule: "bash-output-noise" },
      { name: "grep output", rule: null },
      { name: "test output", rule: "bash-output-noise" },
      { name: "build output", rule: "bash-output-noise" },
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

  it("ranks candidate rules by median and p95 token savings", () => {
    const rows = benchmarkCompressionFixtures(fixtures, compressionRules);

    expect(rows.map((row) => row.rule).sort()).toEqual(["bash-output-noise", "json-whitespace", "mcp-json-whitespace"]);
    expect(rows[0].medianSavedTokens).toBeGreaterThanOrEqual(rows[1].medianSavedTokens);
    expect(rows[1].medianSavedTokens).toBeGreaterThanOrEqual(rows[2].medianSavedTokens);
    for (const row of rows) {
      expect(row.samples).toBeGreaterThan(0);
      expect(row.medianSavedTokens).toBeGreaterThan(0);
      expect(row.p95SavedTokens).toBeGreaterThanOrEqual(row.medianSavedTokens);
      expect(row.totalSavedTokens).toBeGreaterThanOrEqual(row.medianSavedTokens);
    }
  });
});

function measureOnlyRules() {
  return compressionRulesForPolicy({
    ...defaultCompressionPolicy(),
    mode: "measure_only",
    enabledRules: undefined
  });
}

function runFixture(
  fixture: CompressionFixture,
  rules: CompressionRule[] = compressionRules,
  options: CompressionOptions = {}
) {
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: fixture.toolName, input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: fixture.content }] }
    ]
  };
  const result = compressToolResults("anthropic-messages", body, rules, options) as {
    body: { messages: Array<{ content: Array<{ content: string }> }> };
    transformedBody?: { messages: Array<{ content: Array<{ content: string }> }> };
    records: CompressionRecord[];
  };
  const outputBody = result.transformedBody ?? result.body;
  return {
    output: outputBody.messages[1].content[0].content,
    record: result.records[0],
    records: result.records
  };
}
