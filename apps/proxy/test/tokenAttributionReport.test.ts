import { afterEach, describe, expect, it } from "vitest";

import { defaultWorkspaceId, events, organizations, workspaces } from "@prompt-proxy/db";

import { aggregateTokenAttribution } from "../src/persistence/tokenAttributionReport.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

function attributionPayload(overrides: Record<string, unknown> = {}) {
  return {
    surface: "anthropic-messages",
    requestedModel: "claude-router-auto",
    systemPrompt: { chars: 1000, estimatedTokens: 250 },
    orgSystemPrompt: { chars: 40, estimatedTokens: 10 },
    toolSchemas: { chars: 2000, estimatedTokens: 500, count: 3 },
    history: { chars: 8000, estimatedTokens: 2000, messages: 4 },
    newToolResults: { chars: 4000, estimatedTokens: 1000, blocks: 2 },
    latestUser: { chars: 100, estimatedTokens: 25 },
    total: { chars: 15140, estimatedTokens: 3785 },
    sessionId: "session_attr",
    toolSchemasByName: [
      { name: "Bash", chars: 500, estimatedTokens: 125 },
      { name: "mcp__linear", chars: 1500, estimatedTokens: 375 }
    ],
    toolSchemaHashesByName: [
      { name: "Bash", schemaHash: "sha256:bash_v1", chars: 500, estimatedTokens: 125 },
      { name: "mcp__linear__list_issues", schemaHash: "sha256:linear_list_v1", chars: 1500, estimatedTokens: 375 }
    ],
    newToolResultsByTool: [
      { tool: "Bash", chars: 4000, estimatedTokens: 1000, blocks: 2 }
    ],
    ...overrides
  };
}

describe("aggregateTokenAttribution", () => {
  it("sums buckets and merges offenders across payloads", () => {
    const report = aggregateTokenAttribution(
      [
        attributionPayload(),
        attributionPayload({
          newToolResultsByTool: [
            { tool: "Bash", chars: 1000, estimatedTokens: 250, blocks: 1 },
            { tool: "mcp__linear", chars: 9000, estimatedTokens: 2250, blocks: 3 }
          ]
        })
      ],
      false
    );

    expect(report.requestCount).toBe(2);
    expect(report.sampled).toBe(false);
    const buckets = Object.fromEntries(report.buckets.map((bucket) => [bucket.key, bucket.chars]));
    expect(buckets).toEqual({
      systemPrompt: 2000,
      orgSystemPrompt: 80,
      toolSchemas: 4000,
      history: 16000,
      newToolResults: 8000,
      latestUser: 200
    });
    expect(report.toolSchemas[0]).toEqual({ name: "mcp__linear", chars: 3000, estimatedTokens: 750, blocks: null });
    expect(report.toolResults[0]).toEqual({ name: "mcp__linear", chars: 9000, estimatedTokens: 2250, blocks: 3 });
    expect(report.toolResults[1]).toEqual({ name: "Bash", chars: 5000, estimatedTokens: 1250, blocks: 3 });
    const bashChurn = report.schemaChurn.find((row) => row.name === "Bash");
    expect(bashChurn).toMatchObject({ schemaHashes: 1, requests: 2, sessions: 1, churningSessions: 0, status: "stable" });
  });

  it("ignores malformed payloads without throwing", () => {
    const report = aggregateTokenAttribution([null, "junk", { toolSchemasByName: "nope" }], true);
    expect(report.requestCount).toBe(3);
    expect(report.sampled).toBe(true);
    expect(report.buckets.every((bucket) => bucket.chars === 0)).toBe(true);
  });

  it("reports schema churn by tool name and session", () => {
    const report = aggregateTokenAttribution(
      [
        attributionPayload({
          sessionId: "session_1",
          toolSchemaHashesByName: [
            { name: "Bash", schemaHash: "sha256:bash_v1", chars: 500, estimatedTokens: 125 },
            { name: "Read", schemaHash: "sha256:read_v1", chars: 300, estimatedTokens: 75 }
          ]
        }),
        attributionPayload({
          sessionId: "session_1",
          toolSchemaHashesByName: [
            { name: "Bash", schemaHash: "sha256:bash_v2", chars: 520, estimatedTokens: 130 },
            { name: "Read", schemaHash: "sha256:read_v1", chars: 300, estimatedTokens: 75 }
          ]
        })
      ],
      false
    );

    expect(report.schemaChurn[0]).toMatchObject({
      name: "Bash",
      schemaHashes: 2,
      requests: 2,
      sessions: 1,
      churningSessions: 1,
      status: "churning",
      estimatedTokens: 255
    });
    const read = report.schemaChurn.find((row) => row.name === "Read");
    expect(read).toMatchObject({ schemaHashes: 1, requests: 2, sessions: 1, churningSessions: 0, status: "stable" });
  });
});

describe("tokenAttribution admin query", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("aggregates org-scoped tokens.attributed events", async () => {
    activeFixture = await captureFixture("org_token_attr");
    const fixture = activeFixture;
    const at = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(organizations).values({
      id: "org_token_attr_other",
      slug: "org-token-attr-other",
      name: "Other Org"
    });
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_token_attr_other"),
      organizationId: "org_token_attr_other",
      slug: "default",
      name: "Default"
    });
    await fixture.db.insert(events).values([
      attributionEvent("evt_attr_1", "org_token_attr", "request_attr_1", at),
      attributionEvent("evt_attr_2", "org_token_attr", "request_attr_2", at),
      attributionEvent("evt_attr_other", "org_token_attr_other", "request_attr_3", at)
    ]);

    const report = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query { tokenAttribution {
        requestCount
        sampled
        buckets { key chars estimatedTokens }
        toolSchemas { name chars }
        toolResults { name chars blocks }
        schemaChurn { name schemaHashes requests sessions churningSessions status }
      } }`
    )).data?.tokenAttribution;

    expect(report.requestCount).toBe(2);
    expect(report.sampled).toBe(false);
    const buckets = Object.fromEntries(report.buckets.map((bucket: any) => [bucket.key, bucket.chars]));
    expect(buckets.history).toBe(16000);
    expect(buckets.newToolResults).toBe(8000);
    expect(report.toolResults[0]).toEqual({ name: "Bash", chars: 8000, blocks: 4 });
    expect(report.schemaChurn.find((row: any) => row.name === "Bash")).toMatchObject({
      schemaHashes: 1,
      requests: 2,
      sessions: 1,
      churningSessions: 0,
      status: "stable"
    });
  });
});

function attributionEvent(id: string, organizationId: string, requestId: string, createdAt: Date) {
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
    producer: "prompt-proxy.attribution",
    eventType: "tokens.attributed",
    payloadHash: `sha256:${id}`,
    sensitivity: "internal",
    redactionState: "not_applicable",
    payload: attributionPayload(),
    metadata: {},
    createdAt
  };
}
