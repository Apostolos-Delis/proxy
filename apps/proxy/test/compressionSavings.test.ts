import { afterEach, describe, expect, it } from "vitest";

import { defaultWorkspaceId, events, organizations, workspaces } from "@prompt-proxy/db";

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
        savedEstimatedTokens: 500
      },
      {
        tool: "mcp__linear__list",
        rule: "mcp-json-whitespace",
        ruleVersion: 1,
        beforeChars: 4_000,
        afterChars: 2_000,
        beforeEstimatedTokens: 1_000,
        afterEstimatedTokens: 500,
        savedEstimatedTokens: 500
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
            savedEstimatedTokens: 250
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
      blocks: 2,
      savedEstimatedTokens: 750
    });
    expect(report.rows[1]).toMatchObject({
      tool: "mcp__linear__list",
      rule: "mcp-json-whitespace",
      savedEstimatedTokens: 500
    });
  });

  it("ignores malformed payload entries without throwing", () => {
    const report = aggregateCompressionSavings([null, { byRule: "nope" }], true);
    expect(report.eventCount).toBe(2);
    expect(report.sampled).toBe(true);
    expect(report.rows).toEqual([]);
    expect(report.savedEstimatedTokens).toBe(0);
  });
});

describe("compressionSavings admin query", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("aggregates org-scoped compression events", async () => {
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
    await fixture.db.insert(events).values([
      compressionEvent("evt_compress_1", "org_compression_savings", "request_compress_1", at),
      compressionEvent("evt_compress_2", "org_compression_savings", "request_compress_2", at),
      compressionEvent("evt_compress_other", "org_compression_savings_other", "request_compress_3", at)
    ]);

    const report = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { compressionSavings {
        eventCount
        sampled
        blocks
        savedEstimatedTokens
        rows { tool rule ruleVersion blocks savedChars savedEstimatedTokens }
      } }`
    )).data?.compressionSavings;

    expect(report.eventCount).toBe(2);
    expect(report.sampled).toBe(false);
    expect(report.blocks).toBe(4);
    expect(report.savedEstimatedTokens).toBe(2_000);
    expect(report.rows[0]).toMatchObject({
      tool: "Bash",
      rule: "json-whitespace",
      blocks: 2,
      savedEstimatedTokens: 1_000
    });
  });
});

function compressionEvent(id: string, organizationId: string, requestId: string, createdAt: Date) {
  return {
    id,
    sequence: 1,
    schemaVersion: 1,
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    scopeType: "request",
    scopeId: requestId,
    correlationId: requestId,
    actorType: "proxy",
    actorId: "prompt-proxy",
    producer: "prompt-proxy.compression",
    eventType: "compression.recorded",
    payloadHash: `sha256:${id}`,
    sensitivity: "internal",
    redactionState: "not_applicable",
    payload: compressionPayload(),
    metadata: {},
    createdAt
  };
}
