import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { compressionReceipts, events as eventTable, promptArtifacts } from "@prompt-proxy/db";
import { defaultCompressionPolicy, type CompressionPolicy } from "@prompt-proxy/schema";

import { EventService } from "../src/events.js";
import { claudeCodeHarness, codexHarness, cursorHarness, opencodeHarness } from "../src/harness.js";
import {
  appendCompressionEvidence,
  availableCompressionRules,
  compressOrFallback,
  compressForForward,
  compressForForwardWithResult,
  compressToolResults,
  MIN_COMPRESSIBLE_CHARS,
  ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE,
  compressionRules,
  compressionRulesForProfile,
  type CompressionRule,
  type CompressionTokenEstimator
} from "../src/toolResultCompression.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

// A trivial deterministic rule for scaffold testing: truncate to a marker.
const truncateRule: CompressionRule = {
  label: "test-truncate",
  version: 1,
  matches: (name) => name === "Bash",
  filter: ({ content }) => (typeof content === "string" ? `${content.slice(0, 10)}…[truncated]` : undefined)
};

const big = "x".repeat(MIN_COMPRESSIBLE_CHARS + 100);
const duplicateBig = "d".repeat(MIN_COMPRESSIBLE_CHARS + 100);
const truncatedBig = "xxxxxxxxxx…[truncated]";
const estimatedTokens = (chars: number) => Math.ceil(chars / 4);
const esc = String.fromCharCode(27);
const hashFor = (value: string) => createHash("sha256").update(value).digest("hex");
const contentHashFor = (value: string) => `sha256:${hashFor(value)}`;
const byteLengthFor = (value: string) => Buffer.byteLength(value);
const compressionPolicy = (mode: CompressionPolicy["mode"] = "compress_lossless"): CompressionPolicy => ({
  ...defaultCompressionPolicy(),
  mode
});
const testCompressionPolicy = (mode: CompressionPolicy["mode"] = "compress_lossless"): CompressionPolicy => ({
  ...compressionPolicy(mode),
  enabledRules: undefined
});
const pytestOutput = () => [
  ...Array.from({ length: 300 }, (_, index) => `progress line ${index}`),
  "FAILED tests/test_router.py::test_routes",
  "tests/test_router.py:42: AssertionError",
  "Traceback (most recent call last):",
  "  File \"tests/test_router.py\", line 42, in test_routes",
  "AssertionError: expected hard route",
  ...Array.from({ length: 20 }, (_, index) => `tail line ${index}`)
].join("\n");

describe("compressToolResults", () => {
  it("builds shell compression rules from the harness profile", () => {
    const codexRules = compressionRulesForProfile(codexHarness);
    const claudeRules = compressionRulesForProfile(claudeCodeHarness);
    const cursorRules = compressionRulesForProfile(cursorHarness);
    const opencodeRules = compressionRulesForProfile(opencodeHarness);

    expect(codexRules.some((rule) => rule.matches("shell"))).toBe(true);
    expect(codexRules.some((rule) => rule.matches("Bash"))).toBe(false);
    expect(claudeRules.some((rule) => rule.matches("Bash"))).toBe(true);
    expect(claudeRules.some((rule) => rule.matches("local_shell"))).toBe(false);
    expect(cursorRules.some((rule) => rule.matches("run_terminal_cmd"))).toBe(true);
    expect(opencodeRules.some((rule) => rule.matches("shell"))).toBe(true);
  });

  it("exposes metadata for the available compression rules", () => {
    expect(availableCompressionRules()).toEqual([
      expect.objectContaining({
        id: "mcp-json-whitespace",
        displayName: "MCP JSON whitespace compaction",
        version: 1,
        classification: "lossless",
        supportedSurfaces: ["openai-responses", "anthropic-messages", "openai-chat"],
        eligibleToolNames: ["mcp__*"],
        minOriginalBytes: 512,
        minSavingsTokens: 0,
        knownRisks: []
      }),
      expect.objectContaining({ id: "json-whitespace", classification: "lossless" }),
      expect.objectContaining({
        id: "bash-output-noise",
        eligibleToolNames: ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"]
      }),
      expect.objectContaining({
        id: "shell-command-lossy-summary",
        classification: "lossy",
        minOriginalBytes: 4096
      })
    ]);
    expect(availableCompressionRules(codexHarness).find((rule) => rule.id === "bash-output-noise"))
      .toMatchObject({ eligibleToolNames: codexHarness.bashToolNames });
    expect(availableCompressionRules(codexHarness).find((rule) => rule.id === "shell-command-lossy-summary"))
      .toMatchObject({ eligibleToolNames: codexHarness.bashToolNames });
  });

  it("does not evaluate disabled rules", () => {
    const verbose = JSON.stringify({ items: Array.from({ length: 80 }, (_, id) => ({ id, value: `row ${id}` })) }, null, 2);
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
      ]
    };

    const result = compressOrFallback(
      "anthropic-messages",
      body,
      { ...compressionPolicy(), enabledRules: ["bash-output-noise"] },
      () => {}
    ) as any;

    expect(result.records).toEqual([]);
    expect(result.body).toBe(body);
  });

  it("gates lossy shell summaries by policy mode", () => {
    const output = pytestOutput();
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest -q" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: output }] }
      ]
    };
    const lossless = compressOrFallback("anthropic-messages", body, compressionPolicy(), () => {}) as any;
    const measured = compressOrFallback("anthropic-messages", body, compressionPolicy("measure_only"), () => {}) as any;
    const lossy = compressOrFallback("anthropic-messages", body, compressionPolicy("compress_explicit_lossy"), () => {}) as any;

    expect(lossless.records).toEqual([]);
    expect(lossless.body).toBe(body);
    expect(measured.body).toBe(body);
    expect(measured.records[0]).toMatchObject({
      rule: "shell-command-lossy-summary",
      status: "candidate",
      command: "pytest -q",
      commandClass: "test_output"
    });
    expect(lossy.records[0]).toMatchObject({
      rule: "shell-command-lossy-summary",
      status: "applied",
      commandClass: "test_output"
    });
    expect(lossy.body.messages[1].content[0].content).toContain("FAILED tests/test_router.py::test_routes");
    expect(lossy.body.messages[1].content[0].content).not.toContain("progress line 0");
  });

  it("leaves non-matching tools untouched under the default registry", () => {
    // Plain Bash output has no noise for the default Bash filter to strip, so
    // its content is preserved verbatim.
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body) as any;
    expect(result.records).toEqual([]);
    expect(result.body.messages[1].content[0].content).toBe(big);
  });

  it("compresses a verbose mcp__* result under the default registry", () => {
    const verbose = JSON.stringify({ items: Array.from({ length: 80 }, (_, i) => ({ id: i, note: null })) }, null, 2);
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body) as any;
    expect(result.records).toHaveLength(1);
    expect(result.records[0].tool).toBe("mcp__linear__list");
    expect(result.records[0].rule).toBe("mcp-json-whitespace");
    expect(result.body.messages[1].content[0].content.length).toBeLessThan(verbose.length);
  });

  it("compacts large JSON output from shell tools without normalizing numeric spellings", () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      `    { "id": "${index}", "note": "value ${index}" }`
    ).join(",\n");
    const verbose = `{
  "issue_id": 7234567890123456789,
  "x": 1.0,
  "z": 1,
  "z": 2,
  "items": [
${items}
  ]
}`;
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat data.json" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body) as any;
    const compacted = result.body.messages[1].content[0].content as string;
    expect(result.records[0].rule).toBe("json-whitespace");
    expect(compacted).not.toContain("\n");
    expect(compacted).toContain('"issue_id":7234567890123456789');
    expect(compacted).toContain('"x":1.0');
    expect(compacted).toContain('"z":1,"z":2');
    expect(JSON.parse(compacted).items).toHaveLength(40);
  });

  it("compacts JSON inside Anthropic text blocks from custom tools", () => {
    const verbose = JSON.stringify({ rows: Array.from({ length: 80 }, (_, id) => ({ id, value: `row ${id}` })) }, null, 2);
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "CustomJsonTool", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: verbose }] }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body) as any;
    const compacted = result.body.messages[1].content[0].content[0].text as string;
    expect(result.records[0].rule).toBe("json-whitespace");
    expect(compacted).toBe(JSON.stringify(JSON.parse(verbose)));
  });

  it("leaves invalid JSON output from custom tools untouched", () => {
    const invalid = `{\n  "items": [\n${"    1,\n".repeat(200)}`;
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "CustomJsonTool", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: invalid }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body) as any;
    expect(result.records).toEqual([]);
    expect(result.body.messages[1].content[0].content).toBe(invalid);
  });

  it("leaves non-JSON output from custom tools untouched", () => {
    const output = "plain log line\n".repeat(200);
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "CustomTool", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: output }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body) as any;
    expect(result.records).toEqual([]);
    expect(result.body.messages[1].content[0].content).toBe(output);
  });

  it("falls through to shell-output cleanup when generic JSON compaction declines", () => {
    const noisy = `${esc}[32m${"ok line\n".repeat(100)}${esc}[0m`;
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: noisy }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body) as any;
    expect(result.records[0].rule).toBe("bash-output-noise");
    expect(result.body.messages[1].content[0].content).not.toContain(esc);
  });

  it("maps tool_use_id to tool name and applies a matching rule (Anthropic)", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest" } },
            { type: "tool_use", id: "t2", name: "Read", input: { path: "a.ts" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: big },
            { type: "tool_result", tool_use_id: "t2", content: big }
          ]
        }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [truncateRule]) as any;

    // Only the Bash result is compressed; Read does not match the rule.
    expect(result.records).toEqual([
      {
        tool: "Bash",
        rule: "test-truncate",
        ruleVersion: 1,
        blockPath: "messages.1.content.0",
        status: "applied",
        originalContentHash: contentHashFor(big),
        compressedContentHash: contentHashFor(truncatedBig),
        beforeBytes: byteLengthFor(big),
        afterBytes: byteLengthFor(truncatedBig),
        beforeChars: big.length,
        afterChars: truncatedBig.length,
        beforeEstimatedTokens: estimatedTokens(big.length),
        afterEstimatedTokens: estimatedTokens(truncatedBig.length),
        savedEstimatedTokens: estimatedTokens(big.length) - estimatedTokens(truncatedBig.length),
        originalTokenEstimate: estimatedTokens(big.length),
        compressedTokenEstimate: estimatedTokens(truncatedBig.length),
        savedTokens: estimatedTokens(big.length) - estimatedTokens(truncatedBig.length),
        estimateSource: ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE
      }
    ]);
    expect(result.body.messages[1].content[0].content).toBe(truncatedBig);
    expect(result.body.messages[1].content[1].content).toBe(big);
    // Original body is not mutated (rewritten spines are rebuilt, not aliased).
    expect((body.messages[1].content[0] as any).content).toBe(big);
  });

  it("handles tool_result content as an array of blocks", () => {
    const bigArray = [{ type: "text", text: "y".repeat(MIN_COMPRESSIBLE_CHARS + 50) }];
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bigArray }] }
      ]
    };
    const arrayRule: CompressionRule = {
      label: "array-rule",
      version: 1,
      matches: (name) => name === "Bash",
      filter: () => "compacted"
    };
    const result = compressToolResults("anthropic-messages", body, [arrayRule]) as any;
    expect(result.records).toHaveLength(1);
    expect(result.body.messages[1].content[0].content).toBe("compacted");
  });

  it("falls back to the unknown tool name when the assistant tool_use turn is missing", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: big }] }
      ]
    };
    const seen: string[] = [];
    const recordingRule: CompressionRule = {
      label: "record",
      version: 1,
      matches: (name) => { seen.push(name); return false; },
      filter: () => undefined
    };
    compressToolResults("anthropic-messages", body, [recordingRule]);
    expect(seen).toEqual(["unknown"]);
  });

  it("uses last-write-wins for a reused tool_use_id", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "dup", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "dup", content: "first" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "dup", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "dup", content: big }] }
      ]
    };
    const seen: string[] = [];
    const recordingRule: CompressionRule = {
      label: "record",
      version: 1,
      matches: (name) => { seen.push(name); return false; },
      filter: () => undefined
    };
    compressToolResults("anthropic-messages", body, [recordingRule]);
    // The id→name map is built upfront with last-write-wins, so both results
    // resolve to the latest tool_use registration (Read).
    expect(seen).toEqual(["Read", "Read"]);
  });

  it("skips results below the size threshold", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "small" }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body, [truncateRule]);
    expect(result.records).toEqual([]);
  });

  it("maps call_id to function name and applies a rule (OpenAI)", () => {
    const body = {
      input: [
        { type: "function_call", call_id: "c1", name: "Bash", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: big }
      ]
    };
    const result = compressToolResults("openai-responses", body, [truncateRule]) as any;
    expect(result.records[0].tool).toBe("Bash");
    expect(result.body.input[1].output).toBe("xxxxxxxxxx…[truncated]");
  });

  it("elides duplicate large OpenAI function outputs that no rule rewrites", () => {
    const body = {
      input: [
        { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: duplicateBig },
        { type: "function_call", call_id: "c2", name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: "c2", output: duplicateBig }
      ]
    };

    const result = compressToolResults("openai-responses", body, [], { deduplicateToolResults: true }) as any;

    expect(result.records).toEqual([
      expect.objectContaining({
        tool: "read_file",
        rule: "duplicate-tool-result-reference",
        ruleVersion: 1,
        beforeChars: duplicateBig.length
      })
    ]);
    expect(result.body.input[1].output).toBe(duplicateBig);
    expect(result.body.input[3].output).toContain("duplicate tool result omitted");
    expect(result.body.input[3].output).toContain(`contentHash=sha256:${hashFor(duplicateBig)}`);
    expect(result.body.input[3].output).not.toContain(duplicateBig.slice(0, 50));
  });

  it("maps flat chat tool calls to tool names", () => {
    const rule: CompressionRule = {
      label: "cursor-truncate",
      version: 1,
      matches: (name) => name === "run_terminal_cmd",
      filter: ({ content }) => (typeof content === "string" ? `${content.slice(0, 10)}…[truncated]` : undefined)
    };
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", name: "run_terminal_cmd", arguments: { command: "pwd" } }]
        },
        { role: "tool", tool_call_id: "call_1", content: big }
      ]
    };

    const result = compressToolResults("openai-chat", body, [rule]) as any;

    expect(result.records).toEqual([
      {
        tool: "run_terminal_cmd",
        rule: "cursor-truncate",
        ruleVersion: 1,
        blockPath: "messages.1",
        status: "applied",
        originalContentHash: contentHashFor(big),
        compressedContentHash: contentHashFor(truncatedBig),
        beforeBytes: byteLengthFor(big),
        afterBytes: byteLengthFor(truncatedBig),
        beforeChars: big.length,
        afterChars: truncatedBig.length,
        beforeEstimatedTokens: estimatedTokens(big.length),
        afterEstimatedTokens: estimatedTokens(truncatedBig.length),
        savedEstimatedTokens: estimatedTokens(big.length) - estimatedTokens(truncatedBig.length),
        originalTokenEstimate: estimatedTokens(big.length),
        compressedTokenEstimate: estimatedTokens(truncatedBig.length),
        savedTokens: estimatedTokens(big.length) - estimatedTokens(truncatedBig.length),
        estimateSource: ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE
      }
    ]);
    expect(result.body.messages[1].content).toBe("xxxxxxxxxx…[truncated]");
  });

  it("never grows a block: a rule that expands content is discarded", () => {
    const expandRule: CompressionRule = {
      label: "expand",
      version: 1,
      matches: () => true,
      filter: ({ content }) => `${String(content)}-and-then-some-more-and-more`
    };
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body, [expandRule]) as any;
    expect(result.records).toEqual([]);
    expect(result.body.messages[1].content[0].content).toBe(big);
  });

  it("is deterministic: identical input yields identical output bytes", () => {
    const make = () => ({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }
      ]
    });
    const a = compressToolResults("anthropic-messages", make(), [truncateRule]);
    const b = compressToolResults("anthropic-messages", make(), [truncateRule]);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });

  it("replaces later exact duplicate tool results with a deterministic reference when enabled", () => {
    const duplicate = "file line\n".repeat(400);
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: duplicate }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: duplicate }] }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [], { deduplicateToolResults: true }) as any;
    const first = result.body.messages[1].content[0].content;
    const second = result.body.messages[3].content[0].content;

    expect(first).toBe(duplicate);
    expect(second).toContain(`contentHash=sha256:${hashFor(duplicate)}`);
    expect(second).toContain(`originalChars=${duplicate.length}`);
    expect(second).not.toContain(duplicate.slice(0, 40));
    expect(result.records).toEqual([
      {
        tool: "Read",
        rule: "duplicate-tool-result-reference",
        ruleVersion: 1,
        blockPath: "messages.3.content.0",
        status: "applied",
        originalContentHash: contentHashFor(duplicate),
        compressedContentHash: contentHashFor(second),
        beforeBytes: byteLengthFor(duplicate),
        afterBytes: byteLengthFor(second),
        beforeChars: duplicate.length,
        afterChars: second.length,
        beforeEstimatedTokens: estimatedTokens(duplicate.length),
        afterEstimatedTokens: estimatedTokens(second.length),
        savedEstimatedTokens: estimatedTokens(duplicate.length) - estimatedTokens(second.length),
        originalTokenEstimate: estimatedTokens(duplicate.length),
        compressedTokenEstimate: estimatedTokens(second.length),
        savedTokens: estimatedTokens(duplicate.length) - estimatedTokens(second.length),
        estimateSource: ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE
      }
    ]);
  });

  it("does not replace a duplicate when the earlier content is not in forwarded context", () => {
    const duplicate = "file line\n".repeat(400);
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: duplicate }] }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [], { deduplicateToolResults: true }) as any;

    expect(result.body.messages[1].content[0].content).toBe(duplicate);
    expect(result.records).toEqual([]);
  });

  it("leaves near-duplicate tool results untouched", () => {
    const first = "file line\n".repeat(400);
    const second = `${"file line\n".repeat(399)}different line\n`;
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: first }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: second }] }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [], { deduplicateToolResults: true }) as any;

    expect(result.body.messages[1].content[0].content).toBe(first);
    expect(result.body.messages[3].content[0].content).toBe(second);
    expect(result.records).toEqual([]);
  });

  it("does not reference content whose earlier occurrence was rewritten by another rule", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: big }] }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [truncateRule], { deduplicateToolResults: true }) as any;

    expect(result.body.messages[1].content[0].content).toBe(truncatedBig);
    expect(result.body.messages[3].content[0].content).toBe(truncatedBig);
    expect(result.records.map((record: any) => record.rule)).toEqual(["test-truncate", "test-truncate"]);
  });

  it("records byte counts separately from character counts", () => {
    const unicode = "é".repeat(MIN_COMPRESSIBLE_CHARS + 100);
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: unicode }] }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [truncateRule]) as any;

    expect(result.records[0]).toMatchObject({
      beforeChars: unicode.length,
      beforeBytes: byteLengthFor(unicode),
      originalContentHash: contentHashFor(unicode)
    });
    expect(result.records[0].beforeBytes).toBeGreaterThan(result.records[0].beforeChars);
  });

  it("uses bytes for the minimum original size threshold", () => {
    const unicode = "é".repeat(1_100);
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: unicode }] }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [truncateRule]) as any;

    expect(unicode.length).toBeLessThan(MIN_COMPRESSIBLE_CHARS);
    expect(byteLengthFor(unicode)).toBeGreaterThan(MIN_COMPRESSIBLE_CHARS);
    expect(result.records[0]).toMatchObject({
      rule: "test-truncate",
      beforeChars: unicode.length,
      beforeBytes: byteLengthFor(unicode)
    });
  });

  it("skips character-shrinking rewrites that grow exact token counts", () => {
    const compact = "compact".repeat(400);
    const tokenHeavy = Array.from({ length: 200 }, () => "x").join(" ");
    const tokenGrowthRule: CompressionRule = {
      label: "token-growth",
      version: 1,
      matches: () => true,
      filter: () => tokenHeavy
    };
    const tokenEstimator: CompressionTokenEstimator = {
      estimateSource: "exact:test-whitespace",
      countTokens: (content) => typeof content === "string"
        ? content.split(/\s+/).filter(Boolean).length
        : undefined
    };
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: compact }] }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [tokenGrowthRule], {
      measureOnly: true,
      recordSkips: true,
      tokenEstimator
    }) as any;

    expect(result.body).toBe(body);
    expect(result.records[0]).toMatchObject({
      rule: "token-growth",
      status: "skipped",
      skipReason: "below_min_savings",
      beforeChars: compact.length,
      afterChars: tokenHeavy.length,
      originalTokenEstimate: 1,
      compressedTokenEstimate: 200,
      savedTokens: -199,
      estimateSource: "exact:test-whitespace"
    });
  });

  it("skips duplicate references that grow exact token counts", () => {
    const compact = "compact".repeat(400);
    const tokenEstimator: CompressionTokenEstimator = {
      estimateSource: "exact:test-whitespace",
      countTokens: (content) => typeof content === "string"
        ? content.split(/\s+/).filter(Boolean).length
        : undefined
    };
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: compact }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: compact }] }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [], {
      deduplicateToolResults: true,
      measureOnly: true,
      recordSkips: true,
      tokenEstimator
    }) as any;

    expect(result.body).toBe(body);
    const duplicateRecord = result.records.find((record: any) => record.rule === "duplicate-tool-result-reference");
    expect(duplicateRecord).toMatchObject({
      rule: "duplicate-tool-result-reference",
      status: "skipped",
      skipReason: "below_min_savings",
      originalTokenEstimate: 1,
      estimateSource: "exact:test-whitespace"
    });
    expect(duplicateRecord.compressedTokenEstimate).toBeGreaterThan(1);
  });
});

describe("compressForForward", () => {
  // Uses a tool name no real registered rule matches, so the pushed stub rule
  // is the only matcher regardless of registration order.
  function body() {
    return {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "StubTool", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }
      ]
    };
  }

  const forwardInput = (events: EventService, overrides: Record<string, unknown> = {}) => ({
    events,
    tenantId: "org_1",
    workspaceId: "org_1:workspace:default",
    requestId: "request_1",
    idempotencyKey: "idem_1",
    sessionId: "session_1",
    surface: "anthropic-messages" as const,
    body: body(),
    policy: testCompressionPolicy(),
    warn: () => {},
    ...overrides
  });

  it("emits no event and returns the body unchanged when the org has not opted in", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_1");
    const original = body();
    const result = await compressForForward(forwardInput(events, { body: original, policy: compressionPolicy("disabled") }));
    expect(result).toBe(original);
    expect(events.listEvents()).toHaveLength(0);
  });

  it("records measure-only candidates without changing the forwarded body", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_1");
    const original = body();
    compressionRules.push(truncateForward);
    try {
      const result = await compressForForward(forwardInput(events, {
        body: original,
        policy: testCompressionPolicy("measure_only")
      })) as any;
      expect(result).toBe(original);
      expect(result.messages[1].content[0].content).toBe(big);
      const eventRows = events.listEvents();
      expect(eventRows.some((event) => event.eventType === "compression.recorded")).toBe(false);
      const candidate = eventRows.find((event) => event.eventType === "compression.candidate_recorded");
      const aggregate = eventRows.find((event) => event.eventType === "compression.measurement_recorded");
      const record = (candidate?.payload as any)?.record;
      expect(record).toMatchObject({
        tool: "StubTool",
        rule: "forward-truncate",
        ruleVersion: 1,
        blockPath: "messages.1.content.0",
        status: "candidate",
        beforeChars: big.length,
        afterChars: truncatedBig.length
      });
      expect((aggregate?.payload as any)?.candidates).toBe(1);
      expect((aggregate?.payload as any)?.skipped).toBe(0);
      expect(JSON.stringify(candidate?.payload)).not.toContain(big.slice(0, 50));
      expect(JSON.stringify(aggregate?.payload)).not.toContain(big.slice(0, 50));
    } finally {
      compressionRules.pop();
    }
  });

  it("records measure-only skip reasons without tool-result text", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_1");
    await compressForForward(forwardInput(events, {
      policy: { ...compressionPolicy("measure_only"), enabledRules: [] }
    }));
    const candidate = events.listEvents().find((event) => event.eventType === "compression.candidate_recorded");
    const record = (candidate?.payload as any)?.record;
    expect(record).toMatchObject({
      tool: "StubTool",
      rule: "none",
      ruleVersion: 0,
      blockPath: "messages.1.content.0",
      status: "skipped",
      skipReason: "no_matching_rule"
    });
    expect(JSON.stringify(candidate?.payload)).not.toContain(big.slice(0, 50));
  });

  it("returns the compressed body even when the event append fails", async () => {
    const failingSink = { append: async () => { throw new Error("sink down"); } };
    const events = new EventService(undefined, undefined, failingSink, "org_1");
    compressionRules.push(truncateForward);
    try {
      const result = await compressForForward(forwardInput(events)) as any;
      // Compression applied despite the event sink throwing.
      expect(result.messages[1].content[0].content).toContain("[truncated]");
    } finally {
      compressionRules.pop();
    }
  });

  it("emits a compression.recorded event carrying only sizes, never tool content", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_1");
    compressionRules.push(truncateForward);
    try {
      await compressForForward(forwardInput(events));
      const recorded = events.listEvents().find((event) => event.eventType === "compression.recorded");
      expect(recorded).toBeTruthy();
      expect(recorded?.redactionState).toBe("not_applicable");
      const payload = recorded?.payload as Record<string, unknown>;
      expect(payload.blocks).toBe(1);
      expect(payload.savedChars).toBeGreaterThan(0);
      expect(payload.beforeEstimatedTokens).toBe(estimatedTokens(big.length));
      expect(payload.afterEstimatedTokens).toBe(estimatedTokens(truncatedBig.length));
      expect(payload.savedEstimatedTokens).toBe(estimatedTokens(big.length) - estimatedTokens(truncatedBig.length));
      expect(payload.beforeBytes).toBe(byteLengthFor(big));
      expect(payload.afterBytes).toBe(byteLengthFor(truncatedBig));
      expect(payload.savedBytes).toBe(byteLengthFor(big) - byteLengthFor(truncatedBig));
      // The serialized payload must not leak the raw tool output.
      expect(JSON.stringify(payload)).not.toContain(big.slice(0, 50));
      const byRule = payload.byRule as Record<string, unknown>[];
      expect(Object.keys(byRule[0]).sort()).toEqual([
        "afterBytes",
        "afterChars",
        "afterEstimatedTokens",
        "beforeBytes",
        "beforeChars",
        "beforeEstimatedTokens",
        "blockPath",
        "compressedContentHash",
        "compressedTokenEstimate",
        "estimateSource",
        "originalContentHash",
        "originalTokenEstimate",
        "rule",
        "ruleVersion",
        "savedEstimatedTokens",
        "savedTokens",
        "status",
        "tool"
      ]);
    } finally {
      compressionRules.pop();
    }
  });

  it("records compression failures as evidence without changing the forwarded body", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_1");
    const original = body();
    const throwingRule: CompressionRule = {
      label: "throw-forward",
      version: 1,
      matches: (name) => name === "StubTool",
      filter: () => { throw new Error("boom"); }
    };
    compressionRules.push(throwingRule);
    try {
      const result = await compressForForwardWithResult(forwardInput(events, { body: original }));
      expect(result.body).toBe(original);
      expect(result.compressionFailed).toBe(true);
      await appendCompressionEvidence({
        events,
        tenantId: "org_1",
        workspaceId: "org_1:workspace:default",
        requestId: "request_1",
        idempotencyKey: "idem_1",
        sessionId: "session_1",
        surface: "anthropic-messages",
        policy: testCompressionPolicy(),
        originalBody: original,
        compressedBody: result.body,
        forwardedBody: result.body,
        result,
        warn: () => {}
      });
      const evidence = events.listEvents().find((event) => event.eventType === "routing.compression_evidence_recorded");
      expect(evidence?.payload).toMatchObject({
        mode: "compress_lossless",
        evaluatedBlocks: 0,
        appliedBlocks: 0,
        skippedBlocks: 0,
        providerWouldReceiveCompressedToolOutput: false,
        forwardedToolOutputState: "original",
        compressionFailure: "tool_result_compression_failed"
      });
      expect(JSON.stringify(evidence?.payload)).not.toContain(big.slice(0, 50));
    } finally {
      compressionRules.pop();
    }
  });
});

const truncateForward: CompressionRule = {
  label: "forward-truncate",
  version: 1,
  matches: (name) => name === "StubTool",
  filter: ({ content }) => (typeof content === "string" ? `${content.slice(0, 10)}…[truncated]` : undefined)
};

describe("toolResultCompression end to end (DB-backed)", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  // Pretty-printed MCP-style JSON well above MIN_COMPRESSIBLE_CHARS.
  const verbose = JSON.stringify(
    { items: Array.from({ length: 120 }, (_, i) => ({ id: i, note: null })) },
    null,
    2
  );
  const compactedVerbose = JSON.stringify(JSON.parse(verbose));

  it("rewrites oversized mcp__ tool results in the forwarded Anthropic body when the org flag is on", async () => {
    fixture = await captureFixture("org_compress_http");
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy("org_compress_http", compressionPolicy());

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        messages: [
          { role: "user", content: "list the open issues" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    const forwarded = providerCall?.body.messages[2].content[0].content;
    const persistedEvents = await fixture.db.select().from(eventTable);
    const decision = persistedEvents.find((event) => event.eventType === "routing.decision_recorded");
    const recorded = persistedEvents.find((event) => event.eventType === "compression.recorded");
    const evidence = persistedEvents.find((event) => event.eventType === "routing.compression_evidence_recorded");
    const providerStarted = persistedEvents.find((event) => event.eventType === "provider.request_started");
    const providerForwarded = persistedEvents.find((event) => event.eventType === "provider.request_forwarded");
    const providerTerminal = persistedEvents.find((event) => event.eventType === "provider.response_completed");
    const persistedReceipts = await fixture.db.select().from(compressionReceipts);
    expect(typeof forwarded).toBe("string");
    expect(forwarded.length).toBeLessThan(verbose.length);
    expect(decision?.payload.compressionPolicy).toEqual(expect.objectContaining({
      mode: "compress_lossless",
      enabledRules: ["mcp-json-whitespace", "json-whitespace", "bash-output-noise", "shell-command-lossy-summary"]
    }));
    expect(evidence?.payload).toMatchObject({
      mode: "compress_lossless",
      evaluatedBlocks: 1,
      appliedBlocks: 1,
      candidateBlocks: 0,
      skippedBlocks: 0,
      ruleIds: ["mcp-json-whitespace"],
      receiptIds: [`${recorded?.id}:compression:0`],
      compressionEventId: recorded?.id,
      providerWouldReceiveCompressedToolOutput: true,
      forwardedToolOutputState: "some_compressed"
    });
    expect(evidence?.payload.originalRequestHash).not.toBe(evidence?.payload.compressedRequestHash);
    expect(providerStarted?.payload.preparedRequestHash).toBe(evidence?.payload.forwardedRequestHash);
    expect(providerForwarded?.payload).toMatchObject({
      preparedRequestHash: evidence?.payload.forwardedRequestHash,
      forwardedRequestHash: evidence?.payload.forwardedRequestHash,
      providerWouldReceiveCompressedToolOutput: true,
      providerToolOutputState: "some_compressed"
    });
    expect(providerTerminal?.payload).toMatchObject({
      providerRequestConfirmed: true,
      providerSawCompressedToolOutput: true,
      providerToolOutputState: "some_compressed"
    });
    expect(JSON.stringify(evidence?.payload)).not.toContain(verbose.slice(0, 50));
    expect(persistedReceipts).toHaveLength(1);
    expect(persistedReceipts[0]).toMatchObject({
      organizationId: "org_compress_http",
      workspaceId: "org_compress_http:workspace:default",
      mode: "compress_lossless",
      surface: "anthropic-messages",
      blockPath: "messages.2.content.0",
      toolName: "mcp__linear__list_issues",
      ruleId: "mcp-json-whitespace",
      ruleVersion: 1,
      status: "applied",
      originalBytes: byteLengthFor(verbose),
      compressedBytes: byteLengthFor(forwarded),
      originalEstimatedTokens: estimatedTokens(verbose.length),
      compressedEstimatedTokens: estimatedTokens(forwarded.length),
      savedEstimatedTokens: estimatedTokens(verbose.length) - estimatedTokens(forwarded.length),
      estimateSource: ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE,
      originalSha256: contentHashFor(verbose),
      compressedSha256: contentHashFor(forwarded),
      originalArtifactId: null,
      compressedArtifactId: null,
      skipReason: null,
      eventId: recorded?.id
    });
    const detail = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query ReceiptDetail($requestId: ID!) {
        request(requestId: $requestId) {
          compressionReceipts {
            mode
            surface
            blockPath
            toolName
            ruleId
            ruleVersion
            status
            originalSha256
            compressedSha256
            estimateSource
            originalArtifactId
            compressedArtifactId
            skipReason
          }
          events {
            eventType
            payload
          }
        }
      }`,
      { requestId: persistedReceipts[0].requestId }
    );
    expect(detail.errors).toBeUndefined();
    const detailEvents = detail.data?.request?.events ?? [];
    const detailEvidence = detailEvents.find((event: any) => event.eventType === "routing.compression_evidence_recorded");
    const detailProviderForwarded = detailEvents.find((event: any) => event.eventType === "provider.request_forwarded");
    const detailProviderTerminal = detailEvents.find((event: any) => event.eventType === "provider.response_completed");
    expect(detailEvidence?.payload).toMatchObject({
      compressionEventId: recorded?.id,
      receiptIds: [`${recorded?.id}:compression:0`],
      providerWouldReceiveCompressedToolOutput: true
    });
    expect(detailProviderForwarded?.payload.preparedRequestHash).toBe(detailEvidence?.payload.forwardedRequestHash);
    expect(detailProviderTerminal?.payload.providerSawCompressedToolOutput).toBe(true);
    expect(detail.data?.request?.compressionReceipts).toEqual([
      expect.objectContaining({
        mode: "compress_lossless",
        surface: "anthropic-messages",
        blockPath: "messages.2.content.0",
        toolName: "mcp__linear__list_issues",
        ruleId: "mcp-json-whitespace",
        ruleVersion: 1,
        status: "applied",
        originalSha256: contentHashFor(verbose),
        compressedSha256: contentHashFor(forwarded),
        estimateSource: ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE,
        originalArtifactId: null,
        compressedArtifactId: null,
        skipReason: null
      })
    ]);
    // Lossless: only formatting whitespace is gone.
    expect(JSON.parse(forwarded)).toEqual(JSON.parse(verbose));
  });

  it("rejects unknown compression rule ids before storing the policy", async () => {
    fixture = await captureFixture("org_compress_invalid_rule");
    await expect(fixture.persistence.organizationSettings.setToolResultCompressionPolicy(
      "org_compress_invalid_rule",
      { ...compressionPolicy(), enabledRules: ["unknown-rule"] }
    )).rejects.toThrow();
    await expect(fixture.persistence.organizationSettings.editable("org_compress_invalid_rule"))
      .resolves.toMatchObject({ toolResultCompressionPolicy: { mode: "disabled" } });
  });

  it("leaves the forwarded body untouched when the org has not opted in", async () => {
    fixture = await captureFixture("org_compress_off");

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        messages: [
          { role: "user", content: "list the open issues" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    expect(providerCall?.body.messages[2].content[0].content).toBe(verbose);
  });

  it("measures candidates but forwards the original Anthropic body in measure-only mode", async () => {
    fixture = await captureFixture("org_compress_measure_only");
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy(
      "org_compress_measure_only",
      compressionPolicy("measure_only")
    );

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        messages: [
          { role: "user", content: "list the open issues" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    const persistedEvents = await fixture.db.select().from(eventTable);
    const candidate = persistedEvents.find((event) => event.eventType === "compression.candidate_recorded");
    const measurement = persistedEvents.find((event) => event.eventType === "compression.measurement_recorded");
    const evidence = persistedEvents.find((event) => event.eventType === "routing.compression_evidence_recorded");
    const providerStarted = persistedEvents.find((event) => event.eventType === "provider.request_started");
    const providerForwarded = persistedEvents.find((event) => event.eventType === "provider.request_forwarded");
    const providerTerminal = persistedEvents.find((event) => event.eventType === "provider.response_completed");
    const persistedReceipts = await fixture.db.select().from(compressionReceipts);
    expect(providerCall?.body.messages[2].content[0].content).toBe(verbose);
    expect(persistedEvents.some((event) => event.eventType === "compression.recorded")).toBe(false);
    expect(candidate?.payload.record).toMatchObject({
      tool: "mcp__linear__list_issues",
      rule: "mcp-json-whitespace",
      ruleVersion: 1,
      blockPath: "messages.2.content.0",
      status: "candidate"
    });
    expect(measurement?.payload).toMatchObject({
      mode: "measure_only",
      blocks: 1,
      candidates: 1,
      skipped: 0
    });
    expect(evidence?.payload).toMatchObject({
      mode: "measure_only",
      evaluatedBlocks: 1,
      appliedBlocks: 0,
      candidateBlocks: 1,
      skippedBlocks: 0,
      receiptIds: [`${measurement?.id}:compression:0`],
      compressionEventId: measurement?.id,
      providerWouldReceiveCompressedToolOutput: false,
      forwardedToolOutputState: "original"
    });
    expect(evidence?.payload.originalRequestHash).toBe(evidence?.payload.compressedRequestHash);
    expect(providerStarted?.payload.preparedRequestHash).toBe(evidence?.payload.forwardedRequestHash);
    expect(providerForwarded?.payload).toMatchObject({
      preparedRequestHash: evidence?.payload.forwardedRequestHash,
      providerWouldReceiveCompressedToolOutput: false,
      providerToolOutputState: "original"
    });
    expect(providerTerminal?.payload).toMatchObject({
      providerRequestConfirmed: true,
      providerSawCompressedToolOutput: false,
      providerToolOutputState: "original"
    });
    expect(persistedReceipts).toHaveLength(1);
    expect(persistedReceipts[0]).toMatchObject({
      organizationId: "org_compress_measure_only",
      workspaceId: "org_compress_measure_only:workspace:default",
      mode: "measure_only",
      surface: "anthropic-messages",
      blockPath: "messages.2.content.0",
      toolName: "mcp__linear__list_issues",
      ruleId: "mcp-json-whitespace",
      ruleVersion: 1,
      status: "measured",
      originalBytes: byteLengthFor(verbose),
      compressedBytes: byteLengthFor(compactedVerbose),
      originalEstimatedTokens: estimatedTokens(verbose.length),
      compressedEstimatedTokens: estimatedTokens(compactedVerbose.length),
      savedEstimatedTokens: estimatedTokens(verbose.length) - estimatedTokens(compactedVerbose.length),
      estimateSource: ROUGH_COMPRESSION_TOKEN_ESTIMATE_SOURCE,
      originalSha256: contentHashFor(verbose),
      compressedSha256: contentHashFor(compactedVerbose),
      originalArtifactId: null,
      compressedArtifactId: null,
      skipReason: null,
      eventId: measurement?.id
    });
    expect(JSON.stringify(candidate?.payload)).not.toContain(verbose.slice(0, 50));
    expect(JSON.stringify(measurement?.payload)).not.toContain(verbose.slice(0, 50));
  });

  it("records shell command classifications for measure-only lossy candidates", async () => {
    fixture = await captureFixture("org_compress_shell_measure");
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy(
      "org_compress_shell_measure",
      compressionPolicy("measure_only")
    );
    const output = pytestOutput();

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        messages: [
          { role: "user", content: "run tests" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest -q" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: output }] }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    const persistedEvents = await fixture.db.select().from(eventTable);
    const measurement = persistedEvents.find((event) => event.eventType === "compression.measurement_recorded");
    const persistedReceipts = await fixture.db.select().from(compressionReceipts);

    expect(providerCall?.body.messages[2].content[0].content).toBe(output);
    expect(persistedReceipts).toHaveLength(1);
    expect(persistedReceipts[0]).toMatchObject({
      mode: "measure_only",
      toolName: "Bash",
      command: "pytest -q",
      commandClass: "test_output",
      ruleId: "shell-command-lossy-summary",
      status: "measured",
      originalSha256: contentHashFor(output),
      eventId: measurement?.id
    });
    expect(JSON.stringify(measurement?.payload)).not.toContain(output.slice(0, 50));
  });

  it("links raw compression artifacts when capture policy allows it", async () => {
    fixture = await captureFixture("org_compress_raw_artifacts");
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy(
      "org_compress_raw_artifacts",
      { ...compressionPolicy("measure_only"), storeOriginalArtifact: true, storeCompressedArtifact: true }
    );

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        messages: [
          { role: "user", content: "list the open issues" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
        ]
      })
    });

    const [receipt] = await fixture.db.select().from(compressionReceipts);
    expect(receipt).toMatchObject({
      status: "measured",
      originalSha256: contentHashFor(verbose),
      compressedSha256: contentHashFor(compactedVerbose),
      originalArtifactId: expect.any(String),
      compressedArtifactId: expect.any(String)
    });
    const rows = await fixture.db.select().from(promptArtifacts);
    const original = rows.find((row) => row.id === receipt.originalArtifactId);
    const compressed = rows.find((row) => row.id === receipt.compressedArtifactId);
    expect(original).toMatchObject({
      kind: "compression_original_tool_result",
      storageMode: "raw_text",
      rawText: verbose,
      metadata: expect.objectContaining({
        blockPath: "messages.2.content.0",
        ruleId: "mcp-json-whitespace",
        status: "candidate"
      })
    });
    expect(compressed).toMatchObject({
      kind: "compression_compressed_tool_result",
      storageMode: "raw_text",
      rawText: compactedVerbose,
      metadata: expect.objectContaining({
        blockPath: "messages.2.content.0",
        ruleId: "mcp-json-whitespace",
        status: "candidate"
      })
    });
  });

  it.each(["hash_only", "none"] as const)(
    "does not write compression artifacts when prompt capture mode is %s",
    async (promptCaptureMode) => {
      const organizationId = `org_compress_${promptCaptureMode}`;
      fixture = await captureFixture(organizationId, promptCaptureMode);
      await fixture.persistence.organizationSettings.setToolResultCompressionPolicy(
        organizationId,
        { ...compressionPolicy("measure_only"), storeOriginalArtifact: true, storeCompressedArtifact: true }
      );

      await fetch(`${fixture.proxyUrl}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-router-hard",
          max_tokens: 256,
          messages: [
            { role: "user", content: "list the open issues" },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
          ]
        })
      });

      const persistedReceipts = await fixture.db.select().from(compressionReceipts);
      expect(persistedReceipts).toHaveLength(1);
      expect(persistedReceipts[0]).toMatchObject({
        status: "measured",
        originalSha256: contentHashFor(verbose),
        compressedSha256: contentHashFor(compactedVerbose),
        originalArtifactId: null,
        compressedArtifactId: null
      });
    }
  );

  it("replaces repeated tool results in the forwarded Anthropic body when duplicate references are enabled", async () => {
    fixture = await captureFixture("org_compress_duplicate_http");
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy("org_compress_duplicate_http", compressionPolicy());
    await fixture.persistence.organizationSettings.setDuplicateToolResultReferences("org_compress_duplicate_http", true);
    const repeated = "same file contents\n".repeat(300);

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        messages: [
          { role: "user", content: "read the file twice" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: repeated }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.txt" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: repeated }] }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    const first = providerCall?.body.messages[2].content[0].content;
    const second = providerCall?.body.messages[4].content[0].content;
    expect(first).toBe(repeated);
    expect(second).toContain("duplicate tool result omitted");
    expect(second).toContain(`contentHash=sha256:${hashFor(repeated)}`);
    expect(second).toContain(`originalChars=${repeated.length}`);
    expect(second).not.toContain(repeated.slice(0, 40));
  });

  it("applies duplicate references to Anthropic token-count requests", async () => {
    fixture = await captureFixture("org_compress_duplicate_count");
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy("org_compress_duplicate_count", compressionPolicy());
    await fixture.persistence.organizationSettings.setDuplicateToolResultReferences("org_compress_duplicate_count", true);
    const repeated = "same file contents\n".repeat(300);

    await fetch(`${fixture.proxyUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        messages: [
          { role: "user", content: "read the file twice" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: repeated }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.txt" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: repeated }] }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages/count_tokens");
    const first = providerCall?.body.messages[2].content[0].content;
    const second = providerCall?.body.messages[4].content[0].content;
    expect(first).toBe(repeated);
    expect(second).toContain(`contentHash=sha256:${hashFor(repeated)}`);
    expect(second).not.toContain(repeated.slice(0, 40));
  });

  it("rewrites oversized function_call_output items on the WebSocket surface", async () => {
    fixture = await captureFixture("org_compress_ws");
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy("org_compress_ws", compressionPolicy());

    const ws = new WebSocket(fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: {
        authorization: "Bearer proxy-token",
        "openai-beta": "responses_websockets=2026-02-06",
        session_id: "compress-ws-session"
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({
      type: "response.create",
      model: "router-hard",
      input: [
        { type: "function_call", call_id: "c1", name: "mcp__linear__list_issues", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: verbose }
      ],
      tools: [{ type: "function", name: "mcp__linear__list_issues" }],
      stream: true
    }));
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => {
        const event = JSON.parse(String(data));
        if (event.type === "response.completed" || event.type === "response.incomplete") resolve();
      });
      ws.once("error", reject);
    });
    ws.close();

    const providerCall = fixture.openai.records.find(
      (rec) => rec.body.type === "response.create" && Array.isArray(rec.body.input)
    );
    const forwarded = providerCall?.body.input[1].output;
    const persistedEvents = await fixture.db.select().from(eventTable);
    const evidence = persistedEvents.find((event) => event.eventType === "routing.compression_evidence_recorded");
    const providerStarted = persistedEvents.find((event) => event.eventType === "provider.request_started");
    const providerForwarded = persistedEvents.find((event) => event.eventType === "provider.request_forwarded");
    const providerTerminal = persistedEvents.find((event) => event.eventType === "provider.response_completed");
    expect(typeof forwarded).toBe("string");
    expect(forwarded.length).toBeLessThan(verbose.length);
    expect(evidence?.payload).toMatchObject({
      mode: "compress_lossless",
      appliedBlocks: 1,
      providerWouldReceiveCompressedToolOutput: true,
      forwardedToolOutputState: "some_compressed"
    });
    expect(providerStarted?.payload).toMatchObject({
      transport: "websocket",
      preparedRequestHash: evidence?.payload.forwardedRequestHash
    });
    expect(providerForwarded?.payload).toMatchObject({
      transport: "websocket",
      preparedRequestHash: evidence?.payload.forwardedRequestHash,
      forwardedRequestHash: evidence?.payload.forwardedRequestHash,
      providerToolOutputState: "some_compressed"
    });
    expect(providerTerminal?.payload).toMatchObject({
      providerRequestConfirmed: true,
      providerSawCompressedToolOutput: true
    });
    expect(JSON.parse(forwarded)).toEqual(JSON.parse(verbose));
  });
});
