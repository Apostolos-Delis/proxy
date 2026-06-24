import { afterEach, describe, expect, it } from "vitest";

import { compressionReceipts, defaultWorkspaceId, organizations, requests, workspaces } from "@proxy/db";

import { aggregateCompressionSavings } from "../src/persistence/compressionSavings.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

function compressionPayload(overrides: Record<string, unknown> = {}) {
  return {
    surface: "anthropic-messages",
    beforeChars: 10_000,
    afterChars: 6_000,
    savedChars: 4_000,
    beforeEstimatedTokens: 2_500,
    afterEstimatedTokens: 1_500,
    savedEstimatedTokens: 1_000,
    estimateSource: "rough_chars_per_4",
    blocks: 2,
    byRule: [
      {
        tool: "Bash",
        rule: "json-whitespace",
        ruleVersion: 1,
        beforeChars: 6_000,
        afterChars: 4_000,
        beforeEstimatedTokens: 1_500,
        afterEstimatedTokens: 1_000,
        savedEstimatedTokens: 500,
        estimateSource: "rough_chars_per_4"
      },
      {
        tool: "mcp__linear__list",
        rule: "mcp-json-whitespace",
        ruleVersion: 1,
        beforeChars: 4_000,
        afterChars: 2_000,
        beforeEstimatedTokens: 1_000,
        afterEstimatedTokens: 500,
        savedEstimatedTokens: 500,
        estimateSource: "rough_chars_per_4"
      }
    ],
    ...overrides
  };
}

describe("aggregateCompressionSavings", () => {
  it("groups savings by rule version and tool", () => {
    const report = aggregateCompressionSavings([
      compressionPayload(),
      compressionPayload({
        byRule: [
          {
            tool: "Bash",
            rule: "json-whitespace",
            ruleVersion: 1,
            beforeChars: 2_000,
            afterChars: 1_000,
            beforeEstimatedTokens: 500,
            afterEstimatedTokens: 250,
            savedEstimatedTokens: 250,
            estimateSource: "rough_chars_per_4"
          }
        ]
      })
    ], false);

    expect(report.eventCount).toBe(2);
    expect(report.sampled).toBe(false);
    expect(report.blocks).toBe(3);
    expect(report.savedEstimatedTokens).toBe(1_250);
    expect(report.rows[0]).toMatchObject({
      tool: "Bash",
      rule: "json-whitespace",
      ruleVersion: 1,
      commandClass: "unknown",
      blocks: 2,
      savedEstimatedTokens: 750,
      estimateSource: "rough_chars_per_4"
    });
    expect(report.rows[1]).toMatchObject({
      tool: "mcp__linear__list",
      rule: "mcp-json-whitespace",
      savedEstimatedTokens: 500,
      estimateSource: "rough_chars_per_4"
    });
    expect(report.estimateSource).toBe("rough_chars_per_4");
  });

  it("ignores malformed payload entries without throwing", () => {
    const report = aggregateCompressionSavings([null, { byRule: "nope" }], true);
    expect(report.eventCount).toBe(2);
    expect(report.sampled).toBe(true);
    expect(report.rows).toEqual([]);
    expect(report.savedEstimatedTokens).toBe(0);
    expect(report.estimateSource).toBe("unknown");
  });
});

describe("compressionSavings admin query", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("aggregates org-scoped compression receipts", async () => {
    activeFixture = await captureFixture("org_compression_savings");
    const fixture = activeFixture;
    const at = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(organizations).values({
      id: "org_compression_savings_other",
      slug: "org-compression-savings-other",
      name: "Other Org"
    });
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_compression_savings_other"),
      organizationId: "org_compression_savings_other",
      slug: "default",
      name: "Default"
    });
    await fixture.db.insert(requests).values([
      requestRow("request_compress_1", "org_compression_savings", at),
      requestRow("request_compress_2", "org_compression_savings", at),
      requestRow("request_compress_3", "org_compression_savings_other", at)
    ]);
    await fixture.db.insert(compressionReceipts).values([
      compressionReceipt("receipt_1_bash", "org_compression_savings", "request_compress_1", "evt_compress_1", at, {
        toolName: "Bash",
        ruleId: "json-whitespace",
        commandClass: "test_output"
      }),
      compressionReceipt("receipt_1_mcp", "org_compression_savings", "request_compress_1", "evt_compress_1", at, {
        toolName: "mcp__linear__list",
        ruleId: "mcp-json-whitespace"
      }),
      compressionReceipt("receipt_2_bash", "org_compression_savings", "request_compress_2", "evt_compress_2", at, {
        toolName: "Bash",
        ruleId: "json-whitespace",
        commandClass: "test_output"
      }),
      compressionReceipt("receipt_2_mcp", "org_compression_savings", "request_compress_2", "evt_compress_2", at, {
        toolName: "mcp__linear__list",
        ruleId: "mcp-json-whitespace"
      }),
      compressionReceipt("receipt_measured", "org_compression_savings", "request_compress_2", "evt_measured", at, {
        mode: "measure_only",
        status: "measured",
        savedEstimatedTokens: 10_000
      }),
      compressionReceipt("receipt_skipped", "org_compression_savings", "request_compress_2", "evt_skipped", at, {
        status: "skipped",
        skipReason: "below_min_savings",
        savedEstimatedTokens: 10_000
      }),
      compressionReceipt("receipt_other", "org_compression_savings_other", "request_compress_3", "evt_compress_other", at, {
        toolName: "Bash",
        ruleId: "json-whitespace"
      })
    ]);

    const report = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { compressionSavings {
        eventCount
        sampled
        blocks
        savedEstimatedTokens
        estimateSource
        rows { tool rule ruleVersion commandClass blocks savedChars savedEstimatedTokens estimateSource }
      } }`
    )).data?.compressionSavings;

    expect(report.eventCount).toBe(2);
    expect(report.sampled).toBe(false);
    expect(report.blocks).toBe(4);
    expect(report.savedEstimatedTokens).toBe(2_000);
    expect(report.rows[0]).toMatchObject({
      tool: "Bash",
      rule: "json-whitespace",
      commandClass: "test_output",
      blocks: 2,
      savedEstimatedTokens: 1_000,
      estimateSource: "rough_chars_per_4"
    });
    expect(report.estimateSource).toBe("rough_chars_per_4");
  });

  it("exposes available compression rules to admins", async () => {
    activeFixture = await captureFixture("org_compression_rules");
    const fixture = activeFixture;

    const result = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query {
        compressionRules {
          id
          displayName
          version
          classification
          supportedSurfaces
          eligibleToolNames
          minOriginalBytes
          minSavingsTokens
          knownRisks
        }
      }`
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.compressionRules).toEqual([
      expect.objectContaining({
        id: "search-result-grouping",
        displayName: "Search result path grouping",
        classification: "lossy",
        supportedSurfaces: ["openai-responses", "anthropic-messages", "openai-chat"],
        eligibleToolNames: ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd", "Search", "Grep", "grep", "rg", "ripgrep", "mcp__github__search*", "mcp__gitlab__search*"],
        minOriginalBytes: 512,
        minSavingsTokens: 0,
        knownRisks: expect.arrayContaining(["Reformats path-prefixed search hits into grouped path blocks; measure-only until provider prompt impact is validated."])
      }),
      expect.objectContaining({
        id: "log-output-compaction",
        displayName: "Log output repeated-line compaction",
        classification: "lossy",
        supportedSurfaces: ["openai-responses", "anthropic-messages", "openai-chat"],
        eligibleToolNames: ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"],
        minOriginalBytes: 4096,
        minSavingsTokens: 0,
        knownRisks: expect.arrayContaining(["Collapses repeated low-signal log lines while preserving errors, warnings, tracebacks, exit lines, and tail output; measure-only until provider prompt impact is validated."])
      }),
      expect.objectContaining({
        id: "diff-compaction",
        displayName: "Unified diff hunk compaction",
        classification: "lossy",
        supportedSurfaces: ["openai-responses", "anthropic-messages", "openai-chat"],
        eligibleToolNames: ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"],
        minOriginalBytes: 4096,
        minSavingsTokens: 0,
        knownRisks: expect.arrayContaining(["Collapses unchanged or repeated hunk body lines while preserving file headers, hunk headers, added/deleted counts, and error signals; measure-only until provider prompt impact is validated."])
      }),
      expect.objectContaining({
        id: "json-array-compaction",
        displayName: "JSON object-array column compaction",
        classification: "lossy",
        supportedSurfaces: ["openai-responses", "anthropic-messages", "openai-chat"],
        eligibleToolNames: ["*"],
        minOriginalBytes: 512,
        minSavingsTokens: 0,
        knownRisks: expect.arrayContaining(["Re-encodes uniform object arrays into a columnar envelope; measure-only until provider prompt impact is validated."])
      }),
      expect.objectContaining({
        id: "mcp-json-whitespace",
        displayName: "MCP JSON whitespace compaction",
        classification: "lossless",
        supportedSurfaces: ["openai-responses", "anthropic-messages", "openai-chat"],
        eligibleToolNames: ["mcp__*"],
        minOriginalBytes: 512,
        minSavingsTokens: 0,
        knownRisks: []
      }),
      expect.objectContaining({ id: "json-whitespace", version: 1 }),
      expect.objectContaining({ id: "bash-output-noise", version: 1 }),
      expect.objectContaining({ id: "shell-command-lossy-summary", classification: "lossy" })
    ]);
  });
});

function requestRow(id: string, organizationId: string, createdAt: Date) {
  return {
    id,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    surface: "anthropic-messages",
    idempotencyKey: `idem_${id}`,
    requestedModel: "router-auto",
    inputHash: `sha256:${id}`,
    inputChars: 10_000,
    status: "completed" as const,
    createdAt
  };
}

function compressionReceipt(
  id: string,
  organizationId: string,
  requestId: string,
  eventId: string,
  createdAt: Date,
  overrides: Partial<typeof compressionReceipts.$inferInsert>
) {
  return {
    id,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    requestId,
    mode: "compress_lossless",
    surface: "anthropic-messages",
    blockPath: `${id}.block`,
    toolName: "Bash",
    ruleId: "json-whitespace",
    ruleVersion: 1,
    status: "applied",
    originalChars: 2_000,
    compressedChars: 1_000,
    savedChars: 1_000,
    originalBytes: 2_000,
    compressedBytes: 1_000,
    originalEstimatedTokens: 1_000,
    compressedEstimatedTokens: 500,
    savedEstimatedTokens: 500,
    estimateSource: "rough_chars_per_4",
    originalSha256: `sha256:original:${id}`,
    compressedSha256: `sha256:compressed:${id}`,
    eventId,
    createdAt,
    ...overrides
  };
}
