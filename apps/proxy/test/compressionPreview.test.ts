import { afterEach, describe, expect, it } from "vitest";

import { compressionReceipts } from "@proxy/db";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const previewQuery = `query CompressionPreview($input: CompressionPreviewInput!) {
  compressionPreview(input: $input) {
    source
    surface
    contentAvailable
    contentRedactionReason
    blocks
    savedTokens
    previewBlocks {
      blockPath
      toolName
      ruleId
      status
      skipReason
      originalBytes
      compressedBytes
      savedTokens
      originalSha256
      compressedSha256
      diffSegments {
        side
        text
      }
    }
  }
}`;

const verboseJson = JSON.stringify(
  { items: Array.from({ length: 120 }, (_, index) => ({ id: index, title: `issue ${index}`, note: null })) },
  null,
  2
);

describe("compressionPreview admin query", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it.each([
    ["anthropic-messages", anthropicBody()],
    ["openai-responses", openAIResponsesBody()],
    ["openai-chat", openAIChatBody()]
  ] as const)("previews compression for %s samples", async (surface, body) => {
    fixture = await captureFixture(`org_preview_${surface.replace(/[^a-z]/g, "_")}`);

    const result = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      previewQuery,
      { input: { surface, body, policy: { mode: "measure_only" } } }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.compressionPreview).toMatchObject({
      source: "sample",
      surface,
      contentAvailable: true,
      blocks: 1
    });
    expect(result.data?.compressionPreview.previewBlocks[0]).toMatchObject({
      toolName: "mcp__linear__list_issues",
      ruleId: "json-array-compaction",
      status: "candidate",
      skipReason: null
    });
    expect(result.data?.compressionPreview.previewBlocks[0].compressedBytes)
      .toBeLessThan(result.data?.compressionPreview.previewBlocks[0].originalBytes);
    expect(result.data?.compressionPreview.previewBlocks[0].diffSegments).toHaveLength(2);
    expect(result.data?.compressionPreview.previewBlocks[0].diffSegments[0].text).toContain("issue 0");
  });

  it("hides diff segments when prompt capture does not allow raw content", async () => {
    fixture = await captureFixture("org_preview_hash_only", "hash_only");

    const result = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      previewQuery,
      { input: { surface: "anthropic-messages", body: anthropicBody(), policy: { mode: "measure_only" } } }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.compressionPreview).toMatchObject({
      contentAvailable: false,
      contentRedactionReason: "prompt_capture_hash_only"
    });
    expect(result.data?.compressionPreview.previewBlocks[0]).toMatchObject({
      originalSha256: expect.stringMatching(/^sha256:/),
      compressedSha256: expect.stringMatching(/^sha256:/),
      diffSegments: []
    });
  });

  it("returns receipt-backed preview history for a request id", async () => {
    fixture = await captureFixture("org_preview_request");
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy(
      "org_preview_request",
      { mode: "measure_only", minOriginalBytes: 512, minSavingsTokens: 0 }
    );

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "fable",
        max_tokens: 256,
        messages: anthropicBody().messages
      })
    });

    const [receipt] = await fixture.db.select().from(compressionReceipts);
    const result = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      previewQuery,
      { input: { requestId: receipt.requestId } }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.compressionPreview).toMatchObject({
      source: "request",
      surface: "anthropic-messages",
      contentAvailable: false,
      contentRedactionReason: "request_preview_uses_receipts_only",
      blocks: 1
    });
    expect(result.data?.compressionPreview.previewBlocks[0]).toMatchObject({
      ruleId: "json-array-compaction",
      status: "measured",
      diffSegments: []
    });

    const prompts = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query {
        prompts {
          data {
            artifactId
            requestId
          }
        }
      }`
    );
    const artifactId = prompts.data?.prompts.data.find((prompt: { requestId: string }) => prompt.requestId === receipt.requestId)?.artifactId;
    expect(artifactId).toBeTruthy();
    const detail = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query PromptCompressionReceipts($artifactId: ID!) {
        prompt(artifactId: $artifactId) {
          compressionReceipts {
            ruleId
            status
            savedBytes
          }
        }
      }`,
      { artifactId }
    );
    expect(detail.errors).toBeUndefined();
    expect(detail.data?.prompt?.compressionReceipts).toEqual([
      expect.objectContaining({
        ruleId: "json-array-compaction",
        status: "measured",
        savedBytes: receipt.originalBytes - receipt.compressedBytes
      })
    ]);
  });
});

function anthropicBody() {
  return {
    messages: [
      { role: "user", content: "list issues" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verboseJson }] }
    ]
  };
}

function openAIResponsesBody() {
  return {
    input: [
      { type: "function_call", call_id: "c1", name: "mcp__linear__list_issues", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: verboseJson }
    ]
  };
}

function openAIChatBody() {
  return {
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "mcp__linear__list_issues", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "c1", content: verboseJson }
    ]
  };
}
